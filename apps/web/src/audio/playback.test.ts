/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
	createDeterministicMp3Fixture,
	createDeterministicTtsWavFixture,
	createInvalidTtsWavFixtures,
	createMalformedMp3Fixture,
	createRawTtsPcm16Fixture,
} from "../../../../packages/test-fixtures/src";
import {
	type AudioPlaybackApis,
	type CompletePlaybackSegment,
	createBrowserAudioPlaybackApis,
	PhrasePlaybackQueue,
	type PlaybackScheduler,
	type PlaybackSourceLike,
} from "./playback";

const generationId = "01J00000000000000000000004";

class FakeLifecycleTarget {
	private readonly listeners = new Map<string, Set<() => void>>();

	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}
	dispatch(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
	get listenerCount(): number {
		return [...this.listeners.values()].reduce(
			(total, listeners) => total + listeners.size,
			0,
		);
	}
}

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

function wavSegment(
	sequence: number,
	bytes: Uint8Array = createDeterministicTtsWavFixture(),
) {
	return {
		generationId,
		segmentId: `01J${String(sequence + 15).padStart(23, "0")}`,
		sequence,
		contentType: "audio/wav",
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

class ManualScheduler implements PlaybackScheduler {
	readonly jobs: Array<{ callback: () => void; delayMs: number }> = [];
	schedule(callback: () => void, delayMs: number): unknown {
		const job = { callback, delayMs };
		this.jobs.push(job);
		return job;
	}
	cancel(handle: unknown): void {
		const index = this.jobs.indexOf(
			handle as { callback: () => void; delayMs: number },
		);
		if (index >= 0) this.jobs.splice(index, 1);
	}
	runNext(): void {
		this.jobs.shift()?.callback();
	}
}

function reactionResponse(
	bytes: Uint8Array<ArrayBufferLike> = createDeterministicTtsWavFixture(),
	contentType: string | null = "audio/wav",
) {
	return {
		ok: true,
		status: 200,
		headers: {
			get: (name: string) => {
				if (name.toLowerCase() === "content-length") {
					return String(bytes.byteLength);
				}
				if (name.toLowerCase() === "content-type") return contentType;
				return null;
			},
		},
		arrayBuffer: async () => Uint8Array.from(bytes).buffer,
	};
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

describe("bounded complete MP3 and WAV Web Audio playback", () => {
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

	test("buffers four fast segments with only two decoded and releases them in order", async () => {
		const harness = playbackHarness();
		const released: number[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onReleased: (value) => released.push(value.sequence),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		const raw = [queue.enqueue(segment(2)), queue.enqueue(segment(3))];

		expect(queue.bufferedSegmentCount).toBe(2);
		expect(queue.pendingRawSegmentCount).toBe(2);
		expect(queue.bufferedRawBytes).toBe(789 * 4);
		expect(harness.decodedSizes).toEqual([789, 789]);
		harness.sources[0]?.finish();
		expect(await raw[0]).toEqual({ status: "accepted" });
		expect(queue.bufferedSegmentCount).toBe(2);
		expect(queue.pendingRawSegmentCount).toBe(1);
		expect(harness.sources[2]?.startTimes).toEqual([11.75]);
		harness.sources[1]?.finish();
		expect(await raw[1]).toEqual({ status: "accepted" });
		expect(harness.sources[3]?.startTimes).toEqual([12.5]);
		harness.sources[2]?.finish();
		harness.sources[3]?.finish();
		expect(released).toEqual([0, 1, 2, 3]);
		expect(queue.bufferedRawBytes).toBe(0);
		expect(queue.bufferedSegmentCount).toBe(0);
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

	test("barge-in stops decoded sources, clears raw segments, and fences late ends", async () => {
		const harness = playbackHarness();
		const idle: string[] = [];
		const released: number[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onReleased: (value) => released.push(value.sequence),
			onIdle: (value) => idle.push(value),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		const raw = [queue.enqueue(segment(2)), queue.enqueue(segment(3))];
		queue.sealGeneration(generationId);
		const lateEnd = harness.sources[1]?.onended;

		expect(queue.bargeIn()).toBe(generationId);
		expect(harness.sources.map((source) => source.stopped)).toEqual([
			true,
			true,
		]);
		for (const pending of raw) {
			expect(await pending).toMatchObject({
				status: "rejected",
				reason: "stale",
			});
		}
		lateEnd?.();
		expect(idle).toEqual([]);
		expect(released).toEqual([]);
		expect(queue.bufferedSegmentCount).toBe(0);
		expect(queue.pendingRawSegmentCount).toBe(0);
		expect(queue.bufferedRawBytes).toBe(0);
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

	test("surfaces over-count as typed failure and cancels every accepted slot", async () => {
		const harness = playbackHarness();
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onError: (_error, _segment, reason) => errors.push(reason),
		});
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		const raw = [queue.enqueue(segment(2)), queue.enqueue(segment(3))];
		const overflow = await queue.enqueue(segment(4));

		expect(overflow).toMatchObject({
			status: "rejected",
			reason: "overflow",
		});
		for (const pending of raw) {
			expect(await pending).toMatchObject({
				status: "rejected",
				reason: "stale",
			});
		}
		expect(errors).toEqual(["overflow"]);
		expect(harness.sources.map((source) => source.stopped)).toEqual([
			true,
			true,
		]);
		expect(queue.activeGenerationId).toBeNull();
	});

	test("validates canonical WAV before injecting exact bytes into decodeAudioData", async () => {
		const decoded: Uint8Array[] = [];
		const harness = playbackHarness(async (buffer) => {
			decoded.push(new Uint8Array(buffer).slice());
			return 789;
		});
		const queue = new PhrasePlaybackQueue(harness.apis);
		queue.beginGeneration(generationId);
		const wav = createDeterministicTtsWavFixture();

		expect(await queue.enqueue(wavSegment(0, wav))).toEqual({
			status: "accepted",
		});
		expect(decoded).toEqual([wav]);
	});

	test("rejects raw PCM, malformed WAV, and content/container mismatches", async () => {
		const invalidWavs = createInvalidTtsWavFixtures();
		for (const bytes of [
			createRawTtsPcm16Fixture(),
			invalidWavs.truncated,
			invalidWavs.wrongRate,
			invalidWavs.wrongChannels,
			invalidWavs.wrongBitDepth,
			invalidWavs.trailing,
		]) {
			const queue = new PhrasePlaybackQueue(playbackHarness().apis);
			queue.beginGeneration(generationId);
			expect(await queue.enqueue(wavSegment(0, bytes))).toMatchObject({
				status: "rejected",
				reason: "invalid",
			});
		}

		const wavAsMp3 = new PhrasePlaybackQueue(playbackHarness().apis);
		wavAsMp3.beginGeneration(generationId);
		expect(
			await wavAsMp3.enqueue({
				...segment(0),
				bytes: createDeterministicTtsWavFixture(),
				byteLength: createDeterministicTtsWavFixture().byteLength,
			}),
		).toMatchObject({ status: "rejected", reason: "invalid" });

		const mp3AsWav = new PhrasePlaybackQueue(playbackHarness().apis);
		mp3AsWav.beginGeneration(generationId);
		expect(
			await mp3AsWav.enqueue(wavSegment(0, createDeterministicMp3Fixture())),
		).toMatchObject({ status: "rejected", reason: "invalid" });
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

	test("fails closed when one segment advertises bytes beyond the server bound", async () => {
		const harness = playbackHarness();
		const errors: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onError: (_error, _segment, reason) => errors.push(reason),
		});
		queue.beginGeneration(generationId);
		expect(
			await queue.enqueue({ ...segment(0), byteLength: 5_000_001 }),
		).toMatchObject({ status: "rejected", reason: "invalid" });
		expect(errors).toEqual(["invalid"]);
		expect(queue.activeGenerationId).toBeNull();
		expect(queue.bufferedRawBytes).toBe(0);
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

	test("starts one fixed-path reaction at 350ms without dynamic callbacks", async () => {
		const harness = playbackHarness();
		const scheduler = new ManualScheduler();
		const fetches: Array<{ input: string; init: RequestInit }> = [];
		const dynamicStarts: number[] = [];
		const dynamicReleases: number[] = [];
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{
				onStarted: (value) => dynamicStarts.push(value.sequence),
				onReleased: (value) => dynamicReleases.push(value.sequence),
			},
			{
				scheduler,
				fetch: async (input, init) => {
					fetches.push({ input, init });
					return reactionResponse();
				},
			},
		);
		expect(
			queue.requestReaction({
				turnId: "01J00000000000000000000003",
				generationId,
				clipId: "neutral-good",
				delayMs: 350,
			}),
		).toBe(true);
		expect(
			queue.requestReaction({
				turnId: "01J00000000000000000000003",
				generationId,
				clipId: "neutral-accepted",
				delayMs: 350,
			}),
		).toBe(false);
		expect(scheduler.jobs.map((job) => job.delayMs)).toEqual([350]);
		expect(fetches).toHaveLength(0);
		scheduler.runNext();
		await Bun.sleep(0);
		expect(fetches).toHaveLength(1);
		expect(fetches[0]).toMatchObject({
			input: "/assets/reactions/neutral-good.wav",
			init: {
				method: "GET",
				credentials: "same-origin",
				mode: "same-origin",
				redirect: "error",
			},
		});
		expect(harness.sources).toHaveLength(1);
		expect(harness.sources[0]?.startTimes).toEqual([10]);
		harness.sources[0]?.finish();
		expect(dynamicStarts).toEqual([]);
		expect(dynamicReleases).toEqual([]);
	});

	test("validates reaction response MIME and canonical WAV bytes before decode", async () => {
		for (const response of [
			reactionResponse(createDeterministicTtsWavFixture(), "audio/mpeg"),
			reactionResponse(createRawTtsPcm16Fixture(), "audio/wav"),
			reactionResponse(createMalformedMp3Fixture(), "audio/wav"),
		]) {
			const harness = playbackHarness();
			const scheduler = new ManualScheduler();
			const queue = new PhrasePlaybackQueue(
				harness.apis,
				{},
				{ scheduler, fetch: async () => response },
			);
			expect(
				queue.requestReaction({
					turnId: "01J00000000000000000000003",
					generationId,
					clipId: "neutral-good",
					delayMs: 350,
				}),
			).toBe(true);
			scheduler.runNext();
			await Bun.sleep(0);
			expect(harness.decodedSizes).toEqual([]);
			expect(harness.sources).toEqual([]);
		}

		const harness = playbackHarness();
		const scheduler = new ManualScheduler();
		const wav = createDeterministicTtsWavFixture();
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{},
			{
				scheduler,
				fetch: async () => reactionResponse(wav, null),
			},
		);
		queue.requestReaction({
			turnId: "01J00000000000000000000004",
			generationId,
			clipId: "neutral-good",
			delayMs: 350,
		});
		scheduler.runNext();
		await Bun.sleep(0);
		expect(harness.decodedSizes).toEqual([wav.byteLength]);
		expect(harness.sources).toHaveLength(1);
	});

	test("dynamic metadata preempts reaction synchronously with no source overlap", async () => {
		const harness = playbackHarness();
		const scheduler = new ManualScheduler();
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{},
			{
				scheduler,
				fetch: async () => reactionResponse(),
			},
		);
		queue.requestReaction({
			turnId: "01J00000000000000000000003",
			generationId,
			clipId: "neutral-good",
			delayMs: 350,
		});
		scheduler.runNext();
		await Bun.sleep(0);
		expect(harness.sources[0]?.stopped).toBe(false);

		queue.beginGeneration(generationId);
		expect(harness.sources[0]?.stopped).toBe(true);
		expect(await queue.enqueue(segment(0))).toEqual({ status: "accepted" });
		expect(harness.sources).toHaveLength(2);
		expect(harness.sources[1]?.startTimes).toEqual([10]);
	});

	test("allows a fresh turn reaction after the prior dynamic generation becomes idle", async () => {
		const harness = playbackHarness();
		const scheduler = new ManualScheduler();
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{},
			{ scheduler, fetch: async () => reactionResponse() },
		);
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		queue.sealGeneration(generationId);
		harness.sources[0]?.finish();
		expect(
			queue.requestReaction({
				turnId: "01J00000000000000000000013",
				generationId: "01J00000000000000000000014",
				clipId: "neutral-good",
				delayMs: 350,
			}),
		).toBe(true);
		expect(scheduler.jobs).toHaveLength(1);
	});

	test("cancels timer and fences late reaction decode without affecting dynamic audio", async () => {
		const decode = deferred<number>();
		const harness = playbackHarness(() => decode.promise);
		const scheduler = new ManualScheduler();
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{},
			{
				scheduler,
				fetch: async () => reactionResponse(),
			},
		);
		queue.requestReaction({
			turnId: "01J00000000000000000000003",
			generationId,
			clipId: "neutral-good",
			delayMs: 350,
		});
		scheduler.runNext();
		await Bun.sleep(0);
		queue.cancelReaction();
		decode.resolve(789);
		await Bun.sleep(0);
		expect(harness.sources).toHaveLength(0);

		queue.beginGeneration(generationId);
		const dynamicDecode = queue.enqueue(segment(0));
		// The test decoder is already resolved for the dynamic segment.
		expect(await dynamicDecode).toEqual({ status: "accepted" });
		expect(harness.sources).toHaveLength(1);
	});

	test("mute stops an active reaction and does not retain generations seen while muted", async () => {
		const harness = playbackHarness();
		const scheduler = new ManualScheduler();
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{},
			{ scheduler, fetch: async () => reactionResponse() },
		);
		queue.requestReaction({
			turnId: "01J00000000000000000000003",
			generationId,
			clipId: "neutral-good",
			delayMs: 350,
		});
		scheduler.runNext();
		await Bun.sleep(0);
		expect(harness.sources[0]?.stopped).toBe(false);

		queue.setMuted(true);
		expect(harness.sources[0]?.stopped).toBe(true);
		expect(queue.activeReactionGenerationId).toBeNull();
		queue.beginGeneration(generationId);
		expect(queue.activeGenerationId).toBeNull();
		expect(await queue.enqueue(segment(0))).toMatchObject({
			status: "rejected",
			reason: "stale",
		});

		queue.setMuted(false);
		expect(queue.activeGenerationId).toBeNull();
		expect(harness.sources).toHaveLength(1);
	});

	test("silently skips reaction fetch failure and cancels an unstarted timer", async () => {
		const harness = playbackHarness();
		const scheduler = new ManualScheduler();
		let fetchCalls = 0;
		const queue = new PhrasePlaybackQueue(
			harness.apis,
			{},
			{
				scheduler,
				fetch: async () => {
					fetchCalls += 1;
					throw new Error("asset unavailable");
				},
			},
		);
		queue.requestReaction({
			turnId: "01J00000000000000000000003",
			generationId,
			clipId: "neutral-good",
			delayMs: 350,
		});
		scheduler.runNext();
		await Bun.sleep(0);
		expect(fetchCalls).toBe(1);
		expect(harness.sources).toHaveLength(0);
		queue.requestReaction({
			turnId: "01J00000000000000000000013",
			generationId,
			clipId: "neutral-good",
			delayMs: 350,
		});
		queue.beginGeneration(generationId);
		expect(scheduler.jobs).toHaveLength(0);
		expect(await queue.enqueue(segment(0))).toEqual({ status: "accepted" });
		expect(harness.sources).toHaveLength(1);
	});

	test("recovers suspended current, prefetched, and raw segments in exact order after background rejection", async () => {
		const harness = playbackHarness();
		const context = new FakeLifecycleTarget();
		const windowTarget = new FakeLifecycleTarget();
		const documentTarget = new FakeLifecycleTarget();
		const mediaDevices = new FakeLifecycleTarget();
		let contextState = "running";
		let visibilityState = "visible";
		let resumeCalls = 0;
		const recoveryStates: string[] = [];
		harness.apis.resume = async () => {
			resumeCalls += 1;
			if (resumeCalls === 1) return;
			if (visibilityState === "hidden") {
				throw new Error("background resume forbidden");
			}
			contextState = "running";
			context.dispatch("statechange");
		};
		harness.apis.recovery = {
			context,
			window: windowTarget,
			document: documentTarget,
			mediaDevices,
			getContextState: () => contextState,
			getVisibilityState: () => visibilityState,
		};
		const released: number[] = [];
		const idle: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onReleased: (value) => released.push(value.sequence),
			onIdle: (value) => idle.push(value),
			onRecoveryStateChange: (state) => recoveryStates.push(state),
		});
		await queue.resume();
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(wavSegment(1));
		const raw = [queue.enqueue(segment(2)), queue.enqueue(wavSegment(3))];
		queue.sealGeneration(generationId);
		expect(queue.bufferedSegmentCount).toBe(2);
		expect(queue.pendingRawSegmentCount).toBe(2);

		visibilityState = "hidden";
		contextState = "suspended";
		context.dispatch("statechange");
		documentTarget.dispatch("visibilitychange");
		documentTarget.dispatch("visibilitychange");
		windowTarget.dispatch("blur");
		await Bun.sleep(0);
		expect(contextState).toBe("suspended");
		expect(harness.sources).toHaveLength(2);
		expect(released).toEqual([]);
		expect(idle).toEqual([]);
		expect(resumeCalls).toBe(3);

		visibilityState = "visible";
		documentTarget.dispatch("visibilitychange");
		windowTarget.dispatch("focus");
		windowTarget.dispatch("pageshow");
		await Bun.sleep(0);
		expect(contextState).toBe("running");
		expect(resumeCalls).toBe(4);
		expect(recoveryStates).not.toContain("gesture-required");
		expect(recoveryStates.at(-1)).toBe("ready");

		for (let index = 0; index < 4; index += 1) {
			harness.sources[index]?.finish();
			await Bun.sleep(0);
		}
		for (const outcome of raw) {
			expect(await outcome).toEqual({ status: "accepted" });
		}
		expect(harness.sources.flatMap((source) => source.startTimes)).toEqual([
			10, 11.25, 11.75, 12.5,
		]);
		expect(released).toEqual([0, 1, 2, 3]);
		expect(idle).toEqual([generationId]);
	});

	test("requires a recovery gesture only after visible automatic resume fails", async () => {
		const harness = playbackHarness();
		const context = new FakeLifecycleTarget();
		const windowTarget = new FakeLifecycleTarget();
		const documentTarget = new FakeLifecycleTarget();
		let contextState = "running";
		let resumeCalls = 0;
		let allowResume = true;
		harness.apis.resume = async () => {
			resumeCalls += 1;
			if (!allowResume) throw new Error("gesture required");
			contextState = "running";
			context.dispatch("statechange");
		};
		harness.apis.recovery = {
			context,
			window: windowTarget,
			document: documentTarget,
			getContextState: () => contextState,
			getVisibilityState: () => "visible",
		};
		const recoveryStates: string[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onRecoveryStateChange: (state) => recoveryStates.push(state),
		});
		await queue.resume();
		allowResume = false;
		contextState = "suspended";
		context.dispatch("statechange");
		windowTarget.dispatch("focus");
		windowTarget.dispatch("focus");
		windowTarget.dispatch("pageshow");
		await Bun.sleep(0);
		expect(resumeCalls).toBe(3);
		expect(recoveryStates.at(-1)).toBe("gesture-required");

		allowResume = true;
		await queue.resume();
		expect(recoveryStates.at(-1)).toBe("ready");
	});

	test("cancellation while interrupted fences recovery and removes every lifecycle listener", async () => {
		const harness = playbackHarness();
		const context = new FakeLifecycleTarget();
		const windowTarget = new FakeLifecycleTarget();
		const documentTarget = new FakeLifecycleTarget();
		const mediaDevices = new FakeLifecycleTarget();
		let contextState = "running";
		let resumeCalls = 0;
		let releaseResume: () => void = () => undefined;
		const resumeGate = new Promise<void>((resolve) => {
			releaseResume = resolve;
		});
		harness.apis.resume = async () => {
			resumeCalls += 1;
			if (resumeCalls > 1) await resumeGate;
		};
		harness.apis.recovery = {
			context,
			window: windowTarget,
			document: documentTarget,
			mediaDevices,
			getContextState: () => contextState,
			getVisibilityState: () => "hidden",
		};
		const released: number[] = [];
		const queue = new PhrasePlaybackQueue(harness.apis, {
			onReleased: (value) => released.push(value.sequence),
		});
		await queue.resume();
		queue.beginGeneration(generationId);
		await queue.enqueue(segment(0));
		await queue.enqueue(segment(1));
		const raw = [queue.enqueue(segment(2)), queue.enqueue(segment(3))];
		contextState = "interrupted";
		context.dispatch("statechange");
		mediaDevices.dispatch("devicechange");
		mediaDevices.dispatch("devicechange");
		expect(resumeCalls).toBe(2);

		expect(queue.bargeIn()).toBe(generationId);
		for (const outcome of raw) {
			expect(await outcome).toMatchObject({
				status: "rejected",
				reason: "stale",
			});
		}
		expect(harness.sources.map((source) => source.stopped)).toEqual([
			true,
			true,
		]);
		contextState = "running";
		releaseResume();
		context.dispatch("statechange");
		await Bun.sleep(0);
		expect(harness.sources).toHaveLength(2);
		expect(released).toEqual([]);

		await queue.dispose();
		expect(context.listenerCount).toBe(0);
		expect(windowTarget.listenerCount).toBe(0);
		expect(documentTarget.listenerCount).toBe(0);
		expect(mediaDevices.listenerCount).toBe(0);
		const callsAfterDispose = resumeCalls;
		contextState = "suspended";
		context.dispatch("statechange");
		windowTarget.dispatch("pageshow");
		expect(resumeCalls).toBe(callsAfterDispose);
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
