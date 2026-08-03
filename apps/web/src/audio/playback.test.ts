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
	startTimes: number[] = [];
	stopped = false;
	start(when: number): void {
		this.startTimes.push(when);
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

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function playbackHarness(
	decode?: AudioPlaybackApis<number>["decodeAudioData"],
) {
	const sources: FakeSource[] = [];
	const decodedSizes: number[] = [];
	let decodeIndex = 0;
	let now = 10;
	let resumeCalls = 0;
	let closeCalls = 0;
	const durations = new Map<number, number>([
		[789, 1.25],
		[790, 0.5],
		[791, 0.75],
	]);
	const apis: AudioPlaybackApis<number> = {
		decodeAudioData: async (bytes) => {
			decodedSizes.push(bytes.byteLength);
			if (decode) return decode(bytes);
			const decoded = 789 + decodeIndex;
			decodeIndex += 1;
			return decoded;
		},
		createSource: () => {
			const source = new FakeSource();
			sources.push(source);
			return source;
		},
		resume: async () => {
			resumeCalls += 1;
		},
		currentTime: () => now,
		duration: (decoded) => durations.get(decoded) ?? 1,
		close: async () => {
			closeCalls += 1;
		},
	};
	return {
		apis,
		sources,
		decodedSizes,
		setCurrentTime: (value: number) => {
			now = value;
		},
		get resumeCalls() {
			return resumeCalls;
		},
		get closeCalls() {
			return closeCalls;
		},
	};
}

describe("bounded complete-MP3 Web Audio playback", () => {
	test("schedules contiguous sources before the first source ends", async () => {
		const harness = playbackHarness();
		const started: number[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onStarted: (value) => started.push(value.sequence),
		});
		queue.beginGeneration(generationId);

		expect(await queue.enqueue(segment(0))).toEqual({ status: "accepted" });
		expect(await queue.enqueue(segment(1))).toEqual({ status: "accepted" });

		expect(harness.sources).toHaveLength(2);
		expect(harness.sources[0]?.startTimes).toEqual([10]);
		expect(harness.sources[1]?.startTimes).toEqual([11.25]);
		expect(harness.sources[1]?.startTimes[0]).toBe(
			(harness.sources[0]?.startTimes[0] ?? 0) + 1.25,
		);
		expect(started).toEqual([0]);
		expect(harness.sources[0]?.onended).not.toBeNull();
	});

	test("keeps one raw handoff and schedules it against the promoted tail", async () => {
		const harness = playbackHarness();
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		const third = queue.enqueue(segment(2));

		expect(queue.bufferedSegmentCount).toBe(2);
		expect(queue.pendingHandoffCount).toBe(1);
		expect(harness.decodedSizes).toEqual([789, 789]);
		harness.sources[0]?.finish();
		expect(await third).toEqual({ status: "accepted" });
		expect(harness.sources[2]?.startTimes).toEqual([11.75]);
		expect(queue.pendingHandoffCount).toBe(0);
	});

	test("never reports idle for a drained but unsealed generation", async () => {
		const harness = playbackHarness();
		const idle: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onIdle: (value) => idle.push(value),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		harness.sources[0]?.finish();

		expect(queue.bufferedSegmentCount).toBe(0);
		expect(queue.activeGenerationId).toBe(generationId);
		expect(idle).toEqual([]);
		expect(queue.sealGeneration(generationId)).toBe(true);
		expect(idle).toEqual([generationId]);
		expect(queue.sealGeneration(generationId)).toBe(true);
		expect(idle).toEqual([generationId]);
	});

	test("waits for every accepted source when seal races playback", async () => {
		const harness = playbackHarness();
		const idle: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onIdle: (value) => idle.push(value),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		expect(queue.sealGeneration(generationId)).toBe(true);
		expect(idle).toEqual([]);
		harness.sources[0]?.finish();
		expect(idle).toEqual([]);
		harness.sources[1]?.finish();
		expect(idle).toEqual([generationId]);
	});

	test("waits for a decode accepted before the seal", async () => {
		const decode = deferred<number>();
		const harness = playbackHarness(() => decode.promise);
		const idle: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onIdle: (value) => idle.push(value),
		});
		queue.beginGeneration(generationId);
		const pending = queue.enqueue(segment(0));
		queue.sealGeneration(generationId);
		expect(idle).toEqual([]);
		decode.resolve(789);
		expect(await pending).toEqual({ status: "accepted" });
		expect(idle).toEqual([]);
		harness.sources[0]?.finish();
		expect(idle).toEqual([generationId]);
	});

	test("barge-in stops current and future scheduled sources and fences late ends", async () => {
		const harness = playbackHarness();
		const idle: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onIdle: (value) => idle.push(value),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		queue.sealGeneration(generationId);
		const lateEnd = harness.sources[1]?.onended;

		expect(queue.bargeIn()).toBe(generationId);
		expect(harness.sources.map((source) => source.stopped)).toEqual([
			true,
			true,
		]);
		lateEnd?.();
		expect(idle).toEqual([]);
		expect(queue.bufferedSegmentCount).toBe(0);
	});

	test("new generation stops all scheduled sources from the old generation", async () => {
		const harness = playbackHarness();
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		queue.beginGeneration("01J00000000000000000000099");
		expect(harness.sources.map((source) => source.stopped)).toEqual([
			true,
			true,
		]);
	});

	test("surfaces overflow as typed failure and cancels every accepted slot", async () => {
		const harness = playbackHarness();
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onError: (_error, _segment, reason) => errors.push(reason),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		const handedOff = queue.enqueue(segment(2));
		const overflow = await queue.enqueue(segment(3));

		expect(overflow).toMatchObject({
			status: "rejected",
			reason: "overflow",
		});
		expect(await handedOff).toMatchObject({
			status: "rejected",
			reason: "stale",
		});
		expect(errors).toEqual(["overflow"]);
		expect(harness.sources.map((source) => source.stopped)).toEqual([
			true,
			true,
		]);
		expect(queue.activeGenerationId).toBeNull();
	});

	test("rejects and clears malformed MP3 and current-generation metadata errors", async () => {
		const harness = playbackHarness();
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onError: (_error, _segment, reason) => errors.push(reason),
		});
		queue.beginGeneration(generationId);
		expect(
			await queue.enqueue(segment(0, createMalformedMp3Fixture())),
		).toMatchObject({ status: "rejected", reason: "invalid" });
		expect(errors).toEqual(["invalid"]);

		queue.beginGeneration(generationId);
		expect(await queue.enqueue({ ...segment(0), byteLength: 1 })).toMatchObject(
			{ status: "rejected", reason: "invalid" },
		);
	});

	test("returns stale without damaging the active generation", async () => {
		const harness = playbackHarness();
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		expect(
			await queue.enqueue({
				...segment(0),
				generationId: "01J00000000000000000000099",
			}),
		).toMatchObject({ status: "rejected", reason: "stale" });
		expect(await queue.enqueue(segment(0))).toEqual({ status: "accepted" });
	});

	test("surfaces decode and source-start failures with typed outcomes", async () => {
		const decodeHarness = playbackHarness(async () => {
			throw new Error("decoder rejected MP3");
		});
		const decodeQueue = new PhrasePlaybackQueue(decodeHarness.apis);
		decodeQueue.beginGeneration(generationId);
		expect(await decodeQueue.enqueue(segment(0))).toMatchObject({
			status: "rejected",
			reason: "decode-error",
		});

		const startHarness = playbackHarness();
		startHarness.apis.createSource = () => ({
			onended: null,
			start: () => {
				throw new Error("source start failed");
			},
			stop: () => undefined,
		});
		const startQueue = new PhrasePlaybackQueue(startHarness.apis);
		startQueue.beginGeneration(generationId);
		expect(await startQueue.enqueue(segment(0))).toMatchObject({
			status: "rejected",
			reason: "playback-error",
		});
	});

	test("drops a decode result that resolves after cancellation", async () => {
		const decode = deferred<number>();
		const harness = playbackHarness(() => decode.promise);
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		const pending = queue.enqueue(segment(0));
		queue.bargeIn();
		decode.resolve(789);
		expect(await pending).toMatchObject({
			status: "rejected",
			reason: "stale",
		});
		expect(harness.sources).toHaveLength(0);
	});

	test("resumes explicitly and dispose closes the output context", async () => {
		const harness = playbackHarness();
		const queue = new PhrasePlaybackQueue(harness.apis);
		await queue.resume();
		expect(harness.resumeCalls).toBe(1);
		await queue.dispose();
		expect(harness.closeCalls).toBe(1);
	});

	test("reports unsupported browser playback APIs", () => {
		expect(() => createBrowserAudioPlaybackApis()).toThrow(
			"Web Audio playback is unavailable",
		);
	});
});
