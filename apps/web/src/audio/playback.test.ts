/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
	createDeterministicMp3Fixture,
	createMalformedMp3Fixture,
} from "../../../../packages/test-fixtures/src";
import {
	type AudioPlaybackApis,
	type CompletePlaybackSegment,
	createBrowserAudioPlaybackApis,
	PhrasePlaybackQueue,
	type PlaybackSourceLike,
} from "./playback";

const generationId = "01J00000000000000000000004";

class FakeSource implements PlaybackSourceLike {
	onended: (() => void) | null = null;
	started = false;
	stopped = false;
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.stopped = true;
	}
	finish(): void {
		this.onended?.();
	}
}

function segment(sequence: number, bytes = createDeterministicMp3Fixture()) {
	return {
		generationId,
		segmentId: `01J${String(sequence + 5).padStart(23, "0")}`,
		sequence,
		contentType: "audio/mpeg",
		byteLength: bytes.byteLength,
		final: true,
		bytes,
	} satisfies CompletePlaybackSegment;
}

function playbackHarness(
	decode: AudioPlaybackApis<number>["decodeAudioData"] = async (bytes) =>
		bytes.byteLength,
) {
	const sources: FakeSource[] = [];
	const decodedSizes: number[] = [];
	const apis: AudioPlaybackApis<number> = {
		decodeAudioData: async (bytes) => {
			decodedSizes.push(bytes.byteLength);
			return decode(bytes);
		},
		createSource: () => {
			const source = new FakeSource();
			sources.push(source);
			return source;
		},
	};
	return { apis, sources, decodedSizes };
}

describe("complete MP3 phrase playback", () => {
	test("decodes and plays three complete segments in order with a two-slot bound", async () => {
		const harness = playbackHarness();
		const started: number[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onStarted: (value) => started.push(value.sequence),
		});
		queue.beginGeneration(generationId);

		expect(await queue.enqueue(segment(10))).toBe(true);
		expect(await queue.enqueue(segment(11))).toBe(true);
		expect(queue.bufferedSegmentCount).toBe(2);
		expect(await queue.enqueue(segment(12))).toBe(false);

		harness.sources[0]?.finish();
		expect(started).toEqual([10, 11]);
		expect(queue.bufferedSegmentCount).toBe(1);
		expect(await queue.enqueue(segment(12))).toBe(true);
		expect(queue.bufferedSegmentCount).toBe(2);

		harness.sources[1]?.finish();
		harness.sources[2]?.finish();
		expect(started).toEqual([10, 11, 12]);
		expect(harness.decodedSizes).toEqual([789, 789, 789]);
		expect(queue.bufferedSegmentCount).toBe(0);
	});

	test("rejects malformed MP3, metadata mismatch, duplicate/out-of-order, and stale generations", async () => {
		const harness = playbackHarness();
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onError: (error) => errors.push(error.message),
		});
		queue.beginGeneration(generationId);

		expect(await queue.enqueue(segment(0, createMalformedMp3Fixture()))).toBe(
			false,
		);
		expect(errors).toEqual(["Complete audio segment is not valid MP3"]);

		queue.beginGeneration(generationId);
		const wrongLength = { ...segment(0), byteLength: 1 };
		expect(await queue.enqueue(wrongLength)).toBe(false);
		expect(await queue.enqueue(segment(1))).toBe(true);
		// Shared contract requires monotonic, not necessarily contiguous, sequence.
		expect(await queue.enqueue(segment(3))).toBe(true);
		expect(await queue.enqueue(segment(1))).toBe(false);
		expect(
			await queue.enqueue({
				...segment(4),
				generationId: "01J00000000000000000000099",
			}),
		).toBe(false);
	});

	test("surfaces decode errors and clears audio without fabricating a playable source", async () => {
		const harness = playbackHarness(async () => {
			throw new Error("decoder rejected MP3");
		});
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onError: (error) => errors.push(error.message),
		});
		queue.beginGeneration(generationId);

		expect(await queue.enqueue(segment(0))).toBe(false);
		expect(errors).toEqual(["decoder rejected MP3"]);
		expect(harness.sources).toHaveLength(0);
		expect(queue.activeGenerationId).toBeNull();
	});

	test("returns failure when a decoded source cannot start", async () => {
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue<number>(
			{
				decodeAudioData: async () => 789,
				createSource: () => ({
					onended: null,
					start: () => {
						throw new Error("source start failed");
					},
					stop: () => undefined,
				}),
			},
			{ onError: (error) => errors.push(error.message) },
		);
		queue.beginGeneration(generationId);
		expect(await queue.enqueue(segment(0))).toBe(false);
		expect(errors).toEqual(["source start failed"]);
		expect(queue.activeGenerationId).toBeNull();
	});

	test("barge-in immediately stops playback, clears prefetch, and drops late audio", async () => {
		const harness = playbackHarness();
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));

		expect(queue.bargeIn()).toBe(generationId);
		expect(harness.sources[0]?.stopped).toBe(true);
		expect(queue.bufferedSegmentCount).toBe(0);
		expect(await queue.enqueue(segment(2))).toBe(false);
	});

	test("drops a decode result that resolves after its generation was superseded", async () => {
		const deferred: { resolve?: (value: number) => void } = {};
		const harness = playbackHarness(
			() =>
				new Promise<number>((resolve) => {
					deferred.resolve = resolve;
				}),
		);
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		const pending = queue.enqueue(segment(0));
		queue.bargeIn();
		deferred.resolve?.(789);

		expect(await pending).toBe(false);
		expect(harness.sources).toHaveLength(0);
	});

	test("reports unsupported browser playback APIs without attempting provider access", () => {
		expect(() => createBrowserAudioPlaybackApis()).toThrow(
			"Web Audio playback is unavailable",
		);
	});

	test("mute clears audio and stop/dispose closes the injected browser resource", async () => {
		let closed = false;
		const harness = playbackHarness();
		const queue = new PhrasePlaybackQueue({
			...harness.apis,
			close: async () => {
				closed = true;
			},
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		queue.setMuted(true);
		expect(harness.sources[0]?.stopped).toBe(true);
		expect(await queue.enqueue(segment(1))).toBe(false);
		await queue.dispose();
		expect(closed).toBe(true);
	});
});
