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

interface HandoffSlot {
	segment: CompletePlaybackSegment;
	epoch: number;
	resolve(accepted: boolean): void;
}

/**
 * Ordered complete-MP3 player. Capacity is strictly one playing/starting slot,
 * one decoded/decoding prefetch slot, and one raw awaitable transport handoff;
 * further input is rejected instead of growing the decoded queue.
 */
export class PhrasePlaybackQueue<TDecoded = unknown> {
	private generationId: string | null = null;
	private lastAcceptedSequence: number | null = null;
	private playing: PlayingSlot<TDecoded> | null = null;
	private starting: CompletePlaybackSegment | null = null;
	private prefetched: DecodedSlot<TDecoded> | null = null;
	private prefetching: CompletePlaybackSegment | null = null;
	private handoff: HandoffSlot | null = null;
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
		if (playingOccupied && prefetchOccupied && this.handoff !== null) {
			return false;
		}

		const isolated: CompletePlaybackSegment = {
			...segment,
			bytes: segment.bytes.slice(),
		};
		this.lastAcceptedSequence = segment.sequence;
		const epoch = this.epoch;

		if (playingOccupied && prefetchOccupied) {
			return new Promise<boolean>((resolve) => {
				this.handoff = { segment: isolated, epoch, resolve };
			});
		}
		if (!playingOccupied) {
			this.starting = isolated;
		} else {
			this.prefetching = isolated;
		}
		return this.decodeReserved(isolated, epoch);
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

	/** Raw transport handoff is separate from the two decoded/decoding slots. */
	get pendingHandoffCount(): number {
		return this.handoff === null ? 0 : 1;
	}

	private async decode(segment: CompletePlaybackSegment): Promise<TDecoded> {
		const exactBytes = segment.bytes.slice();
		return this.apis.decodeAudioData(exactBytes.buffer);
	}

	private async decodeReserved(
		segment: CompletePlaybackSegment,
		epoch: number,
	): Promise<boolean> {
		try {
			const decoded = await this.decode(segment);
			if (!this.isCurrent(segment, epoch)) return false;

			if (this.starting === segment) {
				this.starting = null;
				const started = this.startPlaying({ segment, decoded }, epoch);
				if (started) this.drainHandoff();
				return started;
			}
			if (this.prefetching !== segment) return false;

			this.prefetching = null;
			if (this.playing === null && this.starting === null) {
				const started = this.startPlaying({ segment, decoded }, epoch);
				if (started) this.drainHandoff();
				return started;
			}
			this.prefetched = { segment, decoded };
			return true;
		} catch (error) {
			if (
				this.isCurrent(segment, epoch) &&
				(this.starting === segment || this.prefetching === segment)
			) {
				this.fail(toError(error), segment);
			}
			return false;
		}
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

		if (this.prefetched) {
			const next = this.prefetched;
			this.prefetched = null;
			if (!this.startPlaying(next, epoch)) return;
		} else if (this.prefetching) {
			// Reserve the newly empty playing slot for the earlier pending decode.
			this.starting = this.prefetching;
			this.prefetching = null;
		}
		this.drainHandoff();
		if (
			this.playing === null &&
			this.starting === null &&
			this.prefetched === null &&
			this.prefetching === null &&
			this.handoff === null &&
			this.generationId
		) {
			this.callbacks.onIdle?.(this.generationId);
		}
	}

	private drainHandoff(): void {
		const handoff = this.handoff;
		if (!handoff || handoff.epoch !== this.epoch) return;
		const playingOccupied = this.playing !== null || this.starting !== null;
		const prefetchOccupied =
			this.prefetched !== null || this.prefetching !== null;
		if (playingOccupied && prefetchOccupied) return;

		this.handoff = null;
		if (!playingOccupied) {
			this.starting = handoff.segment;
		} else {
			this.prefetching = handoff.segment;
		}
		void this.decodeReserved(handoff.segment, handoff.epoch).then(
			handoff.resolve,
		);
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
		const handoff = this.handoff;
		this.playing = null;
		this.starting = null;
		this.prefetched = null;
		this.prefetching = null;
		this.handoff = null;
		handoff?.resolve(false);
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
