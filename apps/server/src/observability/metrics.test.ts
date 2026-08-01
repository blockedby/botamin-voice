import { describe, expect, test } from "bun:test";
import { ObservabilityMetrics } from "./metrics";

type Snapshot = {
	generatedAt: string;
	retention: {
		sampleLimitPerHistogram: number;
		correlationLimit: number;
		activeCorrelations: number;
		correlationEvictions: number;
	};
	milestones: Record<string, number>;
	latencyMs: Record<
		string,
		{
			observedCompleted: number;
			retainedSamples: number;
			p50: number | null;
			p95: number | null;
		}
	>;
	providers: Record<string, Record<string, unknown>>;
	business: Record<string, unknown>;
	queue: Record<string, number>;
	capacity: Record<string, number>;
};

function snapshot(metrics: ObservabilityMetrics): Snapshot {
	return metrics.snapshot() as unknown as Snapshot;
}

describe("bounded privacy-safe observability aggregates", () => {
	test("reports separate completed milestone p50/p95 and null for missing samples", () => {
		let now = 1_000;
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => now,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
		});
		metrics.markAudioCommit("conversation-A:turn-A");
		now += 10;
		metrics.markSttRequest("conversation-A:turn-A");
		now += 40;
		metrics.markFinalTranscript("conversation-A:turn-A");
		now += 20;
		metrics.markFirstLlmDelta("conversation-A:turn-A");
		metrics.markFirstLlmDelta("conversation-A:turn-A");
		now += 30;
		metrics.markFirstPlaybackReady("conversation-A:turn-A");
		metrics.markFirstPlaybackReady("conversation-A:turn-A");

		metrics.markAudioCommit("conversation-B:turn-B");
		const value = snapshot(metrics);
		expect(value.latencyMs.audioCommitToSttRequest).toMatchObject({
			observedCompleted: 1,
			p50: 10,
			p95: 10,
		});
		expect(value.latencyMs.audioCommitToFinalTranscript?.p50).toBe(50);
		expect(value.latencyMs.finalTranscriptToFirstLlmDelta?.p50).toBe(20);
		expect(value.latencyMs.finalTranscriptToFirstPlaybackReadyMp3?.p50).toBe(
			50,
		);
		expect(value.latencyMs.ttsRequestToCompletion).toMatchObject({
			observedCompleted: 0,
			retainedSamples: 0,
			p50: null,
			p95: null,
		});
		expect(value.milestones).toMatchObject({
			audioCommits: 2,
			firstLlmDeltas: 1,
			firstPlaybackReadyMp3: 1,
		});
	});

	test("bounds samples and correlations while never snapshotting sensitive inputs", () => {
		let now = Date.parse("2026-07-31T00:00:00.000Z");
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => now,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
			sampleLimit: 16,
			correlationLimit: 16,
		});
		for (let index = 0; index < 40; index += 1) {
			const sensitiveId = `conv-${index}-visitor@example.com:+79990001122`;
			metrics.markAudioCommit(sensitiveId);
			now += index + 1;
			metrics.markSttRequest(sensitiveId);
		}
		metrics.recordStt({
			audioBytes: 3_244,
			durationMs: 100,
			attempt: 2,
			status: 503,
			latencyMs: 12,
			circuit: "open",
			outcome: "failure",
		});
		metrics.recordCircuitState("stt", "closed");
		metrics.recordCircuitState("stt", "open");
		metrics.recordCircuitState("tts", "closed");
		metrics.recordProviderCapacity("stt", {
			active: 2,
			limit: 2,
			rejected: true,
		});
		metrics.recordTts({
			characters: 18,
			attempt: 1,
			status: 200,
			latencyMs: 8,
			bytes: 417,
			circuit: "closed",
			outcome: "success",
		});
		const value = snapshot(metrics);
		expect(value.retention).toEqual({
			sampleLimitPerHistogram: 16,
			correlationLimit: 16,
			activeCorrelations: 16,
			correlationEvictions: 24,
		});
		expect(value.latencyMs.audioCommitToSttRequest).toMatchObject({
			observedCompleted: 40,
			retainedSamples: 16,
			p50: 32,
			p95: 40,
		});
		const serialized = JSON.stringify(value);
		for (const marker of [
			"visitor@example.com",
			"+79990001122",
			"conv-39",
			"spoken private phrase",
			"input_audio",
			"base64",
			"Authorization",
		]) {
			expect(serialized).not.toContain(marker);
		}
		expect(value.providers.openrouterStt).toMatchObject({
			attempts: 1,
			failures: 1,
			retries: 1,
			bytes: 3_244,
			statuses: { "5xx": 1 },
			circuitObservations: { open: 1 },
			currentCircuitState: "open",
			circuitTransitions: { closed: 1, open: 1 },
			concurrency: { active: 2, limit: 2, rejected: 1 },
		});
		expect(value.providers.openrouterTts).toMatchObject({
			attempts: 1,
			successes: 1,
			characters: 18,
			statuses: { "2xx": 1 },
		});
	});

	test("uses monotonic samples independently of backward and forward wall-clock jumps", () => {
		let monotonic = 100;
		let wall = new Date("2026-07-31T00:00:00.000Z");
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => monotonic,
			wallNow: () => wall,
		});
		metrics.markAudioCommit("wall-jump-turn");
		wall = new Date("2020-01-01T00:00:00.000Z");
		monotonic = 125;
		metrics.markSttRequest("wall-jump-turn");
		wall = new Date("2040-01-01T00:00:00.000Z");
		monotonic = 160;
		metrics.markFinalTranscript("wall-jump-turn");

		let value = snapshot(metrics);
		expect(value.generatedAt).toBe("2040-01-01T00:00:00.000Z");
		expect(value.latencyMs.audioCommitToSttRequest?.p50).toBe(25);
		expect(value.latencyMs.audioCommitToFinalTranscript?.p50).toBe(60);

		wall = new Date("2010-01-01T00:00:00.000Z");
		value = snapshot(metrics);
		expect(value.generatedAt).toBe("2010-01-01T00:00:00.000Z");
		expect(value.latencyMs.audioCommitToSttRequest?.p50).toBe(25);
		expect(value.latencyMs.audioCommitToFinalTranscript?.p50).toBe(60);
	});

	test("counts fixed business, notifier, queue and capacity outcomes", () => {
		let now = 100;
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => now,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
		});
		metrics.recordBooking("create", "success");
		metrics.recordBooking("create", "replay");
		metrics.recordBooking("update", "failure");
		metrics.recordNotification("failed");
		metrics.recordNotification("sent");
		metrics.recordQueue("granted", 7);
		metrics.recordQueue("overflow");
		metrics.setCapacity({
			activeSessions: 2,
			maxActiveSessions: 3,
			activeBrainTurns: 1,
			maxActiveBrainTurns: 2,
			pendingBrainTurns: 1,
			maxPendingBrainTurns: 6,
		});
		const startedAt = metrics.markTtsRequest();
		now += 11;
		metrics.recordTtsCompletion(startedAt, "success");
		const value = snapshot(metrics);
		expect(value.business).toMatchObject({
			booking: {
				create: { success: 1, replay: 1, failure: 0 },
				update: { success: 0, replay: 0, failure: 1 },
			},
			notifier: { sent: 1, failed: 1, claim_lost: 0 },
		});
		expect(value.queue).toMatchObject({ granted: 1, overflow: 1 });
		expect(value.capacity).toMatchObject({
			activeSessions: 2,
			maxActiveSessions: 3,
			pendingBrainTurns: 1,
		});
		expect(value.latencyMs.ttsRequestToCompletion?.p50).toBe(11);
	});
});
