import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BookingService } from "@botamin/contracts";
import {
	BINARY_AUDIO_FRAME_KIND,
	ClientHelloEventSchema,
	ClientWsEventSchema,
	decodeBinaryAudioFrame,
	EntityIdSchema,
	encodeBinaryAudioFrame,
	type AudioClientConfig,
	type KnownFacts,
	type SafeErrorCode,
	type ServerWsEvent,
	ServerWsEventSchema,
} from "@botamin/contracts";
import type { ObservabilityMetrics } from "../observability";
import type {
	ConversationOrchestrator,
	OrchestratorEvent,
} from "../orchestrator/orchestrator";
import {
	PcmUtteranceAssembler,
	PcmUtteranceError,
	WAV_HEADER_BYTES,
} from "./wav";

export function createAudioClientConfig(
	maxUtteranceMs: number,
	maxAudioBytes: number,
): AudioClientConfig {
	const durationPcmBytes = Math.floor(maxUtteranceMs * 32);
	const audioPcmBytes = Math.max(0, maxAudioBytes - WAV_HEADER_BYTES);
	const boundedPcmBytes = Math.min(durationPcmBytes, audioPcmBytes);
	const maxPcmBytes = boundedPcmBytes - (boundedPcmBytes % 2);
	return {
		inputSampleRate: 16_000,
		inputEncoding: "pcm16le",
		chunkMs: 100,
		maxUtteranceMs,
		maxPcmBytes,
		outputContentType: "audio/mpeg",
		outputMode: "complete-phrase-segments",
	};
}

const CLIENT_CONFIG = Object.freeze(createAudioClientConfig(60_000, 2_000_000));

export interface GatewaySocket {
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export interface SessionPersistence {
	appendTurn(input: {
		id: string;
		conversationId: string;
		userText: string;
		assistantText: string;
		stateBefore: string;
		stateAfter: string;
		completedAt: string;
		interrupted?: boolean;
		brainModel?: string;
	}): void;
	setConversationActive(id: string, stage: string): void;
	updateConversationStage(id: string, stage: string): void;
	failConversation(id: string, errorCode: SafeErrorCode): void;
	stopConversation(id: string, status: "completed" | "disconnected"): void;
}

export interface GatewaySessionOptions {
	conversationId: string;
	expiresAt: Date;
	orchestrator: ConversationOrchestrator;
	bookings: BookingService;
	persistence: SessionPersistence;
	brainModel: string;
	maxUtteranceMs: number;
	maxAudioBytes: number;
	maxFrameBytes: number;
	maxJsonBytes: number;
	maxHistoryEvents: number;
	maxHistoryBytes: number;
	maxPendingMessages?: number;
	clientHelloTimeoutMs?: number;
	stopDrainMs?: number;
	onTerminalError?: () => void;
	acquireTurn(input: {
		priority: "booked" | "standard";
		signal: AbortSignal;
	}): Promise<
		| { ok: true; release(): void }
		| {
				ok: false;
				reason: "cancelled" | "closed" | "overflow" | "timeout";
		  }
	>;
	idFactory?: () => string;
	tokenFactory?: () => string;
	now?: () => Date;
	metrics?: ObservabilityMetrics;
}

type HistoryRecord =
	| { event: ServerWsEvent; json: string; bytes: number }
	| {
			event: Extract<ServerWsEvent, { type: "audio.segment" }>;
			json: string;
			binary: Uint8Array;
			bytes: number;
	  };

/** One bounded conversation transport/session, independently testable from Bun. */
export class GatewaySession {
	readonly conversationId: string;
	readonly expiresAt: Date;
	readonly #orchestrator: ConversationOrchestrator;
	readonly #bookings: BookingService;
	readonly #persistence: SessionPersistence;
	readonly #brainModel: string;
	readonly #maxJsonBytes: number;
	readonly #maxHistoryEvents: number;
	readonly #maxHistoryBytes: number;
	readonly #maxPendingMessages: number;
	readonly #clientHelloTimeoutMs: number;
	readonly #stopDrainMs: number;
	readonly #onTerminalError: () => void;
	readonly #acquireTurn: GatewaySessionOptions["acquireTurn"];
	readonly #idFactory: () => string;
	readonly #now: () => Date;
	readonly #metrics: ObservabilityMetrics | undefined;
	readonly #clientConfig: AudioClientConfig;
	readonly #assemblerLimits: {
		maxUtteranceMs: number;
		maxAudioBytes: number;
		maxFramePayloadBytes: number;
	};
	#assembler: PcmUtteranceAssembler | null = null;
	#expectedClientSequence = 0;
	#expectedTextSequence = 0;
	#activeTextSequence: number | null = null;
	#serverSequence = 0;
	#history: HistoryRecord[] = [];
	#historyBytes = 0;
	#activeSocket: GatewaySocket | null = null;
	#pendingSocket: GatewaySocket | null = null;
	#helloTimer: ReturnType<typeof setTimeout> | null = null;
	#helloAccepted = false;
	#initialClientToken: string | null;
	#resumeTokenHash: Uint8Array;
	#stopped = false;
	#stopPromise: Promise<void> | null = null;
	#currentGenerationId: string | null = null;
	#turnIntakePending = false;
	#messageQueue: Promise<void> = Promise.resolve();
	#pendingMessages = 0;
	readonly #activeProcesses = new Set<Promise<void>>();
	readonly #queuedTurnControllers = new Map<string, AbortController>();
	readonly #turnsById = new Map<
		string,
		{
			id: string;
			generationId: string;
			userText: string;
			assistantText: string;
			stateBefore: string;
			stateAfter: string;
		}
	>();
	readonly #turnIdsByGeneration = new Map<string, string>();
	readonly #persistedTurns = new Set<string>();

	constructor(options: GatewaySessionOptions) {
		this.conversationId = EntityIdSchema.parse(options.conversationId);
		this.expiresAt = options.expiresAt;
		this.#orchestrator = options.orchestrator;
		this.#bookings = options.bookings;
		this.#persistence = options.persistence;
		this.#brainModel = options.brainModel;
		this.#maxJsonBytes = options.maxJsonBytes;
		this.#maxHistoryEvents = options.maxHistoryEvents;
		this.#maxHistoryBytes = options.maxHistoryBytes;
		this.#maxPendingMessages = options.maxPendingMessages ?? 64;
		this.#clientHelloTimeoutMs = options.clientHelloTimeoutMs ?? 2_000;
		this.#stopDrainMs = options.stopDrainMs ?? 5_000;
		this.#onTerminalError = options.onTerminalError ?? (() => undefined);
		this.#acquireTurn = options.acquireTurn;
		this.#idFactory = options.idFactory ?? (() => Bun.randomUUIDv7());
		this.#now = options.now ?? (() => new Date());
		this.#metrics = options.metrics;
		const initialToken =
			options.tokenFactory?.() ?? randomBytes(32).toString("base64url");
		this.#initialClientToken = initialToken;
		this.#resumeTokenHash = createHash("sha256").update(initialToken).digest();
		this.#clientConfig = createAudioClientConfig(
			options.maxUtteranceMs,
			options.maxAudioBytes,
		);
		this.#assemblerLimits = {
			maxUtteranceMs: options.maxUtteranceMs,
			maxAudioBytes: options.maxAudioBytes,
			maxFramePayloadBytes: Math.min(3_200, options.maxFrameBytes - 9),
		};
		const started = this.#orchestrator.apply({ type: "start" });
		if (!started.ok) throw new Error("Conversation orchestrator did not start");
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	get processing(): boolean {
		return this.#activeProcesses.size > 0;
	}

	get established(): boolean {
		return this.#helloAccepted;
	}

	/** Returns the one-use first-hello bearer exactly once. */
	takeClientToken(): string {
		const token = this.#initialClientToken;
		if (!token)
			throw new Error("Initial client token has already been consumed");
		this.#initialClientToken = null;
		return token;
	}

	get historySize(): number {
		return this.#history.length;
	}

	attach(socket: GatewaySocket): void {
		if (this.#stopped || this.isExpired()) {
			socket.close(1008, "session unavailable");
			return;
		}
		if (socket === this.#activeSocket || socket === this.#pendingSocket) return;
		const previous = this.#pendingSocket;
		this.#clearPendingHello();
		previous?.close(1008, "new connection candidate");
		this.#pendingSocket = socket;
		this.#helloTimer = setTimeout(() => {
			if (this.#pendingSocket !== socket) return;
			this.#pendingSocket = null;
			this.#helloTimer = null;
			socket.close(1008, "client hello timeout");
		}, this.#clientHelloTimeoutMs);
		this.#helloTimer.unref?.();
	}

	receive(socket: GatewaySocket, data: unknown): Promise<void> {
		if (socket !== this.#activeSocket && socket !== this.#pendingSocket) {
			socket.close(1008, "socket is not attached");
			return Promise.resolve();
		}
		if (this.#pendingMessages >= this.#maxPendingMessages) {
			this.#closeWithError(socket, "CAPACITY_EXCEEDED", true);
			return Promise.resolve();
		}
		this.#pendingMessages += 1;
		const dispatched = this.#messageQueue.then(() =>
			this.#receiveOrdered(socket, data),
		);
		const settled = dispatched.finally(() => {
			this.#pendingMessages = Math.max(0, this.#pendingMessages - 1);
		});
		this.#messageQueue = settled.catch(() => undefined);
		return settled;
	}

	async drain(): Promise<void> {
		await this.#messageQueue;
		await Promise.allSettled([...this.#activeProcesses]);
	}

	async #receiveOrdered(socket: GatewaySocket, data: unknown): Promise<void> {
		if (this.#stopped || this.isExpired()) {
			this.#closeWithError(socket, "SESSION_EXPIRED", false);
			if (!this.#stopped) void this.stop("disconnected");
			return;
		}
		if (typeof data === "string") {
			if (new TextEncoder().encode(data).byteLength > this.#maxJsonBytes) {
				this.#closeWithError(socket, "INVALID_EVENT", false);
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(data);
			} catch {
				this.#closeWithError(socket, "INVALID_EVENT", false);
				return;
			}
			await this.#receiveJson(socket, value);
			return;
		}
		const bytes = asBytes(data);
		if (
			!bytes ||
			bytes.byteLength > this.#assemblerLimits.maxFramePayloadBytes + 9
		) {
			this.#closeWithError(socket, "INVALID_EVENT", false);
			return;
		}
		if (socket !== this.#activeSocket) {
			this.#closeWithError(socket, "INVALID_EVENT", false);
			return;
		}
		await this.#receiveBinary(bytes);
	}

	detach(socket: GatewaySocket): void {
		if (socket === this.#pendingSocket) {
			this.#clearPendingHello();
			return;
		}
		if (socket !== this.#activeSocket || this.#stopped) return;
		this.#activeSocket = null;
		this.#assembler?.clear();
		this.#assembler = null;
		this.#trackProcess(this.#orchestrator.disconnect());
		try {
			this.#persistence.stopConversation(this.conversationId, "disconnected");
		} catch {
			// The transport is already fenced; never expose persistence details.
		}
	}

	stop(reason: "completed" | "disconnected" = "completed"): Promise<void> {
		if (this.#stopPromise) return this.#stopPromise;
		this.#stopped = true;
		this.#assembler?.clear();
		this.#assembler = null;
		for (const controller of this.#queuedTurnControllers.values()) {
			controller.abort("session stopped");
		}
		this.#queuedTurnControllers.clear();
		const pendingSocket = this.#pendingSocket;
		this.#clearPendingHello();
		pendingSocket?.close(1000, "session stopped");
		this.#activeSocket?.close(1000, "session stopped");
		this.#activeSocket = null;
		const closeOrchestrator = this.#orchestrator.close(this.#stopDrainMs);
		this.#stopPromise = (async () => {
			await settleWithin(
				Promise.allSettled([closeOrchestrator, ...this.#activeProcesses]),
				this.#stopDrainMs,
			);
			try {
				this.#persistence.stopConversation(this.conversationId, reason);
			} catch {
				// Lifecycle status is best effort after the cancellation barrier.
			}
			this.#history = [];
			this.#historyBytes = 0;
			this.#turnsById.clear();
			this.#turnIdsByGeneration.clear();
			this.#persistedTurns.clear();
			this.#initialClientToken = null;
			this.#resumeTokenHash.fill(0);
		})();
		return this.#stopPromise;
	}

	isExpired(at = this.#now()): boolean {
		return at.getTime() >= this.expiresAt.getTime();
	}

	async #receiveJson(socket: GatewaySocket, value: unknown): Promise<void> {
		if (this.#activeSocket !== socket) {
			if (this.#pendingSocket !== socket) {
				this.#closeWithError(socket, "INVALID_EVENT", false);
				return;
			}
			const hello = ClientHelloEventSchema.safeParse(value);
			if (!hello.success || hello.data.conversationId !== this.conversationId) {
				this.#closeWithError(socket, "INVALID_EVENT", false);
				return;
			}
			if (!this.#acceptResumeToken(hello.data.payload.resumeToken)) {
				this.#closeWithError(socket, "SESSION_EXPIRED", false);
				return;
			}
			const previous = this.#activeSocket;
			this.#clearPendingHello();
			this.#activeSocket = socket;
			if (previous && previous !== socket) {
				previous.close(1000, "session resumed elsewhere");
			}
			if (this.#orchestrator.state.stage === "DISCONNECTED") {
				this.#orchestrator.apply({ type: "reconnect" });
			} else if (this.#orchestrator.state.stage === "CONNECTING") {
				this.#orchestrator.apply({ type: "connected" });
			}
			this.#persistence.setConversationActive(
				this.conversationId,
				this.#orchestrator.state.stage,
			);
			for (const record of this.#history) this.#sendRecord(socket, record);
			const token = this.#rotateResumeToken();
			this.#sendEvent(
				"session.ready",
				{
					state: this.#orchestrator.state.stage,
					resumeToken: token,
					clientConfig: this.#clientConfig,
				},
				false,
			);
			return;
		}

		const parsed = ClientWsEventSchema.safeParse(value);
		if (!parsed.success || parsed.data.conversationId !== this.conversationId) {
			this.#closeWithError(socket, "INVALID_EVENT", false);
			return;
		}
		switch (parsed.data.type) {
			case "client.hello":
				// Duplicate hello on an already-bound socket is a protocol error.
				this.#closeWithError(socket, "INVALID_EVENT", false);
				break;
			case "audio.commit":
				this.#trackProcess(this.#commitAudio());
				break;
			case "visitor.text.submit":
				this.#trackProcess(
					this.#commitText(
						parsed.data.payload.sequence,
						parsed.data.payload.text,
					),
				);
				break;
			case "playback.interrupted": {
				const event = await this.#orchestrator.interrupt(
					parsed.data.payload.generationId,
				);
				if (event.type === "assistant.interrupted") this.#mapEvent(event);
				break;
			}
			case "playback.started":
				break;
			case "client.ping":
				this.#sendEvent("server.pong", {
					clientSentAt: parsed.data.payload.sentAt,
				});
				break;
			case "session.stop":
				await this.stop("completed");
				break;
		}
	}

	async #receiveBinary(raw: Uint8Array): Promise<void> {
		let frame: ReturnType<typeof decodeBinaryAudioFrame>;
		try {
			frame = decodeBinaryAudioFrame(raw);
		} catch {
			this.#closeWithError(this.#activeSocket, "INVALID_EVENT", false);
			return;
		}
		if (
			frame.kind !== BINARY_AUDIO_FRAME_KIND.clientPcm16 ||
			frame.sequence !== this.#expectedClientSequence
		) {
			this.#closeWithError(this.#activeSocket, "INVALID_EVENT", false);
			return;
		}
		this.#expectedClientSequence += 1;
		if (!this.#assembler) {
			if (this.processing && this.#currentGenerationId) {
				const interrupted = await this.#orchestrator.interrupt(
					this.#currentGenerationId,
				);
				if (interrupted.type === "assistant.interrupted") {
					this.#mapEvent(interrupted);
				}
			}
			this.#assembler = new PcmUtteranceAssembler(this.#assemblerLimits);
		}
		try {
			this.#assembler.append(frame.payload);
		} catch (error) {
			this.#assembler = null;
			this.#sendSafeError(
				error instanceof PcmUtteranceError &&
					error.code === "UTTERANCE_TOO_LARGE"
					? "STT_UNAVAILABLE"
					: "INVALID_EVENT",
				false,
			);
		}
	}

	async #commitAudio(): Promise<void> {
		const assembler = this.#assembler;
		if (!assembler?.hasAudio || assembler.committed) return;
		let wav: Uint8Array;
		try {
			wav = assembler.commit();
		} catch {
			this.#assembler = null;
			this.#sendSafeError("INVALID_EVENT", false);
			return;
		}
		this.#assembler = null;
		const turnId = this.#idFactory();
		this.#metrics?.markAudioCommit(turnId);
		this.#turnIntakePending = true;
		try {
			await this.#processFinalTurn({
				turnId,
				run: (generationId, knownFacts) =>
					this.#orchestrator.acceptAudioCommit({
						turnId,
						generationId,
						audio: wav,
						contentType: "audio/wav",
						language: "ru",
						knownFacts,
					}),
			});
		} finally {
			this.#turnIntakePending = false;
		}
	}

	async #commitText(sequence: number, text: string): Promise<void> {
		if (
			sequence < this.#expectedTextSequence ||
			sequence === this.#activeTextSequence
		) {
			this.#sendSafeError("IDEMPOTENCY_CONFLICT", false);
			return;
		}
		if (sequence !== this.#expectedTextSequence) {
			this.#sendSafeError("INVALID_EVENT", false);
			return;
		}
		if (
			this.#currentGenerationId !== null ||
			this.#turnIntakePending ||
			this.#activeTextSequence !== null ||
			!this.#orchestrator.canAcceptVisitorTurn
		) {
			this.#sendSafeError("ACTION_NOT_ALLOWED_IN_STATE", true);
			return;
		}

		// Typed input intentionally supersedes uncommitted microphone bytes.
		this.#assembler?.clear();
		this.#assembler = null;
		this.#activeTextSequence = sequence;
		this.#turnIntakePending = true;
		const turnId = this.#idFactory();
		try {
			await this.#processFinalTurn({
				turnId,
				requireFinal: true,
				onFinalAccepted: () => {
					this.#expectedTextSequence += 1;
				},
				run: (generationId, knownFacts) =>
					this.#orchestrator.acceptTextSubmit({
						turnId,
						generationId,
						text,
						knownFacts,
					}),
			});
		} finally {
			this.#activeTextSequence = null;
			this.#turnIntakePending = false;
		}
	}

	async #processFinalTurn(input: {
		turnId: string;
		requireFinal?: boolean;
		onFinalAccepted?: () => void;
		run(
			generationId: string,
			knownFacts: KnownFacts,
		): AsyncIterable<OrchestratorEvent>;
	}): Promise<boolean> {
		const queueController = new AbortController();
		this.#queuedTurnControllers.set(input.turnId, queueController);
		let admission: Awaited<ReturnType<GatewaySessionOptions["acquireTurn"]>>;
		try {
			admission = await this.#acquireTurn({
				priority: this.#orchestrator.state.booking ? "booked" : "standard",
				signal: queueController.signal,
			});
		} catch {
			this.#metrics?.finishCorrelation(input.turnId);
			if (!this.#stopped) this.#sendSafeError("CAPACITY_EXCEEDED", true);
			return false;
		} finally {
			this.#queuedTurnControllers.delete(input.turnId);
		}
		if (!admission.ok) {
			this.#metrics?.finishCorrelation(input.turnId);
			if (!this.#stopped) {
				this.#sendSafeError(
					admission.reason === "cancelled"
						? "ACTION_NOT_ALLOWED_IN_STATE"
						: "CAPACITY_EXCEEDED",
					true,
				);
			}
			return false;
		}
		const release = admission.release;
		if (this.#stopped) {
			release();
			this.#metrics?.finishCorrelation(input.turnId);
			return false;
		}
		if (this.isExpired()) {
			release();
			this.#metrics?.finishCorrelation(input.turnId);
			this.#sendSafeError("SESSION_EXPIRED", false);
			void this.stop("disconnected");
			return false;
		}
		const generationId = this.#idFactory();
		this.#currentGenerationId = generationId;
		this.#turnsById.set(input.turnId, {
			id: input.turnId,
			generationId,
			userText: "",
			assistantText: "",
			stateBefore: this.#orchestrator.state.stage,
			stateAfter: this.#orchestrator.state.stage,
		});
		this.#turnIdsByGeneration.set(generationId, input.turnId);
		try {
			const knownFacts: KnownFacts = {
				useCases: [],
				painPoints: [],
				objections: [],
			};
			let finalAccepted = false;
			for await (const event of input.run(generationId, knownFacts)) {
				if (this.#stopped) break;
				if (event.type === "transcript.final" && !finalAccepted) {
					finalAccepted = true;
					input.onFinalAccepted?.();
				}
				await this.#mapEvent(event);
			}
			if (input.requireFinal && !finalAccepted && !this.#stopped) {
				this.#sendSafeError("ACTION_NOT_ALLOWED_IN_STATE", true);
			}
		} finally {
			try {
				if (this.#currentGenerationId === generationId) {
					const turn = this.#turnsById.get(input.turnId);
					if (turn) turn.stateAfter = this.#orchestrator.state.stage;
					this.#currentGenerationId = null;
				}
				if (!this.#stopped) {
					try {
						this.#persistTurn(input.turnId);
					} catch {
						this.#sendSafeError("DB_UNAVAILABLE", true);
						this.#discardTurn(input.turnId);
					}
				} else {
					this.#discardTurn(input.turnId);
				}
			} finally {
				release();
				this.#metrics?.finishCorrelation(input.turnId);
			}
		}
		return true;
	}

	async #mapEvent(event: OrchestratorEvent): Promise<void> {
		if (this.#stopped) return;
		switch (event.type) {
			case "transcript.final": {
				const turn = this.#turnsById.get(event.turnId);
				if (turn) turn.userText = event.text;
				this.#sendEvent("transcript.final", {
					turnId: event.turnId,
					text: event.text,
				});
				break;
			}
			case "state.changed": {
				const turnId = this.#turnIdsByGeneration.get(event.generationId);
				const turn = turnId ? this.#turnsById.get(turnId) : undefined;
				if (turn) turn.stateAfter = event.to;
				try {
					if (event.to === "ERROR") {
						this.#persistence.failConversation(
							this.conversationId,
							event.errorCode ?? "BRAIN_PROTOCOL_ERROR",
						);
					} else {
						this.#persistence.updateConversationStage(
							this.conversationId,
							event.to,
						);
					}
				} catch {
					this.#sendSafeError("DB_UNAVAILABLE", true);
				}
				this.#sendEvent("state.changed", {
					from: event.from,
					to: event.to,
					reason: event.reason,
				});
				if (event.to === "ERROR") this.#onTerminalError();
				break;
			}
			case "booking.committed": {
				const booking = await this.#bookings.findByConversationId(
					this.conversationId,
				);
				if (!this.#stopped && booking?.id === event.bookingId) {
					this.#sendEvent("booking.created", {
						bookingId: booking.id,
						status: "booked",
						qualificationStatus: "none",
						createdAt: booking.createdAt,
					});
				}
				break;
			}
			case "booking.updated": {
				const booking = await this.#bookings.findByConversationId(
					this.conversationId,
				);
				if (!this.#stopped && booking?.id === event.bookingId) {
					this.#sendEvent("booking.updated", {
						bookingId: booking.id,
						qualificationStatus: event.qualificationStatus,
						updatedFields: event.updatedFields,
						updatedAt: booking.updatedAt,
					});
				}
				break;
			}
			case "text.delta":
				this.#sendEvent("assistant.text.delta", {
					generationId: event.generationId,
					text: event.text,
				});
				break;
			case "text.done": {
				const turnId = this.#turnIdsByGeneration.get(event.generationId);
				const turn = turnId ? this.#turnsById.get(turnId) : undefined;
				if (turn) turn.assistantText = event.text;
				this.#sendEvent("assistant.text.done", {
					generationId: event.generationId,
					fullText: event.text,
				});
				break;
			}
			case "audio.segment":
				this.#publishAudioSegment(event);
				break;
			case "audio.done":
				this.#sendEvent("assistant.audio.done", {
					generationId: event.generationId,
				});
				break;
			case "assistant.interrupted":
				this.#sendEvent("assistant.interrupted", {
					generationId: event.generationId,
				});
				break;
			case "degraded":
				this.#sendSafeError(event.code, event.code !== "TTS_UNAVAILABLE");
				break;
			case "tool.result":
			case "ignored":
				break;
		}
	}

	#publishAudioSegment(
		event: Extract<OrchestratorEvent, { type: "audio.segment" }>,
	): void {
		if (this.#stopped) return;
		const metadata = this.#createEvent("audio.segment", {
			generationId: event.generationId,
			segmentId: event.segmentId,
			sequence: event.sequence,
			contentType: "audio/mpeg",
			byteLength: event.bytes.byteLength,
			final: true,
		});
		if (metadata.type !== "audio.segment") return;
		const json = JSON.stringify(metadata);
		const binary = encodeBinaryAudioFrame({
			kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
			sequence: event.sequence,
			payload: event.bytes,
		});
		const record: HistoryRecord = {
			event: metadata,
			json,
			binary,
			bytes: new TextEncoder().encode(json).byteLength + binary.byteLength,
		};
		this.#remember(record);
		if (this.#activeSocket) this.#sendRecord(this.#activeSocket, record);
	}

	#sendSafeError(code: SafeErrorCode, retryable: boolean): void {
		this.#sendEvent("error", {
			code,
			message: safeMessage(code),
			retryable,
		});
	}

	#closeWithError(
		socket: GatewaySocket | null,
		code: SafeErrorCode,
		retryable: boolean,
	): void {
		const wasActive = socket !== null && socket === this.#activeSocket;
		const wasPending = socket !== null && socket === this.#pendingSocket;
		if (wasActive) this.#sendSafeError(code, retryable);
		if (wasPending) this.#clearPendingHello();
		socket?.close(1008, "protocol policy");
		if (wasActive) {
			this.#activeSocket = null;
			this.#assembler?.clear();
			this.#assembler = null;
			this.#trackProcess(this.#orchestrator.disconnect());
			try {
				this.#persistence.stopConversation(this.conversationId, "disconnected");
			} catch {
				// The protocol connection is already closed safely.
			}
		}
	}

	#sendEvent(
		type: ServerWsEvent["type"],
		payload: unknown,
		retain = true,
	): void {
		if (this.#stopped) return;
		const event = this.#createEvent(type, payload);
		const json = JSON.stringify(event);
		const record: HistoryRecord = {
			event,
			json,
			bytes: new TextEncoder().encode(json).byteLength,
		};
		if (retain) this.#remember(record);
		if (this.#activeSocket) this.#sendRecord(this.#activeSocket, record);
	}

	#createEvent(type: ServerWsEvent["type"], payload: unknown): ServerWsEvent {
		this.#serverSequence += 1;
		return ServerWsEventSchema.parse({
			v: 1,
			type,
			conversationId: this.conversationId,
			seq: this.#serverSequence,
			at: this.#now().toISOString(),
			payload,
		});
	}

	#remember(record: HistoryRecord): void {
		if (record.bytes > this.#maxHistoryBytes) return;
		this.#history.push(record);
		this.#historyBytes += record.bytes;
		while (
			this.#history.length > this.#maxHistoryEvents ||
			this.#historyBytes > this.#maxHistoryBytes
		) {
			const removed = this.#history.shift();
			if (!removed) break;
			this.#historyBytes -= removed.bytes;
		}
	}

	#sendRecord(socket: GatewaySocket, record: HistoryRecord): void {
		try {
			socket.send(record.json);
			if ("binary" in record) socket.send(record.binary);
		} catch {
			if (socket === this.#activeSocket) this.#activeSocket = null;
		}
	}

	#clearPendingHello(): void {
		if (this.#helloTimer) clearTimeout(this.#helloTimer);
		this.#helloTimer = null;
		this.#pendingSocket = null;
	}

	#acceptResumeToken(token: string | null): boolean {
		if (!token) return false;
		const candidate = createHash("sha256").update(token).digest();
		const accepted =
			candidate.byteLength === this.#resumeTokenHash.byteLength &&
			timingSafeEqual(candidate, this.#resumeTokenHash);
		if (accepted && !this.#helloAccepted) this.#helloAccepted = true;
		return accepted;
	}

	#rotateResumeToken(): string {
		const token = randomBytes(32).toString("base64url");
		this.#resumeTokenHash = createHash("sha256").update(token).digest();
		return token;
	}

	#trackProcess(process: Promise<void>): void {
		this.#activeProcesses.add(process);
		void process
			.catch(() => undefined)
			.finally(() => this.#activeProcesses.delete(process));
	}

	#persistTurn(turnId: string): void {
		const turn = this.#turnsById.get(turnId);
		if (!turn?.userText || this.#persistedTurns.has(turn.id)) {
			this.#discardTurn(turnId);
			return;
		}
		this.#persistence.appendTurn({
			id: turn.id,
			conversationId: this.conversationId,
			userText: turn.userText,
			assistantText: turn.assistantText,
			stateBefore: turn.stateBefore,
			stateAfter: turn.stateAfter,
			completedAt: this.#now().toISOString(),
			brainModel: this.#brainModel,
		});
		// Mark only after the durable write succeeds.
		this.#persistedTurns.add(turn.id);
		while (this.#persistedTurns.size > 256) {
			const oldest = this.#persistedTurns.values().next().value;
			if (!oldest) break;
			this.#persistedTurns.delete(oldest);
		}
		this.#discardTurn(turnId);
	}

	#discardTurn(turnId: string): void {
		const turn = this.#turnsById.get(turnId);
		this.#turnsById.delete(turnId);
		if (turn) this.#turnIdsByGeneration.delete(turn.generationId);
	}
}

async function settleWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.then(() => undefined),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function asBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return null;
}

function safeMessage(code: SafeErrorCode): string {
	switch (code) {
		case "SESSION_EXPIRED":
			return "Сессия завершена. Начните новый разговор.";
		case "CAPACITY_EXCEEDED":
			return "Сервис временно занят. Попробуйте позже.";
		case "STT_UNAVAILABLE":
			return "Речь сейчас не распознаётся. Повторите реплику.";
		case "TTS_UNAVAILABLE":
			return "Звук ответа недоступен; текст ответа сохранён.";
		case "BRAIN_NOT_READY":
		case "BRAIN_AUTH_REQUIRED":
		case "BRAIN_RATE_LIMITED":
		case "BRAIN_PROTOCOL_ERROR":
			return "Разговор сейчас недоступен. Попробуйте позже.";
		default:
			return "Запрос не удалось обработать безопасно.";
	}
}

export { CLIENT_CONFIG };
