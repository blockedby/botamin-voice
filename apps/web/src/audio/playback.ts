import {
	type AudioSegmentMetadata,
	LOCAL_REACTION_DELAY_MAX_MS,
	LOCAL_REACTION_DELAY_MIN_MS,
	type LocalReactionClipId,
	MpegAudioBytesSchema,
} from "@botamin/contracts";
import {
	REACTION_CLIP_MANIFEST,
	type ReactionClipManifestEntry,
} from "./reactionClipManifest";

export interface PlaybackSourceLike {
	onended: (() => void) | null;
	start(when: number): void;
	stop(): void;
}

export interface AudioPlaybackApis<TDecoded = unknown> {
	decodeAudioData(bytes: ArrayBuffer): Promise<TDecoded>;
	createSource(buffer: TDecoded): PlaybackSourceLike;
	resume(): Promise<void>;
	currentTime(): number;
	duration(buffer: TDecoded): number;
	close?(): Promise<void>;
}

export interface CompletePlaybackSegment extends AudioSegmentMetadata {
	bytes: Uint8Array;
}

export interface LocalReactionRequest {
	turnId: string;
	generationId: string;
	clipId: LocalReactionClipId;
	delayMs: number;
}

export interface ReactionFetchResponseLike {
	readonly ok: boolean;
	readonly status: number;
	readonly headers?: { get(name: string): string | null };
	readonly body?: {
		getReader(): {
			read(): Promise<
				{ done: true; value?: undefined } | { done: false; value: Uint8Array }
			>;
			cancel?(): Promise<void>;
		};
	} | null;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export type ReactionFetchLike = (
	input: string,
	init: RequestInit,
) => Promise<ReactionFetchResponseLike>;

export interface PlaybackScheduler {
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export interface LocalReactionPlaybackOptions {
	fetch: ReactionFetchLike;
	scheduler?: PlaybackScheduler;
	createAbortController?: () => AbortController;
}

export type PlaybackEnqueueRejection =
	| "stale"
	| "invalid"
	| "overflow"
	| "decode-error"
	| "playback-error";

export type PlaybackEnqueueOutcome =
	| { status: "accepted" }
	| {
			status: "rejected";
			reason: PlaybackEnqueueRejection;
			error: Error;
	  };

type QueueSlot<TDecoded> =
	| DecodingSlot
	| DecodedSlot<TDecoded>
	| ScheduledSlot<TDecoded>;

interface SlotBase {
	segment: CompletePlaybackSegment;
	epoch: number;
	resolve: (outcome: PlaybackEnqueueOutcome) => void;
}

interface DecodingSlot extends SlotBase {
	phase: "decoding";
}

interface DecodedSlot<TDecoded> extends SlotBase {
	phase: "decoded";
	decoded: TDecoded;
}

interface ScheduledSlot<TDecoded> extends SlotBase {
	phase: "scheduled";
	decoded: TDecoded;
	source: PlaybackSourceLike;
	startTime: number;
	endTime: number;
}

interface HandoffSlot {
	segment: CompletePlaybackSegment;
	epoch: number;
	resolve: (outcome: PlaybackEnqueueOutcome) => void;
}

const ACCEPTED = { status: "accepted" } as const;
const REACTION_CLIPS = new Map<LocalReactionClipId, ReactionClipManifestEntry>(
	REACTION_CLIP_MANIFEST.map((clip) => [clip.id, clip]),
);
const browserPlaybackScheduler: PlaybackScheduler = {
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Ordered complete-MP3 player with a fixed capacity: one current slot, one
 * decoded/decoding/scheduled prefetch slot, and one raw transport handoff.
 */
export class PhrasePlaybackQueue<TDecoded = unknown> {
	private generationId: string | null = null;
	private lastAcceptedSequence: number | null = null;
	private current: QueueSlot<TDecoded> | null = null;
	private prefetch: QueueSlot<TDecoded> | null = null;
	private handoff: HandoffSlot | null = null;
	private epoch = 0;
	private muted = false;
	private sealed = false;
	private started = false;
	private idleNotified = false;
	private reactionEpoch = 0;
	private reactionTimer: unknown = null;
	private reactionAbortController: AbortController | null = null;
	private reactionSource: PlaybackSourceLike | null = null;
	private reactionGenerationId: string | null = null;
	private readonly seenReactionTurns = new Set<string>();
	private readonly reactionScheduler: PlaybackScheduler;

	constructor(
		private readonly apis: AudioPlaybackApis<TDecoded>,
		private readonly callbacks: {
			onStarted?(segment: CompletePlaybackSegment): void;
			onIdle?(generationId: string): void;
			onError?(
				error: Error,
				segment: CompletePlaybackSegment,
				reason: Exclude<PlaybackEnqueueRejection, "stale">,
			): void;
		} = {},
		private readonly reactionOptions?: LocalReactionPlaybackOptions,
	) {
		this.reactionScheduler =
			reactionOptions?.scheduler ?? browserPlaybackScheduler;
	}

	resume(): Promise<void> {
		return this.apis.resume();
	}

	beginGeneration(generationId: string): void {
		this.cancelReaction();
		if (generationId === this.generationId) return;
		this.clearSlots();
		this.generationId = generationId;
		this.lastAcceptedSequence = null;
		this.sealed = false;
		this.started = false;
		this.idleNotified = false;
	}

	enqueue(segment: CompletePlaybackSegment): Promise<PlaybackEnqueueOutcome> {
		this.cancelReaction();
		if (
			this.muted ||
			this.generationId === null ||
			segment.generationId !== this.generationId
		) {
			return Promise.resolve(rejected("stale", "Audio segment is stale"));
		}
		if (!this.isValid(segment) || this.sealed) {
			return Promise.resolve(
				this.fail(
					"invalid",
					new Error("Complete audio segment is invalid"),
					segment,
				),
			);
		}
		if (
			this.lastAcceptedSequence !== null &&
			segment.sequence <= this.lastAcceptedSequence
		) {
			return Promise.resolve(
				this.fail(
					"invalid",
					new Error("Audio segment sequence is not monotonic"),
					segment,
				),
			);
		}
		if (this.current && this.prefetch && this.handoff) {
			return Promise.resolve(
				this.fail(
					"overflow",
					new Error("Audio playback queue capacity exceeded"),
					segment,
				),
			);
		}

		const isolated: CompletePlaybackSegment = {
			...segment,
			bytes: segment.bytes.slice(),
		};
		this.lastAcceptedSequence = isolated.sequence;
		const epoch = this.epoch;
		return new Promise<PlaybackEnqueueOutcome>((resolve) => {
			if (this.current && this.prefetch) {
				this.handoff = { segment: isolated, epoch, resolve };
				return;
			}
			this.reserveDecode(isolated, epoch, resolve);
		});
	}

	sealGeneration(generationId: string): boolean {
		if (generationId !== this.generationId) return false;
		this.sealed = true;
		this.maybeIdle();
		return true;
	}

	requestReaction(request: LocalReactionRequest): boolean {
		const clip = REACTION_CLIPS.get(request.clipId);
		if (
			!this.reactionOptions ||
			this.muted ||
			this.seenReactionTurns.has(request.turnId) ||
			!clip ||
			request.delayMs < LOCAL_REACTION_DELAY_MIN_MS ||
			request.delayMs > LOCAL_REACTION_DELAY_MAX_MS ||
			!Number.isInteger(request.delayMs)
		) {
			return false;
		}
		if (this.generationId !== null) {
			if (
				!this.sealed ||
				!this.idleNotified ||
				this.current !== null ||
				this.prefetch !== null ||
				this.handoff !== null
			) {
				return false;
			}
			this.generationId = null;
			this.lastAcceptedSequence = null;
			this.sealed = false;
			this.started = false;
			this.idleNotified = false;
		}
		rememberBounded(this.seenReactionTurns, request.turnId);
		this.cancelReaction();
		const epoch = this.reactionEpoch;
		this.reactionGenerationId = request.generationId;
		this.reactionTimer = this.reactionScheduler.schedule(() => {
			if (epoch !== this.reactionEpoch) return;
			this.reactionTimer = null;
			void this.startReaction(clip, request.generationId, epoch);
		}, request.delayMs);
		return true;
	}

	/** Synchronously fences timers/fetch/decode and stops a started decoration. */
	cancelReaction(): void {
		this.reactionEpoch += 1;
		if (this.reactionTimer !== null) {
			this.reactionScheduler.cancel(this.reactionTimer);
			this.reactionTimer = null;
		}
		this.reactionAbortController?.abort("reaction cancelled");
		this.reactionAbortController = null;
		const source = this.reactionSource;
		this.reactionSource = null;
		this.reactionGenerationId = null;
		if (source) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// It may have ended between the fence and synchronous stop.
			}
		}
	}

	/** Immediate local barge-in: stop, clear, and make the generation stale. */
	bargeIn(): string | null {
		this.cancelReaction();
		const interrupted = this.generationId;
		this.clearSlots();
		this.generationId = null;
		this.lastAcceptedSequence = null;
		this.sealed = false;
		return interrupted;
	}

	setMuted(muted: boolean): void {
		if (this.muted === muted) return;
		this.muted = muted;
		if (muted) this.bargeIn();
	}

	async dispose(): Promise<void> {
		this.bargeIn();
		await this.apis.close?.();
	}

	get activeGenerationId(): string | null {
		return this.generationId;
	}

	get bufferedSegmentCount(): number {
		return (this.current ? 1 : 0) + (this.prefetch ? 1 : 0);
	}

	/** Raw transport handoff is separate from the two decode/source slots. */
	get pendingHandoffCount(): number {
		return this.handoff === null ? 0 : 1;
	}

	get activeReactionGenerationId(): string | null {
		return this.reactionGenerationId;
	}

	private async startReaction(
		clip: ReactionClipManifestEntry,
		generationId: string,
		epoch: number,
	): Promise<void> {
		const options = this.reactionOptions;
		if (
			!options ||
			epoch !== this.reactionEpoch ||
			this.reactionGenerationId !== generationId ||
			this.generationId !== null ||
			this.muted
		) {
			return;
		}
		const abortController =
			options.createAbortController?.() ?? new AbortController();
		this.reactionAbortController = abortController;
		try {
			const response = await options.fetch(clip.path, {
				method: "GET",
				credentials: "same-origin",
				mode: "same-origin",
				redirect: "error",
				cache: "force-cache",
				signal: abortController.signal,
			});
			if (!response.ok) return;
			const bytes = await readBoundedReactionBytes(
				response,
				clip.maxBytes,
				abortController,
			);
			if (
				epoch !== this.reactionEpoch ||
				this.reactionGenerationId !== generationId ||
				this.generationId !== null ||
				this.muted ||
				!MpegAudioBytesSchema.safeParse(bytes).success
			) {
				return;
			}
			const decoded = await this.apis.decodeAudioData(bytes.buffer);
			if (
				epoch !== this.reactionEpoch ||
				this.reactionGenerationId !== generationId ||
				this.generationId !== null ||
				this.muted
			) {
				return;
			}
			const duration = this.apis.duration(decoded);
			if (
				!Number.isFinite(duration) ||
				duration <= 0 ||
				duration * 1_000 > clip.maxDurationMs
			) {
				return;
			}
			const source = this.apis.createSource(decoded);
			if (
				epoch !== this.reactionEpoch ||
				this.reactionGenerationId !== generationId ||
				this.generationId !== null ||
				this.muted
			) {
				try {
					source.stop();
				} catch {
					// The source was never started.
				}
				return;
			}
			this.reactionSource = source;
			source.onended = () => {
				if (epoch !== this.reactionEpoch || this.reactionSource !== source)
					return;
				this.reactionSource = null;
				this.reactionGenerationId = null;
			};
			source.start(Math.max(this.apis.currentTime(), 0));
		} catch {
			// Decorative playback failure never affects dynamic text or audio.
			if (epoch === this.reactionEpoch) this.cancelReaction();
		} finally {
			if (this.reactionAbortController === abortController) {
				this.reactionAbortController = null;
			}
			if (epoch === this.reactionEpoch && this.reactionSource === null) {
				this.reactionGenerationId = null;
			}
		}
	}

	private isValid(segment: CompletePlaybackSegment): boolean {
		return (
			segment.contentType === "audio/mpeg" &&
			segment.final === true &&
			Number.isSafeInteger(segment.sequence) &&
			segment.sequence >= 0 &&
			segment.byteLength === segment.bytes.byteLength &&
			MpegAudioBytesSchema.safeParse(segment.bytes).success
		);
	}

	private reserveDecode(
		segment: CompletePlaybackSegment,
		epoch: number,
		resolve: (outcome: PlaybackEnqueueOutcome) => void,
	): void {
		const slot: DecodingSlot = {
			phase: "decoding",
			segment,
			epoch,
			resolve,
		};
		if (!this.current) this.current = slot;
		else this.prefetch = slot;
		void this.decode(slot);
	}

	private async decode(slot: DecodingSlot): Promise<void> {
		try {
			const exactBytes = slot.segment.bytes.slice();
			const decoded = await this.apis.decodeAudioData(exactBytes.buffer);
			if (!this.isCurrentSlot(slot)) {
				slot.resolve(
					rejected("stale", "Audio decode completed after cancellation"),
				);
				return;
			}
			const decodedSlot: DecodedSlot<TDecoded> = {
				...slot,
				phase: "decoded",
				decoded,
			};
			if (this.current === slot) this.current = decodedSlot;
			else this.prefetch = decodedSlot;
			this.scheduleReady();
		} catch (error) {
			if (!this.isCurrentSlot(slot)) {
				slot.resolve(
					rejected("stale", "Audio decode failed after cancellation"),
				);
				return;
			}
			const failure = toError(error, "Audio decode failed");
			slot.resolve(rejected("decode-error", failure));
			this.removeSlot(slot);
			this.fail("decode-error", failure, slot.segment);
		}
	}

	private scheduleReady(): void {
		if (this.current?.phase === "decoded") {
			if (!this.schedule(this.current, Math.max(this.apis.currentTime(), 0))) {
				return;
			}
		}
		if (
			this.current?.phase === "scheduled" &&
			this.prefetch?.phase === "decoded"
		) {
			this.schedule(
				this.prefetch,
				Math.max(this.current.endTime, this.apis.currentTime()),
			);
		}
	}

	private schedule(slot: DecodedSlot<TDecoded>, startTime: number): boolean {
		if (!this.isCurrentSlot(slot)) {
			slot.resolve(rejected("stale", "Audio scheduling was cancelled"));
			return false;
		}
		let source: PlaybackSourceLike | null = null;
		try {
			const duration = this.apis.duration(slot.decoded);
			if (!Number.isFinite(duration) || duration <= 0) {
				throw new Error("Decoded audio duration is invalid");
			}
			source = this.apis.createSource(slot.decoded);
			const scheduled: ScheduledSlot<TDecoded> = {
				...slot,
				phase: "scheduled",
				source,
				startTime,
				endTime: startTime + duration,
			};
			if (this.current === slot) this.current = scheduled;
			else this.prefetch = scheduled;
			source.onended = () => this.handleEnded(scheduled);
			source.start(startTime);
			slot.resolve(ACCEPTED);
			if (!this.started) {
				this.started = true;
				this.callbacks.onStarted?.(slot.segment);
			}
			return true;
		} catch (error) {
			if (source) {
				source.onended = null;
				try {
					source.stop();
				} catch {
					// The source may not have reached a startable state.
				}
			}
			const failure = toError(error, "Audio playback failed");
			slot.resolve(rejected("playback-error", failure));
			this.removeSlot(slot);
			this.fail("playback-error", failure, slot.segment);
			return false;
		}
	}

	private handleEnded(slot: ScheduledSlot<TDecoded>): void {
		if (!this.isCurrentSlot(slot)) return;
		if (this.current === slot) {
			this.current = this.prefetch;
			this.prefetch = null;
		} else {
			this.prefetch = null;
		}
		this.drainHandoff();
		this.scheduleReady();
		this.maybeIdle();
	}

	private drainHandoff(): void {
		const handoff = this.handoff;
		if (!handoff || handoff.epoch !== this.epoch) return;
		if (this.current && this.prefetch) return;
		this.handoff = null;
		this.reserveDecode(handoff.segment, handoff.epoch, handoff.resolve);
	}

	private isCurrentSlot(slot: SlotBase): boolean {
		return (
			slot.epoch === this.epoch &&
			!this.muted &&
			this.generationId === slot.segment.generationId &&
			(this.current === slot || this.prefetch === slot)
		);
	}

	private removeSlot(slot: SlotBase): void {
		if (this.current === slot) {
			this.current = this.prefetch;
			this.prefetch = null;
		} else if (this.prefetch === slot) {
			this.prefetch = null;
		}
	}

	private maybeIdle(): void {
		if (
			!this.sealed ||
			this.idleNotified ||
			this.current ||
			this.prefetch ||
			this.handoff ||
			!this.generationId
		) {
			return;
		}
		this.idleNotified = true;
		this.callbacks.onIdle?.(this.generationId);
	}

	private fail(
		reason: Exclude<PlaybackEnqueueRejection, "stale">,
		error: Error,
		segment: CompletePlaybackSegment,
	): PlaybackEnqueueOutcome {
		this.clearSlots();
		this.generationId = null;
		this.lastAcceptedSequence = null;
		this.sealed = false;
		this.callbacks.onError?.(error, segment, reason);
		return rejected(reason, error);
	}

	private clearSlots(): void {
		this.epoch += 1;
		const slots = [this.current, this.prefetch];
		const handoff = this.handoff;
		this.current = null;
		this.prefetch = null;
		this.handoff = null;
		for (const slot of slots) {
			if (!slot) continue;
			if (slot.phase === "scheduled") {
				slot.source.onended = null;
				try {
					slot.source.stop();
				} catch {
					// A source may already have ended; cancellation is still complete.
				}
			}
			slot.resolve(rejected("stale", "Audio playback was cancelled"));
		}
		handoff?.resolve(rejected("stale", "Audio handoff was cancelled"));
	}
}

async function readBoundedReactionBytes(
	response: ReactionFetchResponseLike,
	maxBytes: number,
	abortController: AbortController,
): Promise<Uint8Array<ArrayBuffer>> {
	const declaredLength = response.headers?.get("content-length");
	if (declaredLength !== undefined && declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maxBytes) {
			throw new Error("Reaction asset length is invalid");
		}
	}
	if (response.body) {
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			if (
				!(result.value instanceof Uint8Array) ||
				result.value.byteLength === 0
			) {
				throw new Error("Reaction asset stream is invalid");
			}
			total += result.value.byteLength;
			if (total > maxBytes) {
				abortController.abort("reaction asset too large");
				await reader.cancel?.().catch(() => undefined);
				throw new Error("Reaction asset is too large");
			}
			chunks.push(result.value.slice());
		}
		if (total === 0) throw new Error("Reaction asset is empty");
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
		throw new Error("Reaction asset length is invalid");
	}
	return new Uint8Array(buffer.slice(0));
}

function rememberBounded(values: Set<string>, value: string): void {
	values.add(value);
	if (values.size <= 256) return;
	const oldest = values.values().next().value;
	if (oldest !== undefined) values.delete(oldest);
}

function rejected(
	reason: PlaybackEnqueueRejection,
	error: Error | string,
): PlaybackEnqueueOutcome {
	return {
		status: "rejected",
		reason,
		error: typeof error === "string" ? new Error(error) : error,
	};
}

function toError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback);
}

export function createBrowserAudioPlaybackApis(): AudioPlaybackApis<AudioBuffer> {
	if (
		typeof window === "undefined" ||
		typeof window.AudioContext !== "function"
	) {
		throw new Error("Web Audio playback is unavailable");
	}
	const context = new window.AudioContext();
	return {
		decodeAudioData: (bytes) => context.decodeAudioData(bytes),
		createSource: (buffer) => {
			const source = context.createBufferSource();
			source.buffer = buffer;
			source.connect(context.destination);
			const wrapper: PlaybackSourceLike = {
				onended: null,
				start: (when) => source.start(when),
				stop: () => source.stop(),
			};
			source.onended = () => wrapper.onended?.();
			return wrapper;
		},
		resume: () => context.resume(),
		currentTime: () => context.currentTime,
		duration: (buffer) => buffer.duration,
		close: () => context.close(),
	};
}
