import {
	type AudioSegmentMetadata,
	MpegAudioBytesSchema,
} from "@botamin/contracts";

export interface PlaybackSourceLike {
	onended: (() => void) | null;
	start(): void;
	stop(): void;
}

export interface AudioPlaybackApis<TDecoded = unknown> {
	decodeAudioData(bytes: ArrayBuffer): Promise<TDecoded>;
	createSource(buffer: TDecoded): PlaybackSourceLike;
	close?(): Promise<void>;
}

export interface CompletePlaybackSegment extends AudioSegmentMetadata {
	bytes: Uint8Array;
}

interface DecodedSlot<TDecoded> {
	segment: CompletePlaybackSegment;
	decoded: TDecoded;
}

interface PlayingSlot<TDecoded> extends DecodedSlot<TDecoded> {
	source: PlaybackSourceLike;
}

/**
 * Ordered complete-MP3 player. Capacity is strictly one playing/starting slot
 * and one decoded/decoding prefetch slot; excess input is rejected for
 * upstream backpressure rather than buffered without a bound.
 */
export class PhrasePlaybackQueue<TDecoded = unknown> {
	private generationId: string | null = null;
	private lastAcceptedSequence: number | null = null;
	private playing: PlayingSlot<TDecoded> | null = null;
	private starting: CompletePlaybackSegment | null = null;
	private prefetched: DecodedSlot<TDecoded> | null = null;
	private prefetching: CompletePlaybackSegment | null = null;
	private epoch = 0;
	private muted = false;

	constructor(
		private readonly apis: AudioPlaybackApis<TDecoded>,
		private readonly callbacks: {
			onStarted?(segment: CompletePlaybackSegment): void;
			onIdle?(generationId: string): void;
			onError?(error: Error, segment: CompletePlaybackSegment): void;
		} = {},
	) {}

	beginGeneration(generationId: string): void {
		if (generationId === this.generationId) return;
		this.clearSlots();
		this.generationId = generationId;
		this.lastAcceptedSequence = null;
	}

	async enqueue(segment: CompletePlaybackSegment): Promise<boolean> {
		if (
			this.muted ||
			this.generationId === null ||
			segment.generationId !== this.generationId ||
			segment.contentType !== "audio/mpeg" ||
			segment.final !== true ||
			!Number.isSafeInteger(segment.sequence) ||
			segment.sequence < 0 ||
			segment.byteLength !== segment.bytes.byteLength
		) {
			return false;
		}
		if (!MpegAudioBytesSchema.safeParse(segment.bytes).success) {
			this.fail(new Error("Complete audio segment is not valid MP3"), segment);
			return false;
		}

		if (
			this.lastAcceptedSequence !== null &&
			segment.sequence <= this.lastAcceptedSequence
		) {
			return false;
		}

		const playingOccupied = this.playing !== null || this.starting !== null;
		const prefetchOccupied =
			this.prefetched !== null || this.prefetching !== null;
		if (playingOccupied && prefetchOccupied) return false;

		const isolated: CompletePlaybackSegment = {
			...segment,
			bytes: segment.bytes.slice(),
		};
		this.lastAcceptedSequence = segment.sequence;
		const epoch = this.epoch;

		if (!playingOccupied) {
			this.starting = isolated;
			try {
				const decoded = await this.decode(isolated);
				if (!this.isCurrent(isolated, epoch) || this.starting !== isolated) {
					return false;
				}
				this.starting = null;
				return this.startPlaying({ segment: isolated, decoded }, epoch);
			} catch (error) {
				if (this.isCurrent(isolated, epoch))
					this.fail(toError(error), isolated);
				return false;
			}
		}

		this.prefetching = isolated;
		try {
			const decoded = await this.decode(isolated);
			if (!this.isCurrent(isolated, epoch) || this.prefetching !== isolated) {
				return false;
			}
			this.prefetching = null;
			this.prefetched = { segment: isolated, decoded };
			return true;
		} catch (error) {
			if (this.isCurrent(isolated, epoch)) this.fail(toError(error), isolated);
			return false;
		}
	}

	/** Immediate local barge-in: stop, clear, and make the generation stale. */
	bargeIn(): string | null {
		const interrupted = this.generationId;
		this.clearSlots();
		this.generationId = null;
		this.lastAcceptedSequence = null;
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
		return (
			(this.playing || this.starting ? 1 : 0) +
			(this.prefetched || this.prefetching ? 1 : 0)
		);
	}

	private async decode(segment: CompletePlaybackSegment): Promise<TDecoded> {
		const exactBytes = segment.bytes.slice();
		return this.apis.decodeAudioData(exactBytes.buffer);
	}

	private startPlaying(slot: DecodedSlot<TDecoded>, epoch: number): boolean {
		if (!this.isCurrent(slot.segment, epoch)) return false;
		try {
			const source = this.apis.createSource(slot.decoded);
			const playing: PlayingSlot<TDecoded> = { ...slot, source };
			this.playing = playing;
			source.onended = () => this.handleEnded(playing, epoch);
			source.start();
			this.callbacks.onStarted?.(slot.segment);
			return true;
		} catch (error) {
			this.fail(toError(error), slot.segment);
			return false;
		}
	}

	private handleEnded(slot: PlayingSlot<TDecoded>, epoch: number): void {
		if (this.playing !== slot) return;
		this.playing = null;
		if (!this.isCurrent(slot.segment, epoch)) return;
		const next = this.prefetched;
		if (next) {
			this.prefetched = null;
			this.startPlaying(next, epoch);
			return;
		}
		if (this.generationId) this.callbacks.onIdle?.(this.generationId);
	}

	private isCurrent(segment: CompletePlaybackSegment, epoch: number): boolean {
		return (
			epoch === this.epoch &&
			!this.muted &&
			this.generationId === segment.generationId
		);
	}

	private fail(error: Error, segment: CompletePlaybackSegment): void {
		this.callbacks.onError?.(error, segment);
		this.clearSlots();
		this.generationId = null;
		this.lastAcceptedSequence = null;
	}

	private clearSlots(): void {
		this.epoch += 1;
		const source = this.playing?.source;
		this.playing = null;
		this.starting = null;
		this.prefetched = null;
		this.prefetching = null;
		if (source) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// A source may already have ended; local cancellation is still complete.
			}
		}
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Audio playback failed");
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
				start: () => source.start(),
				stop: () => source.stop(),
			};
			source.onended = () => wrapper.onended?.();
			return wrapper;
		},
		close: () => context.close(),
	};
}
