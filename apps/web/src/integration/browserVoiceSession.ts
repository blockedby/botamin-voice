import {
	type ConversationStage,
	CreateConversationRequestSchema,
	CreateConversationResponseSchema,
	type ServerWsEvent,
} from "@botamin/contracts";
import {
	AudioWorkletCapture,
	type CaptureStats,
	createBrowserAudioCaptureApis,
} from "../audio/capture";
import {
	type CompletePlaybackSegment,
	createBrowserAudioPlaybackApis,
	PhrasePlaybackQueue,
} from "../audio/playback";
import type {
	FinalTranscriptEntry,
	VoiceConsent,
	VoiceUiState,
} from "../components/VoiceDemo";
import {
	initialVoiceState,
	VoiceSessionController,
	type VoiceState,
} from "../state/voice";
import {
	createBrowserWebSocket,
	type ReconnectScheduler,
	VoiceTransport,
	type VoiceTransportStatus,
	type WebSocketFactory,
} from "../transport/ws";

const CONVERSATIONS_ENDPOINT = "/api/v1/conversations";

export interface BrowserVoiceSnapshot {
	state: VoiceUiState;
	transcript: readonly FinalTranscriptEntry[];
	muted: boolean;
}

export interface CaptureAdapter {
	start(): Promise<void>;
	finish(): Promise<CaptureStats>;
	stop(): Promise<void>;
	setMuted(muted: boolean): void;
	readonly isActive: boolean;
}

export interface CaptureFactoryOptions {
	onFrame(frame: Uint8Array): void;
	onLimit(): void;
}

export interface PlaybackAdapter {
	beginGeneration(generationId: string): void;
	enqueue(segment: CompletePlaybackSegment): Promise<boolean>;
	bargeIn(): string | null;
	dispose(): Promise<void>;
	readonly activeGenerationId: string | null;
	readonly bufferedSegmentCount: number;
}

export interface PlaybackFactoryOptions {
	onStarted(segment: CompletePlaybackSegment): void;
	onIdle(generationId: string): void;
	onError(error: Error, segment: CompletePlaybackSegment): void;
}

export interface FetchResponseLike {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<FetchResponseLike>;

export interface BrowserVoiceFactories {
	fetch: FetchLike;
	createSocket: WebSocketFactory;
	createCapture(options: CaptureFactoryOptions): CaptureAdapter;
	createPlayback(options: PlaybackFactoryOptions): PlaybackAdapter;
	baseUrl: string;
	now?: () => Date;
	reconnectScheduler?: ReconnectScheduler;
	createAbortController?: () => AbortController;
}

const INITIAL_SNAPSHOT: BrowserVoiceSnapshot = {
	state: { kind: "idle" },
	transcript: [],
	muted: false,
};

/** Resolve a contract WS path without allowing the REST response to leave this origin. */
export function resolveSameOriginWebSocketUrl(
	wsPath: string,
	baseUrl: string,
): string {
	const pageUrl = new URL(baseUrl);
	if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
		throw new Error("Unsupported page protocol");
	}
	const resolved = new URL(wsPath, pageUrl);
	if (resolved.origin !== pageUrl.origin) {
		throw new Error("Cross-origin WebSocket URL is not allowed");
	}
	resolved.protocol = pageUrl.protocol === "https:" ? "wss:" : "ws:";
	return resolved.toString();
}

/**
 * Provider-neutral composition boundary for the browser voice route. It owns
 * only same-origin REST/WS, T10 capture/controller/transport/playback, and a
 * truthful projection into the product UI.
 */
export class BrowserVoiceSession {
	private snapshot: BrowserVoiceSnapshot = INITIAL_SNAPSHOT;
	private readonly listeners = new Set<() => void>();
	private controller: VoiceSessionController | null = null;
	private transport: VoiceTransport | null = null;
	private capture: CaptureAdapter | null = null;
	private playback: PlaybackAdapter | null = null;
	private abortController: AbortController | null = null;
	private conversationId: string | null = null;
	private bookingId: string | null = null;
	private qualificationStatus: "none" | "partial" | "complete" | "skipped" =
		"none";
	private readonly completedAssistantGenerations = new Set<string>();
	private consent: VoiceConsent | null = null;
	private epoch = 0;
	private starting = false;
	private committing = false;
	private captureStarting = false;
	private captureArmed = false;
	private captureAttempt = 0;
	private captureCleanup: Promise<void> = Promise.resolve();
	private sessionEstablished = false;
	private disposed = false;
	private playbackUnavailable = false;

	constructor(private readonly factories: BrowserVoiceFactories) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly getSnapshot = (): BrowserVoiceSnapshot => this.snapshot;

	async start(consent: VoiceConsent): Promise<boolean> {
		if (
			this.disposed ||
			this.starting ||
			this.transport !== null ||
			!consent.voiceProcessing ||
			!consent.contactProcessing
		) {
			return false;
		}
		this.starting = true;
		this.consent = { ...consent };
		const epoch = ++this.epoch;
		this.bookingId = null;
		this.qualificationStatus = "none";
		this.completedAssistantGenerations.clear();
		this.captureArmed = false;
		this.sessionEstablished = false;
		this.setSnapshot({
			state: { kind: "connecting" },
			transcript: [],
			muted: false,
		});
		this.controller = new VoiceSessionController(initialVoiceState, (state) =>
			this.projectControllerState(state),
		);
		this.controller.setConnecting();

		try {
			const captureAttempt = ++this.captureAttempt;
			const capture = this.createCapture(epoch, captureAttempt);
			this.capture = capture;
			this.captureStarting = true;
			try {
				await capture.start();
			} finally {
				if (captureAttempt === this.captureAttempt) {
					this.captureStarting = false;
				}
			}
			if (
				!this.isCurrent(epoch) ||
				captureAttempt !== this.captureAttempt ||
				this.capture !== capture
			) {
				await capture.stop();
				return false;
			}
			capture.setMuted(this.snapshot.muted);

			const request = CreateConversationRequestSchema.parse({
				source: "landing",
				locale: "ru-RU",
				qualificationEnabled: true,
				consent,
			});
			this.abortController = (
				this.factories.createAbortController ?? (() => new AbortController())
			)();
			const response = await this.factories.fetch(CONVERSATIONS_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
				signal: this.abortController.signal,
				credentials: "same-origin",
			});
			if (!response.ok) {
				throw new Error(`Conversation request failed (${response.status})`);
			}
			const created = CreateConversationResponseSchema.parse(
				await response.json(),
			);
			if (!this.isCurrent(epoch)) {
				this.notifyConversationStop(
					created.conversationId,
					this.disposed ? "page_unload" : "client_error",
				);
				return false;
			}
			this.conversationId = created.conversationId;
			if (new Date(created.expiresAt).getTime() <= this.now().getTime()) {
				throw new Error("Conversation response is already expired");
			}
			const socketUrl = resolveSameOriginWebSocketUrl(
				created.wsUrl,
				this.factories.baseUrl,
			);
			this.preparePlayback();
			this.transport = new VoiceTransport({
				conversationId: created.conversationId,
				url: socketUrl,
				createWebSocket: this.factories.createSocket,
				...(this.factories.reconnectScheduler
					? { scheduler: this.factories.reconnectScheduler }
					: {}),
				...(this.factories.now ? { now: this.factories.now } : {}),
				onEvent: (event) => this.receiveEvent(event, epoch),
				onAudio: (metadata, bytes) => {
					if (!this.isCurrent(epoch)) return;
					void this.receiveAudio({ ...metadata, bytes });
				},
				onStatus: (status) => this.receiveTransportStatus(status, epoch),
				onProtocolError: () => {
					// Contract/parser details remain internal; the transport can still reconnect.
				},
			});
			if (!this.transport.connect()) {
				throw new Error("WebSocket creation failed");
			}
			return true;
		} catch (error) {
			if (this.isCurrent(epoch)) {
				const cleanupEpoch = epoch + 1;
				await this.releaseResources("client_error", true);
				if (!this.disposed && this.epoch === cleanupEpoch) {
					this.setState(
						isPermissionDenied(error)
							? { kind: "permission-denied" }
							: { kind: "error" },
					);
				}
			}
			return false;
		} finally {
			if (this.epoch === epoch) this.starting = false;
		}
	}

	async commit(): Promise<boolean> {
		if (
			this.disposed ||
			this.committing ||
			this.captureStarting ||
			!this.capture?.isActive ||
			!this.controller ||
			!this.transport
		) {
			return false;
		}
		this.committing = true;
		const capture = this.capture;
		this.capture = null;
		this.captureArmed = false;
		try {
			await capture.finish();
			const accepted = this.controller.commit(
				() => this.transport?.commit() ?? false,
			);
			if (!accepted) void this.beginCapture(this.epoch);
			return accepted;
		} catch {
			this.setState(this.activeState("error"));
			return false;
		} finally {
			this.committing = false;
		}
	}

	toggleMute(): void {
		const muted = !this.snapshot.muted;
		this.capture?.setMuted(muted);
		this.transport?.setMuted(muted);
		this.controller?.setMuted(muted);
		this.setSnapshot({ ...this.snapshot, muted });
	}

	interrupt(): void {
		if (!this.controller) return;
		this.controller.bargeIn({
			stopLocalPlayback: () => {
				this.playback?.bargeIn();
			},
			sendInterruption: (generationId, reason) => {
				this.transport?.interrupt(generationId, reason);
			},
		});
		void this.beginCapture(this.epoch);
	}

	reconnect(): void {
		if (this.disposed) return;
		if (this.transport) {
			this.transport.connect();
			return;
		}
		if (this.consent) void this.start(this.consent);
	}

	async retryPermission(): Promise<void> {
		if (this.transport?.isReady) {
			await this.beginCapture(this.epoch);
			return;
		}
		if (this.consent) await this.start(this.consent);
	}

	async retry(): Promise<void> {
		const consent = this.consent;
		await this.releaseResources("client_error", true);
		this.setSnapshot({ ...INITIAL_SNAPSHOT });
		if (consent) await this.start(consent);
	}

	async stop(): Promise<void> {
		const state = this.bookingId
			? ({
					kind: "complete",
					bookingOutcome: "committed",
					qualificationStatus:
						this.qualificationStatus === "none"
							? "skipped"
							: this.qualificationStatus,
				} satisfies VoiceUiState)
			: ({ kind: "complete", bookingOutcome: "none" } satisfies VoiceUiState);
		await this.releaseResources("user_requested", true);
		this.setState(state);
	}

	async reset(): Promise<void> {
		await this.releaseResources("user_requested", true);
		this.consent = null;
		this.setSnapshot({ ...INITIAL_SNAPSHOT });
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.releaseResources("page_unload", true);
		this.listeners.clear();
	}

	private createCapture(epoch: number, attempt: number): CaptureAdapter {
		return this.factories.createCapture({
			onFrame: (frame) => {
				if (
					this.isCurrent(epoch) &&
					attempt === this.captureAttempt &&
					this.captureArmed
				) {
					this.transport?.sendPcmFrame(frame);
				}
			},
			onLimit: () => {
				if (
					this.isCurrent(epoch) &&
					attempt === this.captureAttempt &&
					this.captureArmed
				) {
					void this.commit();
				}
			},
		});
	}

	private preparePlayback(): void {
		this.playbackUnavailable = false;
		try {
			this.playback = this.factories.createPlayback({
				onStarted: (segment) => {
					this.transport?.playbackStarted(segment.generationId);
				},
				onIdle: (generationId) => {
					if (this.controller?.completePlayback(generationId)) {
						void this.beginCapture(this.epoch);
					}
				},
				onError: (_error, segment) => {
					this.transport?.interrupt(segment.generationId, "playback_error");
					this.controller?.setAudioError("Звук ответа сейчас недоступен");
					this.setState(this.activeState("audio-error"));
					void this.beginCapture(this.epoch);
				},
			});
		} catch {
			this.playback = null;
			this.playbackUnavailable = true;
		}
	}

	private async beginCapture(epoch: number): Promise<void> {
		if (
			!this.isCurrent(epoch) ||
			!this.transport?.isReady ||
			this.capture !== null ||
			this.captureStarting ||
			this.committing ||
			this.controller?.hasPendingCommit
		) {
			return;
		}
		this.captureStarting = true;
		const attempt = ++this.captureAttempt;
		let restartAfterCleanup = false;
		try {
			await this.captureCleanup;
			if (
				!this.isCurrent(epoch) ||
				attempt !== this.captureAttempt ||
				!this.transport?.isReady ||
				this.controller?.hasPendingCommit ||
				!this.transport.beginUtterance()
			) {
				return;
			}
			const capture = this.createCapture(epoch, attempt);
			this.capture = capture;
			try {
				await capture.start();
				if (
					!this.isCurrent(epoch) ||
					attempt !== this.captureAttempt ||
					this.capture !== capture
				) {
					await capture.stop();
					restartAfterCleanup = this.isCurrent(epoch);
					return;
				}
				capture.setMuted(this.snapshot.muted);
				this.captureArmed = true;
				this.controller?.beginListening();
				this.setState(this.activeState("listening"));
			} catch (error) {
				if (
					this.isCurrent(epoch) &&
					attempt === this.captureAttempt &&
					this.capture === capture
				) {
					this.capture = null;
					this.captureArmed = false;
					this.setState(
						this.activeState(
							isPermissionDenied(error) ? "permission-denied" : "error",
						),
					);
				} else if (this.isCurrent(epoch) && this.capture !== capture) {
					restartAfterCleanup = true;
				}
			}
		} finally {
			if (attempt === this.captureAttempt) this.captureStarting = false;
			if (restartAfterCleanup) void this.beginCapture(epoch);
		}
	}

	private async failStartup(epoch: number): Promise<void> {
		if (!this.isCurrent(epoch) || this.sessionEstablished) return;
		const cleanupEpoch = epoch + 1;
		await this.releaseResources("client_error", true);
		if (!this.disposed && this.epoch === cleanupEpoch) {
			this.setState({ kind: "error" });
		}
	}

	private receiveTransportStatus(
		status: VoiceTransportStatus,
		epoch: number,
	): void {
		if (!this.isCurrent(epoch)) return;
		switch (status) {
			case "connecting":
				this.setState(this.activeState("connecting"));
				break;
			case "reconnecting": {
				if (!this.sessionEstablished) {
					void this.failStartup(epoch);
					break;
				}
				const capture = this.capture;
				const startWasPending = this.captureStarting;
				this.capture = null;
				this.captureArmed = false;
				if (!startWasPending) this.captureAttempt += 1;
				if (capture) {
					const previousCleanup = this.captureCleanup;
					this.captureCleanup = Promise.allSettled([
						previousCleanup,
						capture.stop(),
					]).then(() => undefined);
				}
				this.setState(this.activeState("reconnecting"));
				break;
			}
			case "error":
				if (!this.sessionEstablished) {
					void this.failStartup(epoch);
				} else {
					this.setState(this.activeState("disconnected"));
				}
				break;
			case "ready":
				break;
			case "closed":
				break;
		}
	}

	private receiveEvent(event: ServerWsEvent, epoch: number): void {
		if (!this.isCurrent(epoch) || !this.controller) return;
		switch (event.type) {
			case "session.ready": {
				this.sessionEstablished = true;
				const capture = this.capture;
				if (capture?.isActive && this.transport?.beginUtterance()) {
					this.captureArmed = true;
					capture.setMuted(this.snapshot.muted);
				} else if (capture) {
					this.capture = null;
					void capture.stop();
				}
				this.controller.acceptEvent(event);
				if (!this.captureArmed) void this.beginCapture(epoch);
				break;
			}
			case "transcript.final":
				if (this.controller.acceptEvent(event)) {
					this.appendTranscript({
						id: event.payload.turnId,
						speaker: "visitor",
						text: event.payload.text,
					});
					this.setState(this.activeState("thinking"));
				}
				break;
			case "assistant.text.delta":
				this.controller.acceptEvent(event);
				break;
			case "assistant.text.done":
				if (
					this.controller.acceptEvent(event) &&
					event.payload.fullText.length > 0 &&
					!this.completedAssistantGenerations.has(event.payload.generationId)
				) {
					rememberBounded(
						this.completedAssistantGenerations,
						event.payload.generationId,
					);
					this.appendTranscript({
						id: event.payload.generationId,
						speaker: "agent",
						text: event.payload.fullText,
					});
				}
				break;
			case "audio.segment":
				if (this.controller.acceptEvent(event)) {
					if (this.playbackUnavailable || !this.playback) {
						this.transport?.interrupt(
							event.payload.generationId,
							"playback_error",
						);
						this.controller.completePlayback(event.payload.generationId);
						this.setState(this.activeState("audio-error"));
						void this.beginCapture(epoch);
					} else {
						this.playback.beginGeneration(event.payload.generationId);
					}
				}
				break;
			case "assistant.audio.done":
				if (
					this.playback?.activeGenerationId !== event.payload.generationId ||
					this.playback.bufferedSegmentCount === 0
				) {
					if (this.controller.completePlayback(event.payload.generationId)) {
						void this.beginCapture(epoch);
					}
				}
				break;
			case "assistant.interrupted":
				this.playback?.bargeIn();
				if (this.controller.acceptEvent(event)) void this.beginCapture(epoch);
				break;
			case "state.changed":
				this.applyServerStage(event.payload.to);
				break;
			case "booking.created":
				this.bookingId = event.payload.bookingId;
				this.qualificationStatus = event.payload.qualificationStatus;
				this.setState({ kind: "booked" });
				break;
			case "booking.updated":
				if (event.payload.bookingId !== this.bookingId) break;
				this.qualificationStatus = event.payload.qualificationStatus;
				if (event.payload.qualificationStatus === "partial") {
					this.setState({
						kind: "qualification",
						bookingOutcome: "committed",
					});
				} else {
					this.setState({
						kind: "complete",
						bookingOutcome: "committed",
						qualificationStatus: event.payload.qualificationStatus,
					});
				}
				break;
			case "error":
				if (event.payload.code === "TTS_UNAVAILABLE") {
					this.controller.setAudioError("Звук ответа сейчас недоступен");
					this.setState(this.activeState("audio-error"));
					void this.beginCapture(epoch);
				} else {
					this.setState(this.activeState("error"));
				}
				break;
			case "session.capacity_warning":
			case "server.pong":
				break;
		}
	}

	private async receiveAudio(segment: CompletePlaybackSegment): Promise<void> {
		if (
			!this.playback ||
			this.playback.activeGenerationId !== segment.generationId
		) {
			return;
		}
		await this.playback.enqueue(segment);
	}

	private applyServerStage(stage: ConversationStage): void {
		switch (stage) {
			case "DISCONNECTED":
				this.setState(this.activeState("disconnected"));
				break;
			case "ERROR":
				this.setState(this.activeState("error"));
				break;
			case "COMPLETE":
			case "DECLINED":
				this.setState(
					this.bookingId
						? {
								kind: "complete",
								bookingOutcome: "committed",
								qualificationStatus:
									this.qualificationStatus === "none"
										? "skipped"
										: this.qualificationStatus,
							}
						: { kind: "complete", bookingOutcome: "none" },
				);
				void this.releaseResources("user_requested", false);
				break;
			case "BOOKED":
				if (this.bookingId) this.setState({ kind: "booked" });
				break;
			case "POST_BOOKING_QUALIFICATION":
				if (this.bookingId) {
					this.setState({
						kind: "qualification",
						bookingOutcome: "committed",
					});
				}
				break;
			case "CONNECTING":
				this.setState(this.activeState("connecting"));
				break;
			default:
				if (
					this.snapshot.state.kind !== "speaking" &&
					this.snapshot.state.kind !== "booked" &&
					this.snapshot.state.kind !== "qualification"
				) {
					this.setState(this.activeState("thinking"));
				}
		}
	}

	private projectControllerState(state: VoiceState): void {
		if (this.snapshot.state.kind === "complete") return;
		switch (state.status) {
			case "connecting":
				this.setState(this.activeState("connecting"));
				break;
			case "listening":
				if (this.capture?.isActive) {
					this.setState(this.activeState("listening"));
				}
				break;
			case "processing":
				this.setState(this.activeState("processing"));
				break;
			case "speaking":
				this.setState(this.activeState("speaking"));
				break;
			case "error":
				this.setState(this.activeState("error"));
				break;
			case "idle":
			case "stopped":
				break;
		}
	}

	private appendTranscript(entry: FinalTranscriptEntry): void {
		if (this.snapshot.transcript.some((item) => item.id === entry.id)) return;
		this.setSnapshot({
			...this.snapshot,
			transcript: [...this.snapshot.transcript, entry],
		});
	}

	private async releaseMediaOnly(): Promise<void> {
		const capture = this.capture;
		const playback = this.playback;
		this.capture = null;
		this.playback = null;
		await Promise.allSettled([capture?.stop(), playback?.dispose()]);
	}

	private async releaseResources(
		reason: "user_requested" | "page_unload" | "client_error",
		notifyServer: boolean,
	): Promise<void> {
		++this.epoch;
		this.captureAttempt += 1;
		this.captureStarting = false;
		this.captureArmed = false;
		this.sessionEstablished = false;
		this.abortController?.abort();
		this.abortController = null;
		const transport = this.transport;
		const controller = this.controller;
		const conversationId = this.conversationId;
		this.transport = null;
		this.controller = null;
		controller?.stop(() => {
			this.playback?.bargeIn();
			transport?.stop(reason);
		});
		await Promise.allSettled([this.captureCleanup, this.releaseMediaOnly()]);
		this.captureCleanup = Promise.resolve();
		this.capture = null;
		this.committing = false;
		this.starting = false;
		if (notifyServer && conversationId) {
			this.notifyConversationStop(conversationId, reason);
		}
		this.conversationId = null;
	}

	private notifyConversationStop(
		conversationId: string,
		reason: "user_requested" | "page_unload" | "client_error",
	): void {
		void this.factories
			.fetch(
				`${CONVERSATIONS_ENDPOINT}/${encodeURIComponent(conversationId)}/stop`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ reason }),
					credentials: "same-origin",
					keepalive: reason === "page_unload",
				},
			)
			.catch(() => undefined);
	}

	private activeState(
		kind:
			| "connecting"
			| "permission-denied"
			| "listening"
			| "processing"
			| "thinking"
			| "speaking"
			| "audio-error"
			| "disconnected"
			| "reconnecting"
			| "error",
	): VoiceUiState {
		return this.bookingId ? { kind, bookingOutcome: "committed" } : { kind };
	}

	private setState(state: VoiceUiState): void {
		this.setSnapshot({ ...this.snapshot, state });
	}

	private setSnapshot(snapshot: BrowserVoiceSnapshot): void {
		if (this.disposed) return;
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}

	private isCurrent(epoch: number): boolean {
		return !this.disposed && this.epoch === epoch;
	}

	private now(): Date {
		return this.factories.now?.() ?? new Date();
	}
}

function isPermissionDenied(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "NotAllowedError" || error.name === "SecurityError")
	);
}

function rememberBounded(values: Set<string>, value: string): void {
	values.add(value);
	if (values.size <= 256) return;
	const oldest = values.values().next().value;
	if (oldest !== undefined) values.delete(oldest);
}

export function createBrowserVoiceSession(): BrowserVoiceSession {
	if (typeof window === "undefined") {
		throw new Error("Browser voice session requires a window");
	}
	return new BrowserVoiceSession({
		baseUrl: window.location.href,
		fetch: (input, init) => window.fetch(input, init),
		createSocket: createBrowserWebSocket,
		createCapture: (options) =>
			new AudioWorkletCapture({
				apis: createBrowserAudioCaptureApis(),
				onFrame: options.onFrame,
				onLimit: options.onLimit,
			}),
		createPlayback: (options) =>
			new PhrasePlaybackQueue(createBrowserAudioPlaybackApis(), options),
	});
}
