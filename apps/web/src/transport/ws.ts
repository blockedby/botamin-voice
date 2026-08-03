import {
	type AudioSegmentMetadata,
	type BookingConflictResolution,
	type BookingFormDetails,
	type BookingRevisionConfirmation,
	type ClientWsEvent,
	ClientWsEventSchema,
	CONTRACT_VERSION,
	type LocalReactionCapability,
	PLAYBACK_FLOW_MAX_BYTES,
	PLAYBACK_FLOW_MAX_SEGMENT_BYTES,
	PLAYBACK_FLOW_MAX_SEGMENTS,
	type ServerWsEvent,
	ServerWsEventSchema,
	VOICE_WS_PROTOCOL_QUERY_PARAM,
	VOICE_WS_PROTOCOL_V2_QUERY_VALUE,
	VOICE_WS_PROTOCOL_VERSION,
} from "@botamin/contracts";
import { CANONICAL_FRAME_BYTES } from "../audio/pcm";
import { decodeAndPairServerSegment, encodeClientPcmFrame } from "./binary";

const WEB_SOCKET_OPEN = 1;

type AudioSegmentEvent = Extract<ServerWsEvent, { type: "audio.segment" }>;

interface PendingServerSegment {
	event: AudioSegmentEvent;
	suppressDelivery: boolean;
}

export interface WebSocketLike {
	readonly readyState: number;
	binaryType?: BinaryType;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ReconnectScheduler {
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export type VoiceTransportStatus =
	| "connecting"
	| "ready"
	| "reconnecting"
	| "closed"
	| "error";

export type PendingBookingCommand = Extract<
	ClientWsEvent,
	{
		type:
			| "booking.form.submit"
			| "booking.draft.confirm"
			| "booking.conflict.resolve";
	}
>;

export type BookingReplayResult =
	| "replayed"
	| "already-sent"
	| "unavailable"
	| "no-pending";

interface PendingBookingCommandState {
	readonly event: PendingBookingCommand;
	lastSentConnectionEpoch: number;
}

export interface VoiceTransportOptions {
	conversationId: string;
	url: string;
	resumeToken?: string | null;
	createWebSocket: WebSocketFactory;
	scheduler?: ReconnectScheduler;
	now?: () => Date;
	reconnect?: {
		initialDelayMs?: number;
		maxDelayMs?: number;
		maxAttempts?: number;
	};
	localReactions?: LocalReactionCapability;
	onEvent?(event: ServerWsEvent): void;
	onAudioMetadata?(metadata: AudioSegmentMetadata): void;
	onAudio?(metadata: AudioSegmentMetadata, bytes: Uint8Array): void;
	onStatus?(status: VoiceTransportStatus): void;
	onProtocolError?(error: Error): void;
	onBookingRequestCancelled?(
		requestId: string,
		reason: "reconnect_exhausted" | "reconnect_disabled",
	): void;
}

const browserScheduler: ReconnectScheduler = {
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Validated WS handshake, canonical binary framing, resume, and reconnect. */
export class VoiceTransport {
	private socket: WebSocketLike | null = null;
	private resumeToken: string | null;
	private clientSequence = 0;
	private textSequence = 0;
	private textSubmissionPending = false;
	private pendingBookingCommand: PendingBookingCommandState | null = null;
	private lastServerSequence = 0;
	private pendingSegment: PendingServerSegment | null = null;
	private readonly incompleteAudioSequences = new Set<number>();
	private reconnectHandle: unknown = null;
	private reconnectAttempt = 0;
	private connectionEpoch = 0;
	private stopped = false;
	private reconnectDisabled = false;
	private terminalFallbackOnly = false;
	private outboundDisabled = false;
	private sessionReady = false;
	private protocolMode: "awaiting" | "negotiating" | "v2" | "legacy";
	private readonly requestsProtocolV2: boolean;
	private utteranceHasAudio = false;
	private utteranceCommitted = false;
	private utteranceNeedsRestart = false;
	private muted = false;
	private readonly scheduler: ReconnectScheduler;

	constructor(private readonly options: VoiceTransportOptions) {
		this.resumeToken = options.resumeToken ?? null;
		this.scheduler = options.scheduler ?? browserScheduler;
		this.requestsProtocolV2 = requestsVoiceProtocolV2(options.url);
		this.protocolMode = this.requestsProtocolV2 ? "awaiting" : "legacy";
	}

	connect(): boolean {
		if (this.stopped || this.reconnectDisabled) return false;
		this.cancelReconnect();
		this.sessionReady = false;
		this.protocolMode = this.requestsProtocolV2 ? "awaiting" : "legacy";
		this.options.onStatus?.(
			this.reconnectAttempt === 0 ? "connecting" : "reconnecting",
		);
		const epoch = ++this.connectionEpoch;
		let socket: WebSocketLike;
		try {
			socket = this.options.createWebSocket(this.options.url);
		} catch (error) {
			this.reportProtocolError(toError(error, "WebSocket creation failed"));
			this.scheduleReconnect();
			return false;
		}
		this.socket = socket;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.sendHello();
		};
		socket.onmessage = (event) => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.receive(event.data);
		};
		socket.onerror = () => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.options.onStatus?.("error");
		};
		socket.onclose = () => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.socket = null;
			this.sessionReady = false;
			// Keep the incomplete sequence uncheckpointed so its replay can pair.
			this.pendingSegment = null;
			if (this.utteranceHasAudio && !this.utteranceCommitted) {
				this.utteranceHasAudio = false;
				this.utteranceNeedsRestart = true;
			}
			if (this.stopped || this.reconnectDisabled) {
				this.options.onStatus?.("closed");
				return;
			}
			this.scheduleReconnect();
		};
		return true;
	}

	/** Begin a fresh local utterance after the prior final transcript. */
	beginUtterance(): boolean {
		if (this.utteranceCommitted || this.pendingBookingCommand !== null)
			return false;
		this.utteranceHasAudio = false;
		this.utteranceNeedsRestart = false;
		return true;
	}

	sendPcmFrame(pcm16: Uint8Array): boolean {
		if (
			!this.canSend() ||
			this.muted ||
			this.utteranceCommitted ||
			this.pendingBookingCommand !== null ||
			this.utteranceNeedsRestart ||
			!(pcm16 instanceof Uint8Array) ||
			pcm16.byteLength === 0 ||
			pcm16.byteLength > CANONICAL_FRAME_BYTES ||
			pcm16.byteLength % 2 !== 0
		) {
			return false;
		}
		try {
			this.socket?.send(encodeClientPcmFrame(this.clientSequence, pcm16));
			this.clientSequence += 1;
			this.utteranceHasAudio = true;
			return true;
		} catch (error) {
			this.reportProtocolError(toError(error, "PCM frame send failed"));
			return false;
		}
	}

	/** One commit is accepted only for a ready, non-empty open utterance. */
	commit(): boolean {
		if (
			!this.canSend() ||
			!this.utteranceHasAudio ||
			this.utteranceCommitted ||
			this.textSubmissionPending ||
			this.pendingBookingCommand !== null
		) {
			return false;
		}
		if (!this.sendClientEvent("audio.commit", {})) return false;
		this.utteranceCommitted = true;
		return true;
	}

	/** Submit one final typed turn; the server remains the only booking authority. */
	submitText(text: string): boolean {
		if (
			!this.canSend() ||
			this.utteranceCommitted ||
			this.textSubmissionPending ||
			this.pendingBookingCommand !== null
		) {
			return false;
		}
		if (
			!this.sendClientEvent("visitor.text.submit", {
				sequence: this.textSequence,
				text,
			})
		) {
			return false;
		}
		this.textSubmissionPending = true;
		this.utteranceHasAudio = false;
		this.utteranceNeedsRestart = false;
		return true;
	}

	submitBookingForm(payload: BookingFormDetails): boolean {
		return this.sendBookingCommand("booking.form.submit", payload);
	}

	confirmBookingRevision(payload: BookingRevisionConfirmation): boolean {
		return this.sendBookingCommand("booking.draft.confirm", payload);
	}

	resolveBookingConflict(payload: BookingConflictResolution): boolean {
		return this.sendBookingCommand("booking.conflict.resolve", payload);
	}

	playbackStarted(generationId: string): boolean {
		return this.sendClientEvent("playback.started", { generationId });
	}

	playbackSegmentReleased(segment: AudioSegmentMetadata): boolean {
		if (this.protocolMode !== "v2") return false;
		return this.sendClientEvent("playback.segment.released", {
			generationId: segment.generationId,
			segmentId: segment.segmentId,
			sequence: segment.sequence,
			byteLength: segment.byteLength,
		});
	}

	interrupt(
		generationId: string,
		reason: "barge_in" | "user_stop" | "new_generation" | "playback_error",
	): boolean {
		return this.sendClientEvent("playback.interrupted", {
			generationId,
			reason,
		});
	}

	ping(): boolean {
		return this.sendClientEvent("client.ping", {
			sentAt: this.nowIso(),
		});
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
	}

	get currentPendingBookingCommand(): Readonly<PendingBookingCommand> | null {
		return this.pendingBookingCommand?.event ?? null;
	}

	/** Replay only the retained immutable command, once per authenticated socket. */
	replayPendingBookingCommand(requestId: string): BookingReplayResult {
		const pending = this.pendingBookingCommand;
		if (!pending || pending.event.payload.requestId !== requestId) {
			return "no-pending";
		}
		if (
			this.stopped ||
			this.outboundDisabled ||
			this.terminalFallbackOnly ||
			!this.sessionReady ||
			!this.canSendSocket()
		) {
			return "unavailable";
		}
		if (pending.lastSentConnectionEpoch === this.connectionEpoch) {
			return "already-sent";
		}
		if (!this.sendValidatedEvent(pending.event)) return "unavailable";
		pending.lastSentConnectionEpoch = this.connectionEpoch;
		return "replayed";
	}

	/** Settle or explicitly cancel only the correlated retained command. */
	settleBookingRequest(requestId?: string): boolean {
		const pending = this.pendingBookingCommand;
		if (
			!pending ||
			(requestId && pending.event.payload.requestId !== requestId)
		) {
			return false;
		}
		this.pendingBookingCommand = null;
		return true;
	}

	cancelBookingRequest(requestId: string): boolean {
		return this.settleBookingRequest(requestId);
	}

	/** Keep the socket readable for terminal fallback text; only session.stop may send. */
	disableReconnect(): void {
		if (this.stopped) return;
		this.reconnectDisabled = true;
		this.terminalFallbackOnly = true;
		this.cancelReconnect();
		this.cancelPendingBookingForReconnect("reconnect_disabled");
	}

	stop(
		reason:
			| "user_requested"
			| "page_unload"
			| "client_error" = "user_requested",
	): void {
		if (this.stopped) return;
		// Preserve ordering: notify over the live socket before fencing outbound
		// traffic and closing it. The caller also uses the idempotent REST stop.
		if (this.sessionReady && this.canSendSocket()) {
			this.sendClientEvent("session.stop", { reason });
		}
		this.stopped = true;
		this.outboundDisabled = true;
		this.terminalFallbackOnly = false;
		this.sessionReady = false;
		this.pendingBookingCommand = null;
		this.pendingSegment = null;
		this.incompleteAudioSequences.clear();
		this.cancelReconnect();
		const socket = this.socket;
		this.socket = null;
		this.connectionEpoch += 1;
		socket?.close(1000, "session stopped");
		this.options.onStatus?.("closed");
	}

	get currentResumeToken(): string | null {
		return this.resumeToken;
	}

	get isReady(): boolean {
		return (
			!this.terminalFallbackOnly && this.sessionReady && this.canSendSocket()
		);
	}

	private receive(data: unknown): void {
		if (typeof data === "string") {
			this.receiveJson(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			this.receiveBinary(new Uint8Array(data));
			return;
		}
		if (ArrayBuffer.isView(data)) {
			this.receiveBinary(
				new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			);
			return;
		}
		this.reportProtocolError(new Error("Unsupported WebSocket message type"));
	}

	private receiveJson(raw: string): void {
		if (this.pendingSegment !== null) {
			this.pendingSegment = null;
			this.reportProtocolError(
				new Error("audio.segment metadata was not followed by a binary frame"),
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			this.reportProtocolError(new Error("Malformed WebSocket JSON event"));
			return;
		}
		const result = ServerWsEventSchema.safeParse(value);
		if (!result.success) {
			if (
				value !== null &&
				typeof value === "object" &&
				"type" in value &&
				value.type === "session.protocol.offer"
			) {
				this.failProtocolNegotiation("Invalid protocol offer");
				return;
			}
			this.reportProtocolError(new Error("Invalid server WebSocket event"));
			return;
		}
		const event = result.data;
		if (event.conversationId !== this.options.conversationId) {
			this.reportProtocolError(new Error("Server event conversation mismatch"));
			return;
		}
		if (
			event.type === "assistant.reaction.request" &&
			(this.protocolMode !== "v2" ||
				!this.options.localReactions?.clipIds.includes(event.payload.clipId))
		) {
			this.reportProtocolError(new Error("Unsupported local reaction request"));
			return;
		}

		if (event.type === "session.protocol.offer") {
			if (
				!this.requestsProtocolV2 ||
				this.protocolMode !== "awaiting" ||
				this.sessionReady
			) {
				this.failProtocolNegotiation("Unexpected protocol offer");
				return;
			}
			if (
				!this.sendClientEvent("client.protocol.accept", {
					version: VOICE_WS_PROTOCOL_VERSION,
					capabilities: {
						localReactions: this.options.localReactions ?? null,
					},
					playback: {
						maxBufferedSegments: PLAYBACK_FLOW_MAX_SEGMENTS,
						maxBufferedBytes: PLAYBACK_FLOW_MAX_BYTES,
						maxSegmentBytes: PLAYBACK_FLOW_MAX_SEGMENT_BYTES,
					},
				})
			) {
				this.failProtocolNegotiation("Protocol acceptance failed");
				return;
			}
			this.protocolMode = "negotiating";
			return;
		}

		if (event.type === "audio.segment") {
			const incomplete = this.incompleteAudioSequences.has(event.seq);
			const suppressDelivery =
				event.seq <= this.lastServerSequence && !incomplete;
			if (!suppressDelivery) {
				this.rememberIncompleteAudio(event.seq);
				this.options.onAudioMetadata?.(event.payload);
			}
			this.pendingSegment = { event, suppressDelivery };
			return;
		}
		if (event.seq <= this.lastServerSequence) {
			// Resume replays are harmless and must not duplicate state effects.
			return;
		}
		this.lastServerSequence = event.seq;

		if (event.type === "session.ready") {
			if (this.protocolMode === "awaiting") {
				// An old server ignored the v2 query and accepted the legacy hello.
				this.protocolMode = "legacy";
			} else if (this.protocolMode === "negotiating") {
				this.protocolMode = "v2";
			}
			this.resumeToken = event.payload.resumeToken;
			this.sessionReady = true;
			// Keep an in-flight request fenced across reconnect. The session settles
			// it only after accepting a matching durable meeting projection.
			this.reconnectAttempt = 0;
			this.options.onStatus?.("ready");
		}
		if (event.type === "transcript.final") {
			this.utteranceCommitted = false;
			this.utteranceHasAudio = false;
			this.utteranceNeedsRestart = false;
			if (this.textSubmissionPending) {
				this.textSubmissionPending = false;
				this.textSequence += 1;
			}
		}
		if (event.type === "error" && this.textSubmissionPending) {
			// A rejected sequence is retried with the same number.
			this.textSubmissionPending = false;
		}
		if (
			(event.type === "booking.draft.updated" ||
				event.type === "booking.form.rejected") &&
			event.payload.requestId ===
				this.pendingBookingCommand?.event.payload.requestId
		) {
			this.pendingBookingCommand = null;
		}
		this.options.onEvent?.(event);
	}

	private receiveBinary(rawFrame: Uint8Array): void {
		const pending = this.pendingSegment;
		this.pendingSegment = null;
		if (!pending) {
			this.reportProtocolError(
				new Error("Binary audio frame has no adjacent audio.segment metadata"),
			);
			return;
		}

		let bytes: Uint8Array;
		try {
			bytes = decodeAndPairServerSegment(pending.event.payload, rawFrame);
		} catch (error) {
			this.reportProtocolError(
				toError(error, "Invalid server audio segment pairing"),
			);
			return;
		}
		if (pending.suppressDelivery) return;

		this.incompleteAudioSequences.delete(pending.event.seq);
		this.lastServerSequence = Math.max(
			this.lastServerSequence,
			pending.event.seq,
		);
		this.options.onEvent?.(pending.event);
		this.options.onAudio?.(pending.event.payload, bytes);
	}

	private sendHello(): void {
		this.sendClientEvent("client.hello", {
			resumeToken: this.resumeToken,
			audio: {
				encoding: "pcm16le",
				sampleRate: 16_000,
				channels: 1,
				chunkMs: 100,
			},
		});
	}

	private sendClientEvent(
		type: ClientWsEvent["type"],
		payload: Record<string, unknown>,
	): boolean {
		const event = this.createClientEvent(type, payload);
		return event !== null && this.sendValidatedEvent(event);
	}

	private createClientEvent(
		type: ClientWsEvent["type"],
		payload: Record<string, unknown>,
	): ClientWsEvent | null {
		const bookingCommand =
			type === "booking.form.submit" ||
			type === "booking.draft.confirm" ||
			type === "booking.conflict.resolve";
		const result = ClientWsEventSchema.safeParse({
			v: CONTRACT_VERSION,
			...(bookingCommand
				? {}
				: { conversationId: this.options.conversationId }),
			at: this.nowIso(),
			type,
			payload,
		});
		if (!result.success) {
			this.reportProtocolError(new Error(`Invalid client event: ${type}`));
			return null;
		}
		return result.data;
	}

	private sendValidatedEvent(event: ClientWsEvent): boolean {
		if (
			this.outboundDisabled ||
			(this.terminalFallbackOnly && event.type !== "session.stop") ||
			!this.canSendSocket()
		) {
			return false;
		}
		try {
			this.socket?.send(JSON.stringify(event));
			return true;
		} catch (error) {
			this.reportProtocolError(toError(error, `Failed to send ${event.type}`));
			return false;
		}
	}

	private sendBookingCommand(
		type:
			| "booking.form.submit"
			| "booking.draft.confirm"
			| "booking.conflict.resolve",
		payload:
			| BookingFormDetails
			| BookingRevisionConfirmation
			| BookingConflictResolution,
	): boolean {
		if (
			!this.canSend() ||
			this.pendingBookingCommand !== null ||
			this.textSubmissionPending ||
			this.utteranceCommitted
		) {
			return false;
		}
		const event = this.createClientEvent(
			type,
			payload as Record<string, unknown>,
		);
		if (!event || !isBookingCommand(event) || !this.sendValidatedEvent(event)) {
			return false;
		}
		this.pendingBookingCommand = {
			event: deepFreeze(event),
			lastSentConnectionEpoch: this.connectionEpoch,
		};
		this.utteranceHasAudio = false;
		this.utteranceNeedsRestart = false;
		return true;
	}

	private canSend(): boolean {
		return (
			!this.outboundDisabled &&
			!this.terminalFallbackOnly &&
			this.sessionReady &&
			this.canSendSocket()
		);
	}

	private canSendSocket(): boolean {
		return this.socket !== null && this.socket.readyState === WEB_SOCKET_OPEN;
	}

	private nowIso(): string {
		return (this.options.now?.() ?? new Date()).toISOString();
	}

	private isCurrentSocket(socket: WebSocketLike, epoch: number): boolean {
		return this.socket === socket && this.connectionEpoch === epoch;
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectDisabled || this.reconnectHandle !== null)
			return;
		const maxAttempts = this.options.reconnect?.maxAttempts ?? 5;
		if (this.reconnectAttempt >= maxAttempts) {
			this.cancelPendingBookingForReconnect("reconnect_exhausted");
			this.options.onStatus?.("error");
			return;
		}
		const initialDelay = this.options.reconnect?.initialDelayMs ?? 250;
		const maxDelay = this.options.reconnect?.maxDelayMs ?? 4_000;
		const delay = Math.min(maxDelay, initialDelay * 2 ** this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.options.onStatus?.("reconnecting");
		if (this.stopped || this.reconnectDisabled) return;
		this.reconnectHandle = this.scheduler.schedule(() => {
			this.reconnectHandle = null;
			this.connect();
		}, delay);
	}

	private cancelReconnect(): void {
		if (this.reconnectHandle === null) return;
		this.scheduler.cancel(this.reconnectHandle);
		this.reconnectHandle = null;
	}

	private cancelPendingBookingForReconnect(
		reason: "reconnect_exhausted" | "reconnect_disabled",
	): void {
		const requestId = this.pendingBookingCommand?.event.payload.requestId;
		if (!requestId) return;
		this.pendingBookingCommand = null;
		this.options.onBookingRequestCancelled?.(requestId, reason);
	}

	private rememberIncompleteAudio(sequence: number): void {
		this.incompleteAudioSequences.add(sequence);
		if (this.incompleteAudioSequences.size <= 256) return;
		const oldest = this.incompleteAudioSequences.values().next().value;
		if (oldest !== undefined) this.incompleteAudioSequences.delete(oldest);
	}

	private failProtocolNegotiation(message: string): void {
		this.reportProtocolError(new Error(message));
		this.reconnectDisabled = true;
		this.outboundDisabled = true;
		this.sessionReady = false;
		this.socket?.close(1008, "protocol policy");
		this.options.onStatus?.("error");
	}

	private reportProtocolError(error: Error): void {
		this.options.onProtocolError?.(error);
	}
}

function requestsVoiceProtocolV2(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl, "http://voice-transport.invalid");
	} catch {
		return false;
	}
	const entries = [...url.searchParams.entries()];
	return (
		entries.length === 1 &&
		entries[0]?.[0] === VOICE_WS_PROTOCOL_QUERY_PARAM &&
		entries[0]?.[1] === VOICE_WS_PROTOCOL_V2_QUERY_VALUE
	);
}

function isBookingCommand(
	event: ClientWsEvent,
): event is PendingBookingCommand {
	return (
		event.type === "booking.form.submit" ||
		event.type === "booking.draft.confirm" ||
		event.type === "booking.conflict.resolve"
	);
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function toError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback);
}

export function createBrowserWebSocket(url: string): WebSocketLike {
	if (typeof WebSocket !== "function") {
		throw new Error("WebSocket API is unavailable");
	}
	return new WebSocket(url) as unknown as WebSocketLike;
}
