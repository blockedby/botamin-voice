import {
	float32ToPcm16,
	PCM16_BYTES_PER_SAMPLE,
	Pcm16FrameBatcher,
	pcm16Bytes,
	TARGET_SAMPLE_RATE,
} from "./pcm";
import { StreamingLinearResampler } from "./resampler";

export type CaptureLimitReason = "duration" | "bytes";

export interface CaptureTrackLike {
	enabled: boolean;
	stop(): void;
}

export interface CaptureStreamLike {
	getTracks(): CaptureTrackLike[];
}

export interface CaptureSourceLike {
	connect(node: CaptureWorkletNodeLike): void;
	disconnect(): void;
}

export interface CaptureMessagePortLike {
	onmessage: ((event: { data: unknown }) => void) | null;
}

export interface CaptureWorkletNodeLike {
	readonly port: CaptureMessagePortLike;
	disconnect(): void;
}

export interface CaptureAudioContextLike {
	readonly sampleRate: number;
	readonly audioWorklet?: { addModule(url: string): Promise<void> };
	createMediaStreamSource(stream: CaptureStreamLike): CaptureSourceLike;
	resume?(): Promise<void>;
	close(): Promise<void>;
}

export interface AudioCaptureApis {
	getUserMedia(constraints: MediaStreamConstraints): Promise<CaptureStreamLike>;
	createAudioContext(options: AudioContextOptions): CaptureAudioContextLike;
	createWorkletNode(
		context: CaptureAudioContextLike,
		name: string,
		options: AudioWorkletNodeOptions,
	): CaptureWorkletNodeLike;
	createWorkletModuleUrl(source: string): string;
	revokeWorkletModuleUrl(url: string): void;
}

export interface AudioCaptureOptions {
	apis: AudioCaptureApis;
	maxDurationMs?: number;
	maxBytes?: number;
	onFrame(frame: Uint8Array): void;
	onLimit?(reason: CaptureLimitReason): void;
}

export interface CaptureStats {
	bytes: number;
	durationMs: number;
	limitedBy: CaptureLimitReason | null;
}

export const AUDIO_WORKLET_PROCESSOR_NAME = "botamin-pcm-capture";
export const AUDIO_WORKLET_SOURCE = `
class BotaminPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const mono = new Float32Array(channels[0].length);
    for (let channel = 0; channel < channels.length; channel += 1) {
      const values = channels[channel];
      for (let index = 0; index < mono.length; index += 1) mono[index] += values[index] / channels.length;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}
registerProcessor("${AUDIO_WORKLET_PROCESSOR_NAME}", BotaminPcmCapture);
`;

const DEFAULT_MAX_DURATION_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_000_000;

/** Byte/sample accounting guard; it never retains the utterance itself. */
export class PcmUtteranceBudget {
	readonly maxDurationMs: number;
	readonly maxBytes: number;
	readonly capacityBytes: number;
	readonly limitingReason: CaptureLimitReason;
	private acceptedBytes = 0;

	constructor(
		maxDurationMs = DEFAULT_MAX_DURATION_MS,
		maxBytes = DEFAULT_MAX_BYTES,
	) {
		if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
			throw new RangeError("Maximum utterance duration must be positive");
		}
		if (!Number.isSafeInteger(maxBytes) || maxBytes < PCM16_BYTES_PER_SAMPLE) {
			throw new RangeError(
				"Maximum utterance bytes must be a positive safe integer",
			);
		}
		this.maxDurationMs = maxDurationMs;
		this.maxBytes = maxBytes;
		const durationBytes =
			Math.floor((maxDurationMs * TARGET_SAMPLE_RATE) / 1_000) *
			PCM16_BYTES_PER_SAMPLE;
		const alignedMaxBytes = maxBytes - (maxBytes % PCM16_BYTES_PER_SAMPLE);
		this.capacityBytes = Math.min(durationBytes, alignedMaxBytes);
		this.limitingReason =
			alignedMaxBytes <= durationBytes ? "bytes" : "duration";
	}

	accept(bytes: Uint8Array): {
		accepted: Uint8Array;
		limitedBy: CaptureLimitReason | null;
	} {
		if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2 !== 0) {
			throw new RangeError("PCM16 capture bytes must contain whole samples");
		}
		const remaining = this.capacityBytes - this.acceptedBytes;
		const acceptedLength = Math.max(0, Math.min(bytes.byteLength, remaining));
		const accepted = bytes.slice(0, acceptedLength);
		this.acceptedBytes += acceptedLength;
		return {
			accepted,
			limitedBy:
				bytes.byteLength > remaining ||
				this.acceptedBytes === this.capacityBytes
					? this.limitingReason
					: null,
		};
	}

	get stats(): CaptureStats {
		return {
			bytes: this.acceptedBytes,
			durationMs:
				(this.acceptedBytes / PCM16_BYTES_PER_SAMPLE / TARGET_SAMPLE_RATE) *
				1_000,
			limitedBy:
				this.acceptedBytes === this.capacityBytes ? this.limitingReason : null,
		};
	}
}

/**
 * Dependency-injected AudioWorklet capture. It emits canonical 100 ms PCM16LE
 * frames and, on finish/limit, at most one shorter aligned final frame.
 */
export class AudioWorkletCapture {
	private context: CaptureAudioContextLike | null = null;
	private stream: CaptureStreamLike | null = null;
	private source: CaptureSourceLike | null = null;
	private node: CaptureWorkletNodeLike | null = null;
	private resampler: StreamingLinearResampler | null = null;
	private readonly batcher = new Pcm16FrameBatcher();
	private readonly budget: PcmUtteranceBudget;
	private active = false;
	private completed = false;
	private limitedBy: CaptureLimitReason | null = null;

	constructor(private readonly options: AudioCaptureOptions) {
		this.budget = new PcmUtteranceBudget(
			options.maxDurationMs,
			options.maxBytes,
		);
	}

	async start(): Promise<void> {
		if (this.active) throw new Error("Audio capture is already active");
		if (this.completed) {
			throw new Error("Audio capture instances are single-utterance");
		}
		let moduleUrl: string | null = null;
		try {
			this.stream = await this.options.apis.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});
			this.context = this.options.apis.createAudioContext({
				sampleRate: TARGET_SAMPLE_RATE,
			});
			if (!this.context.audioWorklet) {
				throw new Error("AudioWorklet is unavailable");
			}
			moduleUrl =
				this.options.apis.createWorkletModuleUrl(AUDIO_WORKLET_SOURCE);
			await this.context.audioWorklet.addModule(moduleUrl);
			this.node = this.options.apis.createWorkletNode(
				this.context,
				AUDIO_WORKLET_PROCESSOR_NAME,
				{
					numberOfInputs: 1,
					numberOfOutputs: 0,
					channelCount: 1,
					channelCountMode: "explicit",
				},
			);
			this.resampler = new StreamingLinearResampler(
				this.context.sampleRate,
				TARGET_SAMPLE_RATE,
			);
			this.node.port.onmessage = (event) =>
				this.receiveWorkletBlock(event.data);
			this.source = this.context.createMediaStreamSource(this.stream);
			this.source.connect(this.node);
			await this.context.resume?.();
			this.active = true;
		} catch (error) {
			await this.cleanup();
			throw error;
		} finally {
			if (moduleUrl !== null) {
				this.options.apis.revokeWorkletModuleUrl(moduleUrl);
			}
		}
	}

	/** Public for a fake worklet adapter; production samples arrive via the port. */
	receiveWorkletBlock(data: unknown): void {
		if (!this.active || !(data instanceof Float32Array) || !this.resampler) {
			return;
		}
		const samples = this.resampler.push(data);
		const result = this.budget.accept(pcm16Bytes(float32ToPcm16(samples)));
		for (const frame of this.batcher.push(result.accepted)) {
			this.options.onFrame(frame);
		}
		if (result.limitedBy !== null) {
			this.limitedBy = result.limitedBy;
			this.completed = true;
			this.emitFinalFrame();
			this.options.onLimit?.(result.limitedBy);
			void this.cleanup();
		}
	}

	/** Flush the final short frame and release microphone/audio resources. */
	async finish(): Promise<CaptureStats> {
		if (this.active) this.emitFinalFrame();
		this.completed = true;
		await this.cleanup();
		return { ...this.budget.stats, limitedBy: this.limitedBy };
	}

	async stop(): Promise<void> {
		this.completed = true;
		this.batcher.reset();
		await this.cleanup();
	}

	setMuted(muted: boolean): void {
		for (const track of this.stream?.getTracks() ?? []) {
			track.enabled = !muted;
		}
	}

	get isActive(): boolean {
		return this.active;
	}

	private emitFinalFrame(): void {
		const finalFrame = this.batcher.finish();
		if (finalFrame) this.options.onFrame(finalFrame);
	}

	private async cleanup(): Promise<void> {
		this.active = false;
		if (this.node) this.node.port.onmessage = null;
		this.node?.disconnect();
		this.source?.disconnect();
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		const context = this.context;
		this.node = null;
		this.source = null;
		this.stream = null;
		this.context = null;
		this.resampler = null;
		if (context) await context.close();
	}
}

/** Real browser adapter, kept separate so Bun tests need no DOM globals. */
export function createBrowserAudioCaptureApis(): AudioCaptureApis {
	if (
		typeof navigator === "undefined" ||
		!navigator.mediaDevices?.getUserMedia ||
		typeof window === "undefined" ||
		typeof window.AudioContext !== "function" ||
		typeof window.AudioWorkletNode !== "function"
	) {
		throw new Error("Required microphone AudioWorklet APIs are unavailable");
	}
	return {
		getUserMedia: (constraints) =>
			navigator.mediaDevices.getUserMedia(constraints),
		createAudioContext: (options) =>
			new window.AudioContext(options) as unknown as CaptureAudioContextLike,
		createWorkletNode: (context, name, options) =>
			new window.AudioWorkletNode(
				context as unknown as AudioContext,
				name,
				options,
			) as unknown as CaptureWorkletNodeLike,
		createWorkletModuleUrl: (source) =>
			URL.createObjectURL(
				new Blob([source], { type: "application/javascript" }),
			),
		revokeWorkletModuleUrl: (url) => URL.revokeObjectURL(url),
	};
}
