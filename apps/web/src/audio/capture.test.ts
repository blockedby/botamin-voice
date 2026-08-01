/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
	createDeterministicWavFixture,
	parseMonoPcm16Wav,
} from "../../../../packages/test-fixtures/src";
import {
	AUDIO_WORKLET_MODULE_URL,
	AudioWorkletCapture,
	type CaptureAudioContextLike,
	type CaptureSourceLike,
	type CaptureStreamLike,
	type CaptureWorkletNodeLike,
	PcmUtteranceBudget,
} from "./capture";
import {
	CANONICAL_FRAME_BYTES,
	float32ToPcm16,
	Pcm16FrameBatcher,
	pcm16Bytes,
	pcm16FromBytes,
} from "./pcm";
import { StreamingLinearResampler } from "./resampler";

class FakeTrack {
	enabled = true;
	stopped = false;
	stop(): void {
		this.stopped = true;
	}
}

class FakeNode implements CaptureWorkletNodeLike {
	port = { onmessage: null as ((event: { data: unknown }) => void) | null };
	disconnected = false;
	disconnect(): void {
		this.disconnected = true;
	}
}

function createCaptureHarness(sampleRate = 48_000, hasWorklet = true) {
	const track = new FakeTrack();
	const stream: CaptureStreamLike = { getTracks: () => [track] };
	const node = new FakeNode();
	const source: CaptureSourceLike & { disconnected: boolean } = {
		disconnected: false,
		connect: () => undefined,
		disconnect() {
			this.disconnected = true;
		},
	};
	let contextClosed = false;
	const moduleUrls: string[] = [];
	const context: CaptureAudioContextLike = {
		sampleRate,
		...(hasWorklet
			? {
					audioWorklet: {
						addModule: async (url: string) => {
							moduleUrls.push(url);
						},
					},
				}
			: {}),
		createMediaStreamSource: () => source,
		resume: async () => undefined,
		close: async () => {
			contextClosed = true;
		},
	};
	return {
		track,
		stream,
		node,
		source,
		moduleUrls,
		get contextClosed() {
			return contextClosed;
		},
		apis: {
			getUserMedia: async () => stream,
			createAudioContext: () => context,
			createWorkletNode: () => node,
			workletModuleUrl: AUDIO_WORKLET_MODULE_URL,
		},
	};
}

describe("PCM capture and resampling", () => {
	test("converts deterministic shared WAV PCM through exact 100 ms batching", () => {
		const pcm = parseMonoPcm16Wav(createDeterministicWavFixture()).pcm16;
		const batcher = new Pcm16FrameBatcher();
		const frames = batcher.push(pcm);

		expect(frames).toHaveLength(1);
		expect(frames[0]?.byteLength).toBe(CANONICAL_FRAME_BYTES);
		expect(frames[0]).toEqual(pcm);
		expect(batcher.pendingBytes).toBe(0);
	});

	test("keeps malformed shared WAV fixture bytes out of deterministic PCM input", () => {
		const malformed = createDeterministicWavFixture();
		malformed[0] = 0;
		expect(() => parseMonoPcm16Wav(malformed)).toThrow("RIFF/WAVE");
	});

	test("uses little-endian PCM16 and clamps normalized samples", () => {
		const samples = float32ToPcm16(
			new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]),
		);
		const bytes = pcm16Bytes(samples);
		expect([...pcm16FromBytes(bytes)]).toEqual([
			-32_768, -32_768, -16_384, 0, 16_384, 32_767, 32_767,
		]);
		expect([...bytes.slice(0, 4)]).toEqual([0, 128, 0, 128]);
	});

	test("preserves phase across blocks and resamples 48 kHz mono to 16 kHz", () => {
		const resampler = new StreamingLinearResampler(48_000, 16_000);
		const first = resampler.push(new Float32Array(2_400).fill(0.25));
		const second = resampler.push(new Float32Array(2_400).fill(0.25));
		expect(first.length + second.length).toBe(1_600);
		expect([...first, ...second].every((value) => value === 0.25)).toBe(true);
	});

	test("enforces independent utterance duration and byte ceilings", () => {
		const byDuration = new PcmUtteranceBudget(50, 1_000_000);
		const durationResult = byDuration.accept(new Uint8Array(3_200));
		expect(durationResult.accepted.byteLength).toBe(1_600);
		expect(durationResult.limitedBy).toBe("duration");
		expect(byDuration.stats).toMatchObject({ bytes: 1_600, durationMs: 50 });

		const byBytes = new PcmUtteranceBudget(30_000, 1_000);
		const bytesResult = byBytes.accept(new Uint8Array(3_200));
		expect(bytesResult.accepted.byteLength).toBe(1_000);
		expect(bytesResult.limitedBy).toBe("bytes");
	});

	test("AudioWorklet adapter emits one canonical frame and cleans up mute/finish", async () => {
		const harness = createCaptureHarness();
		const frames: Uint8Array[] = [];
		const capture = new AudioWorkletCapture({
			apis: harness.apis,
			onFrame: (frame) => frames.push(frame),
		});
		await capture.start();
		expect(harness.moduleUrls).toEqual([AUDIO_WORKLET_MODULE_URL]);

		capture.setMuted(true);
		expect(harness.track.enabled).toBe(false);
		capture.setMuted(false);
		expect(harness.track.enabled).toBe(true);
		harness.node.port.onmessage?.({
			data: new Float32Array(4_800).fill(0.125),
		});
		expect(frames.map((frame) => frame.byteLength)).toEqual([3_200]);

		const stats = await capture.finish();
		expect(stats).toMatchObject({ bytes: 3_200, durationMs: 100 });
		expect(harness.track.stopped).toBe(true);
		expect(harness.node.disconnected).toBe(true);
		expect(harness.source.disconnected).toBe(true);
		expect(harness.contextClosed).toBe(true);
		await expect(capture.start()).rejects.toThrow("single-utterance");
	});

	test("stop during permission prompt releases a stream that resolves late", async () => {
		const harness = createCaptureHarness();
		let resolvePermission: (stream: CaptureStreamLike) => void = () =>
			undefined;
		const permission = new Promise<CaptureStreamLike>((resolve) => {
			resolvePermission = resolve;
		});
		const capture = new AudioWorkletCapture({
			apis: {
				...harness.apis,
				getUserMedia: async () => permission,
			},
			onFrame: () => undefined,
		});

		const starting = capture.start();
		await capture.stop();
		resolvePermission(harness.stream);
		await expect(starting).rejects.toThrow("cancelled");
		expect(capture.isActive).toBe(false);
		expect(harness.track.stopped).toBe(true);
		expect(harness.contextClosed).toBe(false);
	});

	test("stop during worklet initialization closes acquired media and context", async () => {
		const harness = createCaptureHarness();
		let finishModule: () => void = () => undefined;
		const moduleGate = new Promise<void>((resolve) => {
			finishModule = resolve;
		});
		const context = harness.apis.createAudioContext();
		if (!context.audioWorklet) throw new Error("test worklet missing");
		context.audioWorklet.addModule = async () => moduleGate;
		const capture = new AudioWorkletCapture({
			apis: {
				...harness.apis,
				createAudioContext: () => context,
			},
			onFrame: () => undefined,
		});

		const starting = capture.start();
		await Promise.resolve();
		await Promise.resolve();
		await capture.stop();
		expect(harness.track.stopped).toBe(true);
		expect(harness.contextClosed).toBe(true);
		finishModule();
		await expect(starting).rejects.toThrow("cancelled");
		expect(capture.isActive).toBe(false);
	});

	test("stops before a byte limit and emits only the bounded final frame", async () => {
		const harness = createCaptureHarness();
		const frames: Uint8Array[] = [];
		const limits: string[] = [];
		const capture = new AudioWorkletCapture({
			apis: harness.apis,
			maxBytes: 1_000,
			maxDurationMs: 30_000,
			onFrame: (frame) => frames.push(frame),
			onLimit: (reason) => limits.push(reason),
		});
		await capture.start();
		harness.node.port.onmessage?.({ data: new Float32Array(4_800) });
		await Promise.resolve();

		expect(limits).toEqual(["bytes"]);
		expect(frames.map((frame) => frame.byteLength)).toEqual([1_000]);
		expect(capture.isActive).toBe(false);
		expect(harness.track.stopped).toBe(true);
	});

	test("reports unsupported AudioWorklet and releases acquired media", async () => {
		const harness = createCaptureHarness(48_000, false);
		const capture = new AudioWorkletCapture({
			apis: harness.apis,
			onFrame: () => undefined,
		});
		await expect(capture.start()).rejects.toThrow(
			"AudioWorklet is unavailable",
		);
		expect(harness.track.stopped).toBe(true);
		expect(harness.contextClosed).toBe(true);
	});
});
