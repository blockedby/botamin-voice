import {
	type AudioClientConfig,
	type BookingConflictResolution,
	type BookingFormDetails,
	type BrowserBookingDraft,
	type ConversationStage,
	CreateConversationRequestSchema,
	CreateConversationResponseSchema,
	type InternalVirtualMeetingProjection,
	InternalVirtualMeetingProjectionSchema,
	type QualificationField,
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
	BookingConflictSelection,
	BookingFormSubmission,
	BookingSubmissionState,
	FinalTranscriptEntry,
	TextSubmissionState,
	VoiceCaptureProgress,
	VoiceConsent,
	VoiceUiState,
} from "../components/voiceTypes";
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
	captureProgress: VoiceCaptureProgress | null;
	conversationStage: ConversationStage | null;
	textInputAvailable: boolean;
	textSubmission: TextSubmissionState;
	bookingDraft: BrowserBookingDraft | null;
	internalMeeting: InternalVirtualMeetingProjection | null;
	bookingSubmission: BookingSubmissionState;
	bookingInputAvailable: boolean;
}

export interface CaptureAdapter {
	prepare(): Promise<void>;
	configureLimits(maxDurationMs: number, maxBytes: number): void;
	start(): Promise<void>;
	finish(): Promise<CaptureStats>;
	stop(): Promise<void>;
	setMuted(muted: boolean): void;
	setAccepting(accepting: boolean): void;
	readonly isActive: boolean;
}

export interface CaptureFactoryOptions {
	onFrame(frame: Uint8Array): void;
	onProgress(stats: CaptureStats): void;
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
	createRequestId?: () => string;
}

const INITIAL_SNAPSHOT: BrowserVoiceSnapshot = {
	state: { kind: "idle" },
	transcript: [],
	muted: false,
	captureProgress: null,
	conversationStage: null,
	textInputAvailable: false,
	textSubmission: { status: "idle" },
	bookingDraft: null,
	internalMeeting: null,
	bookingSubmission: { status: "idle" },
	bookingInputAvailable: false,
};

/** Resolve a contract WS path without allowing the REST response to leave this origin. */
export function effectiveCaptureDurationMs(
	config: Pick<AudioClientConfig, "maxUtteranceMs" | "maxPcmBytes">,
): number {
	return Math.min(config.maxUtteranceMs, config.maxPcmBytes / 32);
}

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
	private clientConfig: AudioClientConfig | null = null;
	private conversationStage: ConversationStage | null = null;
	private bookingDraft: BrowserBookingDraft | null = null;
	private internalMeeting: InternalVirtualMeetingProjection | null = null;
	/** Legacy lifecycle marker is presentation-only and never renders the widget. */
	private legacyBookingPresentation = false;
	private bookingSubmission: BookingSubmissionState = { status: "idle" };
	private pendingTypedText: string | null = null;
	private qualificationStatus: "none" | "partial" | "complete" | "skipped" =
		"none";
	private qualificationFields: QualificationField[] = [];
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
	private textOnlyGenerationPending: string | null = null;
	private terminalFailurePending = false;

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
		this.bookingDraft = null;
		this.internalMeeting = null;
		this.legacyBookingPresentation = false;
		this.bookingSubmission = { status: "idle" };
		this.conversationStage = null;
		this.pendingTypedText = null;
		this.qualificationStatus = "none";
		this.qualificationFields = [];
		this.completedAssistantGenerations.clear();
		this.captureArmed = false;
		this.sessionEstablished = false;
		this.textOnlyGenerationPending = null;
		this.terminalFailurePending = false;
		this.clientConfig = null;
		this.setSnapshot({
			state: { kind: "connecting" },
			transcript: [],
			muted: false,
			captureProgress: null,
			conversationStage: null,
			textInputAvailable: false,
			textSubmission: { status: "idle" },
			bookingDraft: null,
			internalMeeting: null,
			bookingSubmission: { status: "idle" },
			bookingInputAvailable: false,
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
			await capture.prepare();
			if (
				!this.isCurrent(epoch) ||
				captureAttempt !== this.captureAttempt ||
				this.capture !== capture
			) {
				await capture.stop();
				return false;
			}

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
			this.clientConfig = created.clientConfig;
			if (new Date(created.expiresAt).getTime() <= this.now().getTime()) {
				throw new Error("Conversation response is already expired");
			}
			capture.configureLimits(
				created.clientConfig.maxUtteranceMs,
				created.clientConfig.maxPcmBytes,
			);
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
			capture.setAccepting(false);
			const socketUrl = resolveSameOriginWebSocketUrl(
				created.wsUrl,
				this.factories.baseUrl,
			);
			this.preparePlayback();
			this.transport = new VoiceTransport({
				conversationId: created.conversationId,
				url: socketUrl,
				resumeToken: created.clientToken,
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
			this.terminalFailurePending ||
			this.isBookingRequestPending() ||
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
		capture.setAccepting(false);
		this.setCaptureProgress(null);
		const epoch = this.epoch;
		const finish = capture.finish();
		const previousCleanup = this.captureCleanup;
		this.captureCleanup = Promise.allSettled([previousCleanup, finish]).then(
			() => undefined,
		);
		try {
			await finish;
			if (!this.isCurrent(epoch)) return false;
			const controller = this.controller;
			const transport = this.transport;
			if (!controller || !transport) return false;
			const accepted = controller.commit(() => transport.commit());
			if (!accepted) void this.beginCapture(epoch);
			return accepted;
		} catch {
			if (this.isCurrent(epoch)) this.setState(this.activeState("error"));
			return false;
		} finally {
			if (this.epoch === epoch) this.committing = false;
		}
	}

	/** Submit one typed final turn without exposing provider or tool controls. */
	submitText(text: string): boolean {
		if (
			this.disposed ||
			this.terminalFailurePending ||
			!this.snapshot.textInputAvailable ||
			this.isBookingRequestPending() ||
			!this.controller ||
			!this.transport ||
			this.pendingTypedText !== null
		) {
			return false;
		}
		const capture = this.capture;
		this.capture = null;
		this.captureArmed = false;
		if (capture) {
			const previousCleanup = this.captureCleanup;
			this.captureCleanup = Promise.allSettled([
				previousCleanup,
				capture.stop(),
			]).then(() => undefined);
		}
		const accepted = this.controller.commit(
			() => this.transport?.submitText(text) ?? false,
		);
		if (!accepted) {
			void this.beginCapture(this.epoch);
			return false;
		}
		this.pendingTypedText = text.trim();
		this.setSnapshot({
			...this.snapshot,
			textSubmission: { status: "pending" },
		});
		return true;
	}

	/** Submit only visitor fields and a current candidate identity. */
	submitBookingForm(submission: BookingFormSubmission): boolean {
		const draft = this.bookingDraft;
		const transport = this.transport;
		if (
			!draft ||
			!transport ||
			!this.canSubmitBooking() ||
			submission.baseRevision !== draft.revision
		) {
			return false;
		}
		const hasDetails = Object.keys(submission.details).length > 0;
		const hasCandidateSelection = submission.selectedCandidateId !== undefined;
		if (!hasDetails && !hasCandidateSelection) {
			if (!isDraftConfirmable(draft)) return false;
			return this.sendBookingConfirmation(draft.revision);
		}

		const requestId = this.createRequestId();
		const payload: BookingFormDetails = {
			requestId,
			baseRevision: draft.revision,
			details: submission.details,
			...(hasCandidateSelection
				? { selectedCandidateId: submission.selectedCandidateId }
				: {}),
		};
		this.suspendCaptureForBooking();
		if (!transport.submitBookingForm(payload)) {
			void this.beginCapture(this.epoch);
			return false;
		}
		this.bookingSubmission = {
			status: "details-pending",
			requestId,
			baseRevision: draft.revision,
		};
		this.syncBookingSnapshot();
		return true;
	}

	resolveBookingConflict(selection: BookingConflictSelection): boolean {
		const draft = this.bookingDraft;
		const transport = this.transport;
		if (
			!draft ||
			!transport ||
			!this.canSubmitBooking() ||
			selection.baseRevision !== draft.revision
		) {
			return false;
		}
		const requestId = this.createRequestId();
		const payload: BookingConflictResolution = {
			requestId,
			baseRevision: draft.revision,
			field: selection.field,
			conflictOptionId: selection.conflictOptionId,
		};
		this.suspendCaptureForBooking();
		if (!transport.resolveBookingConflict(payload)) {
			void this.beginCapture(this.epoch);
			return false;
		}
		this.bookingSubmission = {
			status: "conflict-resolution-pending",
			requestId,
			baseRevision: draft.revision,
			field: selection.field,
		};
		this.syncBookingSnapshot();
		return true;
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
		this.textOnlyGenerationPending = null;
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
		if (this.disposed || this.terminalFailurePending) return;
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
		const state = this.internalMeeting
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
		this.conversationStage = null;
		this.bookingDraft = null;
		this.internalMeeting = null;
		this.legacyBookingPresentation = false;
		this.bookingSubmission = { status: "idle" };
		this.pendingTypedText = null;
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
			onProgress: (stats) => {
				if (
					this.isCurrent(epoch) &&
					attempt === this.captureAttempt &&
					this.captureArmed
				) {
					const clientConfig = this.clientConfig;
					this.setCaptureProgress({
						acceptedPcmBytes: stats.bytes,
						durationMs: stats.durationMs,
						maxUtteranceMs: clientConfig
							? effectiveCaptureDurationMs(clientConfig)
							: 0,
					});
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
			this.isBookingRequestPending() ||
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
				this.isBookingRequestPending() ||
				this.controller?.hasPendingCommit ||
				!this.transport.beginUtterance()
			) {
				return;
			}
			const capture = this.createCapture(epoch, attempt);
			this.capture = capture;
			try {
				const clientConfig = this.clientConfig;
				if (!clientConfig)
					throw new Error("Audio client config is unavailable");
				capture.configureLimits(
					clientConfig.maxUtteranceMs,
					clientConfig.maxPcmBytes,
				);
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
				capture.setAccepting(true);
				this.captureArmed = true;
				this.resetCaptureProgress();
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

	private async failClientConfig(epoch: number): Promise<void> {
		if (!this.isCurrent(epoch)) return;
		const cleanupEpoch = epoch + 1;
		await this.releaseResources("client_error", true);
		if (!this.disposed && this.epoch === cleanupEpoch) {
			this.setState(this.activeState("error"));
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
				this.textOnlyGenerationPending = null;
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
				if (
					!sameAudioClientConfig(this.clientConfig, event.payload.clientConfig)
				) {
					void this.failClientConfig(epoch);
					break;
				}
				this.sessionEstablished = true;
				const previousBookingSubmission = this.bookingSubmission;
				this.conversationStage = event.payload.state;
				this.bookingDraft = event.payload.bookingDraft;
				this.internalMeeting = meetingMatchesDraft(
					event.payload.internalMeeting,
					event.payload.bookingDraft,
				)
					? event.payload.internalMeeting
					: null;
				this.legacyBookingPresentation =
					this.internalMeeting === null &&
					event.payload.bookingDraft?.commitStatus === "committed";
				this.bookingSubmission = bookingSubmissionAfterResync(
					previousBookingSubmission,
					this.internalMeeting,
				);
				if (this.internalMeeting) this.transport?.settleBookingRequest();
				this.qualificationStatus =
					this.internalMeeting?.qualificationStatus ?? "none";
				this.qualificationFields = qualificationFieldNames(
					this.internalMeeting,
				);
				this.syncBookingSnapshot();
				const capture = this.capture;
				if (capture?.isActive && this.transport?.beginUtterance()) {
					this.captureArmed = true;
					capture.setMuted(this.snapshot.muted);
					capture.setAccepting(true);
					this.resetCaptureProgress();
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
					const acceptedTypedText = this.pendingTypedText;
					this.pendingTypedText = null;
					this.appendTranscript({
						id: event.payload.turnId,
						speaker: "visitor",
						text: event.payload.text,
					});
					if (acceptedTypedText !== null) {
						this.setSnapshot({
							...this.snapshot,
							textSubmission: {
								status: "accepted",
								turnId: event.payload.turnId,
							},
						});
					}
					this.setState(this.activeState("thinking"));
				}
				break;
			case "assistant.text.delta":
				this.controller.acceptEvent(event);
				break;
			case "assistant.text.done": {
				const accepted = this.controller.acceptEvent(event);
				if (
					accepted &&
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
				const textOnlyGeneration =
					this.textOnlyGenerationPending === event.payload.generationId;
				if (textOnlyGeneration) this.textOnlyGenerationPending = null;
				if (accepted && textOnlyGeneration) {
					if (this.controller.completePlayback(event.payload.generationId)) {
						this.setState(this.activeState("audio-error"));
						void this.beginCapture(epoch);
					}
				}
				if (this.terminalFailurePending) {
					void this.finishTerminalFailure(epoch);
				}
				break;
			}
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
				this.conversationStage = event.payload.to;
				this.applyServerStage(event.payload.to);
				break;
			case "booking.draft.updated":
				this.acceptBookingDraft(
					event.payload.bookingDraft,
					event.payload.requestId,
					epoch,
				);
				break;
			case "booking.form.rejected":
				this.acceptBookingRejection(event, epoch);
				break;
			case "internal.meeting.updated":
				this.acceptInternalMeeting(event.payload.meeting, false);
				break;
			case "booking.created": {
				// Keep legacy active-state presentation compatible while refusing to
				// synthesize a meeting widget or final success from this thin event.
				this.legacyBookingPresentation = true;
				const enriched = projectionFromEventPayload(event.payload);
				if (enriched) this.acceptInternalMeeting(enriched, false);
				break;
			}
			case "booking.updated": {
				const enriched = projectionFromEventPayload(event.payload);
				if (enriched) this.acceptInternalMeeting(enriched, false);
				if (event.payload.bookingId !== this.internalMeeting?.bookingId) break;
				this.qualificationStatus = event.payload.qualificationStatus;
				this.qualificationFields = [...event.payload.qualificationFields];
				if (event.payload.qualificationStatus === "partial") {
					this.setState({
						kind: "qualification",
						bookingOutcome: "committed",
						questionNumber: 2,
						questionCount: 2,
					});
				} else {
					this.setState({
						kind: "complete",
						bookingOutcome: "committed",
						qualificationStatus: event.payload.qualificationStatus,
					});
				}
				break;
			}
			case "error":
				if (this.pendingTypedText !== null) {
					this.pendingTypedText = null;
					this.controller.rejectCommit();
					this.setSnapshot({
						...this.snapshot,
						textSubmission: {
							status: "rejected",
							message: event.payload.retryable
								? "Сообщение не принято. Проверьте связь и отправьте его ещё раз."
								: "Сообщение не принято в текущем состоянии разговора.",
						},
					});
					void this.beginCapture(epoch);
				} else if (event.payload.code === "TTS_UNAVAILABLE") {
					this.textOnlyGenerationPending = this.controller.state.generationId;
					this.controller.setAudioError("Звук ответа сейчас недоступен");
					this.setState(this.activeState("audio-error"));
				} else if (event.payload.code === "STT_UNAVAILABLE") {
					this.setState(this.activeState("error"));
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

	private acceptBookingDraft(
		draft: BrowserBookingDraft,
		requestId: string | null,
		epoch: number,
	): void {
		if (this.bookingDraft && draft.revision <= this.bookingDraft.revision)
			return;
		this.bookingDraft = draft;
		const pending = this.bookingSubmission;
		if (
			pending.status === "details-pending" &&
			requestId === pending.requestId
		) {
			if (isDraftConfirmable(draft)) {
				this.syncBookingSnapshot();
				if (!this.sendBookingConfirmation(draft.revision)) {
					this.bookingSubmission = {
						status: "rejected",
						requestId: pending.requestId,
						message: "Подтверждение пока не отправлено. Повторите попытку.",
						retryable: true,
					};
					this.syncBookingSnapshot();
					void this.beginCapture(epoch);
				}
				return;
			}
			this.bookingSubmission = { status: "idle" };
			this.syncBookingSnapshot();
			void this.beginCapture(epoch);
			return;
		}
		if (
			pending.status === "conflict-resolution-pending" &&
			requestId === pending.requestId
		) {
			this.bookingSubmission = { status: "idle" };
			void this.beginCapture(epoch);
		}
		this.syncBookingSnapshot();
	}

	private acceptBookingRejection(
		event: Extract<ServerWsEvent, { type: "booking.form.rejected" }>,
		epoch: number,
	): void {
		const pending = this.bookingSubmission;
		if (
			pending.status !== "details-pending" &&
			pending.status !== "confirmation-pending" &&
			pending.status !== "conflict-resolution-pending"
		) {
			return;
		}
		if (event.payload.requestId !== pending.requestId) return;
		this.bookingSubmission = {
			status: "rejected",
			requestId: event.payload.requestId,
			message: bookingRejectionMessage(
				event.payload.error.code,
				event.payload.error.retryable,
			),
			retryable: event.payload.error.retryable,
		};
		this.syncBookingSnapshot();
		void this.beginCapture(epoch);
	}

	private acceptInternalMeeting(
		meeting: InternalVirtualMeetingProjection,
		authoritative: boolean,
	): boolean {
		if (
			!authoritative &&
			this.bookingDraft?.bookingId !== null &&
			this.bookingDraft?.bookingId !== undefined &&
			this.bookingDraft.bookingId !== meeting.bookingId
		) {
			return false;
		}
		const current = this.internalMeeting;
		if (!authoritative && current) {
			if (current.bookingId !== meeting.bookingId) return false;
			if (
				new Date(meeting.updatedAt).getTime() <=
				new Date(current.updatedAt).getTime()
			) {
				return false;
			}
		}
		const pending = this.bookingSubmission;
		const formInitiated =
			pending.status === "details-pending" ||
			pending.status === "confirmation-pending" ||
			pending.status === "conflict-resolution-pending";
		const requestId = formInitiated ? pending.requestId : null;
		this.internalMeeting = meeting;
		this.legacyBookingPresentation = false;
		this.qualificationStatus = meeting.qualificationStatus;
		this.qualificationFields = qualificationFieldNames(meeting);
		this.transport?.settleBookingRequest();
		this.bookingSubmission = formInitiated
			? {
					status: "committed",
					requestId,
					bookingId: meeting.bookingId,
				}
			: pending.status === "committed"
				? pending
				: { status: "idle" };
		this.syncBookingSnapshot();
		if (
			this.conversationStage === "BOOKED" ||
			this.conversationStage === "COLLECT_BOOKING"
		) {
			this.setState({ kind: "booked" });
		}
		return true;
	}

	private sendBookingConfirmation(revision: number): boolean {
		const transport = this.transport;
		if (!transport) return false;
		const requestId = this.createRequestId();
		this.suspendCaptureForBooking();
		if (!transport.confirmBookingRevision({ requestId, revision })) {
			void this.beginCapture(this.epoch);
			return false;
		}
		this.bookingSubmission = {
			status: "confirmation-pending",
			requestId,
			revision,
		};
		this.syncBookingSnapshot();
		return true;
	}

	private suspendCaptureForBooking(): void {
		const capture = this.capture;
		this.capture = null;
		this.captureArmed = false;
		this.setCaptureProgress(null);
		if (!capture) return;
		capture.setAccepting(false);
		const previousCleanup = this.captureCleanup;
		this.captureCleanup = Promise.allSettled([
			previousCleanup,
			capture.stop(),
		]).then(() => undefined);
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
				this.beginTerminalFailure();
				break;
			case "COMPLETE":
			case "DECLINED":
				this.setState(
					this.internalMeeting
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
				if (this.internalMeeting) this.setState({ kind: "booked" });
				break;
			case "POST_BOOKING_QUALIFICATION":
				if (this.internalMeeting) {
					const answered = this.qualificationFields.length;
					this.setState({
						kind: "qualification",
						bookingOutcome: "committed",
						...(answered < 2
							? {
									questionNumber: answered === 0 ? 1 : 2,
									questionCount: 2 as const,
								}
							: {}),
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
		if (
			this.snapshot.state.kind === "complete" ||
			this.terminalFailurePending
		) {
			return;
		}
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

	private beginTerminalFailure(): void {
		if (this.terminalFailurePending) return;
		this.terminalFailurePending = true;
		this.captureArmed = false;
		this.captureAttempt += 1;
		this.captureStarting = false;
		this.transport?.disableReconnect();
		const capture = this.capture;
		const playback = this.playback;
		this.capture = null;
		this.playback = null;
		const previousCleanup = this.captureCleanup;
		this.captureCleanup = Promise.allSettled([
			previousCleanup,
			capture?.stop(),
			playback?.dispose(),
		]).then(() => undefined);
		this.setState(this.activeState("error"));
	}

	private async finishTerminalFailure(epoch: number): Promise<void> {
		await this.captureCleanup;
		if (!this.isCurrent(epoch) || !this.terminalFailurePending) return;
		await this.releaseResources("client_error", true);
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
		this.textOnlyGenerationPending = null;
		this.pendingTypedText = null;
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
		this.clientConfig = null;
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
		return this.internalMeeting || this.legacyBookingPresentation
			? { kind, bookingOutcome: "committed" }
			: { kind };
	}

	private setState(state: VoiceUiState): void {
		this.setSnapshot({
			...this.snapshot,
			state,
			captureProgress:
				state.kind === "listening" || state.kind === "qualification"
					? this.snapshot.captureProgress
					: null,
		});
	}

	private resetCaptureProgress(): void {
		const clientConfig = this.clientConfig;
		if (!clientConfig) return;
		this.setCaptureProgress({
			acceptedPcmBytes: 0,
			durationMs: 0,
			maxUtteranceMs: effectiveCaptureDurationMs(clientConfig),
		});
	}

	private setCaptureProgress(progress: VoiceCaptureProgress | null): void {
		if (progress === this.snapshot.captureProgress) return;
		this.setSnapshot({ ...this.snapshot, captureProgress: progress });
	}

	private setSnapshot(snapshot: BrowserVoiceSnapshot): void {
		if (this.disposed) return;
		this.snapshot = {
			...snapshot,
			conversationStage: this.conversationStage,
			textInputAvailable: this.canSubmitTextIn(snapshot.state),
			bookingDraft: this.bookingDraft,
			internalMeeting: this.internalMeeting,
			bookingSubmission: this.bookingSubmission,
			bookingInputAvailable: this.canSubmitBooking(),
		};
		for (const listener of this.listeners) listener();
	}

	private canSubmitTextIn(state: VoiceUiState): boolean {
		if (
			!this.transport?.isReady ||
			this.controller?.hasPendingCommit ||
			this.isBookingRequestPending() ||
			this.pendingTypedText !== null ||
			this.conversationStage === null ||
			this.conversationStage === "IDLE" ||
			this.conversationStage === "CONNECTING" ||
			this.conversationStage === "COMPLETE" ||
			this.conversationStage === "DECLINED" ||
			this.conversationStage === "DISCONNECTED" ||
			this.conversationStage === "ERROR"
		) {
			return false;
		}
		return (
			this.controller?.state.status === "listening" &&
			state.kind !== "permission-denied" &&
			state.kind !== "disconnected" &&
			state.kind !== "reconnecting" &&
			state.kind !== "error" &&
			state.kind !== "complete"
		);
	}

	private canSubmitBooking(): boolean {
		return (
			this.transport?.isReady === true &&
			this.conversationStage === "COLLECT_BOOKING" &&
			this.internalMeeting === null &&
			this.controller?.state.status === "listening" &&
			!this.controller.hasPendingCommit &&
			this.pendingTypedText === null &&
			!this.isBookingRequestPending() &&
			!this.terminalFailurePending
		);
	}

	private isBookingRequestPending(): boolean {
		return (
			this.bookingSubmission.status === "details-pending" ||
			this.bookingSubmission.status === "confirmation-pending" ||
			this.bookingSubmission.status === "conflict-resolution-pending"
		);
	}

	private syncBookingSnapshot(): void {
		this.setSnapshot({ ...this.snapshot });
	}

	private createRequestId(): string {
		return this.factories.createRequestId?.() ?? createUuidV7(this.now());
	}

	private isCurrent(epoch: number): boolean {
		return !this.disposed && this.epoch === epoch;
	}

	private now(): Date {
		return this.factories.now?.() ?? new Date();
	}
}

const DRAFT_FACT_FIELDS = [
	"name",
	"company",
	"workEmail",
	"phone",
	"telegram",
	"monthlyLeadVolume",
	"salesManagerCount",
] as const;

function isDraftConfirmable(draft: BrowserBookingDraft): boolean {
	return (
		draft.readiness === "ready" &&
		draft.commitStatus !== "committed" &&
		DRAFT_FACT_FIELDS.every((field) => draft[field].status !== "conflicted")
	);
}

function bookingSubmissionAfterResync(
	previous: BookingSubmissionState,
	meeting: InternalVirtualMeetingProjection | null,
): BookingSubmissionState {
	if (
		meeting &&
		(previous.status === "details-pending" ||
			previous.status === "confirmation-pending" ||
			previous.status === "conflict-resolution-pending")
	) {
		return {
			status: "committed",
			requestId: previous.requestId,
			bookingId: meeting.bookingId,
		};
	}
	if (
		previous.status === "details-pending" ||
		previous.status === "confirmation-pending" ||
		previous.status === "conflict-resolution-pending"
	) {
		return previous;
	}
	if (
		meeting &&
		previous.status === "committed" &&
		previous.bookingId === meeting.bookingId
	) {
		return previous;
	}
	return { status: "idle" };
}

function meetingMatchesDraft(
	meeting: InternalVirtualMeetingProjection | null,
	draft: BrowserBookingDraft | null,
): boolean {
	return (
		meeting === null ||
		draft?.bookingId === null ||
		draft?.bookingId === undefined ||
		draft.bookingId === meeting.bookingId
	);
}

function bookingRejectionMessage(code: string, retryable: boolean): string {
	const messages: Record<string, string> = {
		INVALID_REVISION:
			"Данные на сервере обновились. Проверьте форму и повторите.",
		INVALID_DETAILS: "Проверьте заполненные данные и повторите.",
		MISSING_REQUIRED_FIELD:
			"Заполните имя, компанию, рабочий email и телефон или Telegram.",
		CONFLICT_REQUIRES_RESOLUTION:
			"Сначала выберите верное значение в отмеченном поле.",
		CANDIDATE_MISMATCH: "Варианты времени изменились. Выберите время заново.",
		NOT_READY: "Проверьте обязательные поля и выбранное время.",
		ALREADY_COMMITTED: "Запрос уже обработан. Дождитесь обновления разговора.",
	};
	return (
		messages[code] ??
		(retryable
			? "Запрос временно не принят. Проверьте данные и повторите."
			: "Запрос не принят в текущем состоянии разговора.")
	);
}

function qualificationFieldNames(
	meeting: InternalVirtualMeetingProjection | null,
): QualificationField[] {
	if (!meeting) return [];
	const fields: QualificationField[] = [];
	if (meeting.qualificationFields.monthlyLeadVolume !== null) {
		fields.push("monthlyLeadVolume");
	}
	if (meeting.qualificationFields.salesManagerCount !== null) {
		fields.push("salesManagerCount");
	}
	return fields;
}

function projectionFromEventPayload(
	payload: unknown,
): InternalVirtualMeetingProjection | null {
	if (!payload || typeof payload !== "object") return null;
	const enriched = payload as {
		internalMeeting?: unknown;
		meeting?: unknown;
	};
	const result = InternalVirtualMeetingProjectionSchema.safeParse(
		enriched.internalMeeting ?? enriched.meeting,
	);
	return result.success ? result.data : null;
}

let fallbackRequestCounter = 0;

function createUuidV7(now: Date): string {
	const bytes = new Uint8Array(16);
	const cryptoApi = globalThis.crypto;
	if (cryptoApi?.getRandomValues) {
		cryptoApi.getRandomValues(bytes);
	} else {
		fallbackRequestCounter = (fallbackRequestCounter + 1) >>> 0;
		let seed = now.getTime() ^ fallbackRequestCounter ^ 0x9e3779b9;
		for (let index = 0; index < bytes.length; index += 1) {
			seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
			bytes[index] = seed & 0xff;
		}
	}
	let timestamp = now.getTime();
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = timestamp & 0xff;
		timestamp = Math.floor(timestamp / 256);
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function sameAudioClientConfig(
	left: AudioClientConfig | null,
	right: AudioClientConfig,
): boolean {
	return (
		left !== null &&
		left.inputSampleRate === right.inputSampleRate &&
		left.inputEncoding === right.inputEncoding &&
		left.chunkMs === right.chunkMs &&
		left.maxUtteranceMs === right.maxUtteranceMs &&
		left.maxPcmBytes === right.maxPcmBytes &&
		left.outputContentType === right.outputContentType &&
		left.outputMode === right.outputMode
	);
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
				acceptingInitially: false,
				onFrame: options.onFrame,
				onProgress: options.onProgress,
				onLimit: options.onLimit,
			}),
		createPlayback: (options) =>
			new PhrasePlaybackQueue(createBrowserAudioPlaybackApis(), options),
	});
}
