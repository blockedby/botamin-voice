import { createHash } from "node:crypto";

/**
 * Privacy-safe, process-local operational aggregates.
 *
 * Exact semantics and missing-sample behavior are documented in README.md.
 * Raw IDs are one-way hashed only while correlating milestones and are never
 * returned by snapshot(). Text, audio, base64, contacts, auth, URLs, provider
 * request IDs, model names, and voice names are not accepted by this API.
 */

export const METRIC_SAMPLE_LIMIT = 512;
export const METRIC_CORRELATION_LIMIT = 4_096;

const STATUS_KEYS = [
	"2xx",
	"400",
	"401",
	"402",
	"403",
	"404",
	"413",
	"429",
	"4xxOther",
	"5xx",
	"network",
	"other",
] as const;
const CIRCUIT_KEYS = ["closed", "open", "half-open", "unknown"] as const;

export type SafeProviderStatus = (typeof STATUS_KEYS)[number];
export type SafeCircuitState = (typeof CIRCUIT_KEYS)[number];
export type ProviderOutcome = "success" | "failure" | "stale";
export type BookingOperation = "create" | "update";
export type BookingOutcome = "success" | "replay" | "failure";
export type NotifierOutcome = "sent" | "failed" | "claim_lost";
export type QueueOutcome =
	| "granted"
	| "cancelled"
	| "closed"
	| "overflow"
	| "timeout"
	| "session_capacity";

export interface SttMetricInput {
	audioBytes: number;
	durationMs: number;
	attempt: number;
	status: number | "network";
	latencyMs: number;
	circuit?: string;
	outcome?: ProviderOutcome;
}

export interface TtsMetricInput {
	characters: number;
	attempt: number;
	status: number | "network";
	latencyMs: number;
	bytes: number;
	circuit?: string;
	outcome?: ProviderOutcome;
}

export interface ObservabilityMetricsOptions {
	now?: () => number;
	sampleLimit?: number;
	correlationLimit?: number;
}

interface Correlation {
	commitAt?: number;
	sttRequestAt?: number;
	transcriptAt?: number;
	firstLlmDeltaObserved: boolean;
	firstPlaybackObserved: boolean;
}

interface HistogramSnapshot {
	observedCompleted: number;
	retainedSamples: number;
	p50: number | null;
	p95: number | null;
	min: number | null;
	max: number | null;
}

class BoundedHistogram {
	readonly #samples: number[] = [];
	#observedCompleted = 0;

	constructor(private readonly limit: number) {}

	observe(value: number): void {
		if (!Number.isFinite(value) || value < 0) return;
		this.#observedCompleted = saturatingAdd(this.#observedCompleted, 1);
		if (this.#samples.length >= this.limit) this.#samples.shift();
		this.#samples.push(Math.floor(value));
	}

	snapshot(): HistogramSnapshot {
		if (this.#samples.length === 0) {
			return {
				observedCompleted: this.#observedCompleted,
				retainedSamples: 0,
				p50: null,
				p95: null,
				min: null,
				max: null,
			};
		}
		const sorted = [...this.#samples].sort((left, right) => left - right);
		return {
			observedCompleted: this.#observedCompleted,
			retainedSamples: sorted.length,
			p50: nearestRank(sorted, 0.5),
			p95: nearestRank(sorted, 0.95),
			min: sorted[0] ?? null,
			max: sorted.at(-1) ?? null,
		};
	}
}

interface ProviderAggregate {
	attempts: number;
	successes: number;
	failures: number;
	stale: number;
	retries: number;
	bytes: number;
	characters: number;
	statuses: Record<SafeProviderStatus, number>;
	circuit: Record<SafeCircuitState, number>;
	circuitTransitions: Record<SafeCircuitState, number>;
	currentCircuitState: SafeCircuitState;
	concurrency: { active: number; limit: number; rejected: number };
	requestLatencyMs: BoundedHistogram;
	mediaDurationMs: BoundedHistogram;
}

function providerAggregate(sampleLimit: number): ProviderAggregate {
	return {
		attempts: 0,
		successes: 0,
		failures: 0,
		stale: 0,
		retries: 0,
		bytes: 0,
		characters: 0,
		statuses: fixedCounter(STATUS_KEYS),
		circuit: fixedCounter(CIRCUIT_KEYS),
		circuitTransitions: fixedCounter(CIRCUIT_KEYS),
		currentCircuitState: "unknown",
		concurrency: { active: 0, limit: 0, rejected: 0 },
		requestLatencyMs: new BoundedHistogram(sampleLimit),
		mediaDurationMs: new BoundedHistogram(sampleLimit),
	};
}

/** Bounded metrics sink shared by runtime, gateway, providers and workers. */
export class ObservabilityMetrics {
	readonly #now: () => number;
	readonly #sampleLimit: number;
	readonly #correlationLimit: number;
	readonly #correlations = new Map<string, Correlation>();
	readonly #commitToSttRequest: BoundedHistogram;
	readonly #commitToFinal: BoundedHistogram;
	readonly #finalToFirstLlmDelta: BoundedHistogram;
	readonly #finalToFirstPlayback: BoundedHistogram;
	readonly #ttsOperationLatency: BoundedHistogram;
	readonly #brainQueueWait: BoundedHistogram;
	readonly #stt: ProviderAggregate;
	readonly #tts: ProviderAggregate;
	readonly #milestones = {
		audioCommits: 0,
		sttRequests: 0,
		finalTranscripts: 0,
		firstLlmDeltas: 0,
		ttsRequests: 0,
		ttsCompletions: 0,
		firstPlaybackReadyMp3: 0,
	};
	readonly #booking = {
		create: { success: 0, replay: 0, failure: 0 },
		update: { success: 0, replay: 0, failure: 0 },
	};
	readonly #notifier = { sent: 0, failed: 0, claim_lost: 0 };
	readonly #queue = {
		granted: 0,
		cancelled: 0,
		closed: 0,
		overflow: 0,
		timeout: 0,
		session_capacity: 0,
	};
	readonly #capacity = {
		activeSessions: 0,
		maxActiveSessions: 0,
		activeBrainTurns: 0,
		maxActiveBrainTurns: 0,
		pendingBrainTurns: 0,
		maxPendingBrainTurns: 0,
	};
	#correlationEvictions = 0;

	constructor(options: ObservabilityMetricsOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#sampleLimit = boundedLimit(
			options.sampleLimit,
			METRIC_SAMPLE_LIMIT,
			16,
			4_096,
		);
		this.#correlationLimit = boundedLimit(
			options.correlationLimit,
			METRIC_CORRELATION_LIMIT,
			16,
			16_384,
		);
		this.#commitToSttRequest = new BoundedHistogram(this.#sampleLimit);
		this.#commitToFinal = new BoundedHistogram(this.#sampleLimit);
		this.#finalToFirstLlmDelta = new BoundedHistogram(this.#sampleLimit);
		this.#finalToFirstPlayback = new BoundedHistogram(this.#sampleLimit);
		this.#ttsOperationLatency = new BoundedHistogram(this.#sampleLimit);
		this.#brainQueueWait = new BoundedHistogram(this.#sampleLimit);
		this.#stt = providerAggregate(this.#sampleLimit);
		this.#tts = providerAggregate(this.#sampleLimit);
	}

	markAudioCommit(correlationId: string, at = this.#now()): void {
		const correlation = this.#correlation(correlationId);
		if (correlation.commitAt !== undefined) return;
		const timestamp = validTimestamp(at);
		if (timestamp === undefined) return;
		correlation.commitAt = timestamp;
		this.#milestones.audioCommits = increment(this.#milestones.audioCommits);
	}

	markSttRequest(correlationId: string, at = this.#now()): void {
		const correlation = this.#correlation(correlationId);
		if (correlation.sttRequestAt !== undefined) return;
		const timestamp = validTimestamp(at);
		if (timestamp === undefined) return;
		correlation.sttRequestAt = timestamp;
		this.#milestones.sttRequests = increment(this.#milestones.sttRequests);
		observeElapsed(
			this.#commitToSttRequest,
			correlation.commitAt,
			correlation.sttRequestAt,
		);
	}

	markFinalTranscript(correlationId: string, at = this.#now()): void {
		const correlation = this.#correlation(correlationId);
		if (correlation.transcriptAt !== undefined) return;
		const timestamp = validTimestamp(at);
		if (timestamp === undefined) return;
		correlation.transcriptAt = timestamp;
		this.#milestones.finalTranscripts = increment(
			this.#milestones.finalTranscripts,
		);
		observeElapsed(
			this.#commitToFinal,
			correlation.commitAt,
			correlation.transcriptAt,
		);
	}

	markFirstLlmDelta(correlationId: string, at = this.#now()): void {
		const correlation = this.#correlation(correlationId);
		if (correlation.firstLlmDeltaObserved) return;
		correlation.firstLlmDeltaObserved = true;
		this.#milestones.firstLlmDeltas = increment(
			this.#milestones.firstLlmDeltas,
		);
		observeElapsed(
			this.#finalToFirstLlmDelta,
			correlation.transcriptAt,
			validTimestamp(at),
		);
	}

	markFirstPlaybackReady(correlationId: string, at = this.#now()): void {
		const correlation = this.#correlation(correlationId);
		if (correlation.firstPlaybackObserved) return;
		correlation.firstPlaybackObserved = true;
		this.#milestones.firstPlaybackReadyMp3 = increment(
			this.#milestones.firstPlaybackReadyMp3,
		);
		observeElapsed(
			this.#finalToFirstPlayback,
			correlation.transcriptAt,
			validTimestamp(at),
		);
	}

	markTtsRequest(): number {
		this.#milestones.ttsRequests = increment(this.#milestones.ttsRequests);
		return this.#now();
	}

	recordTtsCompletion(startedAt: number, outcome: ProviderOutcome): void {
		this.#milestones.ttsCompletions = increment(
			this.#milestones.ttsCompletions,
		);
		const completedAt = this.#now();
		if (outcome !== "stale" && completedAt >= startedAt) {
			this.#ttsOperationLatency.observe(completedAt - startedAt);
		}
	}

	finishCorrelation(correlationId: string): void {
		this.#correlations.delete(hashCorrelationId(correlationId));
	}

	recordStt(input: SttMetricInput): void {
		this.#recordProvider(this.#stt, input);
		this.#stt.bytes = saturatingAdd(
			this.#stt.bytes,
			safeWhole(input.audioBytes),
		);
		this.#stt.mediaDurationMs.observe(input.durationMs);
	}

	recordTts(input: TtsMetricInput): void {
		this.#recordProvider(this.#tts, input);
		this.#tts.bytes = saturatingAdd(this.#tts.bytes, safeWhole(input.bytes));
		this.#tts.characters = saturatingAdd(
			this.#tts.characters,
			safeWhole(input.characters),
		);
	}

	recordProviderCapacity(
		provider: "stt" | "tts",
		input: { active: number; limit: number; rejected: boolean },
	): void {
		const aggregate = provider === "stt" ? this.#stt : this.#tts;
		aggregate.concurrency.active = safeWhole(input.active);
		aggregate.concurrency.limit = safeWhole(input.limit);
		if (input.rejected) {
			aggregate.concurrency.rejected = increment(
				aggregate.concurrency.rejected,
			);
		}
	}

	recordCircuitState(provider: "stt" | "tts", state: string): void {
		const aggregate = provider === "stt" ? this.#stt : this.#tts;
		const safeState = safeCircuit(state);
		if (aggregate.currentCircuitState === safeState) return;
		aggregate.currentCircuitState = safeState;
		aggregate.circuitTransitions[safeState] = increment(
			aggregate.circuitTransitions[safeState],
		);
	}

	recordBooking(operation: BookingOperation, outcome: BookingOutcome): void {
		this.#booking[operation][outcome] = increment(
			this.#booking[operation][outcome],
		);
	}

	recordNotification(outcome: NotifierOutcome): void {
		this.#notifier[outcome] = increment(this.#notifier[outcome]);
	}

	recordQueue(outcome: QueueOutcome, waitMs?: number): void {
		this.#queue[outcome] = increment(this.#queue[outcome]);
		if (outcome === "granted" && waitMs !== undefined) {
			this.#brainQueueWait.observe(waitMs);
		}
	}

	setCapacity(input: {
		activeSessions: number;
		maxActiveSessions: number;
		activeBrainTurns: number;
		maxActiveBrainTurns: number;
		pendingBrainTurns: number;
		maxPendingBrainTurns: number;
	}): void {
		this.#capacity.activeSessions = safeWhole(input.activeSessions);
		this.#capacity.maxActiveSessions = safeWhole(input.maxActiveSessions);
		this.#capacity.activeBrainTurns = safeWhole(input.activeBrainTurns);
		this.#capacity.maxActiveBrainTurns = safeWhole(input.maxActiveBrainTurns);
		this.#capacity.pendingBrainTurns = safeWhole(input.pendingBrainTurns);
		this.#capacity.maxPendingBrainTurns = safeWhole(input.maxPendingBrainTurns);
	}

	snapshot(): Record<string, unknown> {
		return {
			schemaVersion: 1,
			generatedAt: new Date(this.#now()).toISOString(),
			retention: {
				sampleLimitPerHistogram: this.#sampleLimit,
				correlationLimit: this.#correlationLimit,
				activeCorrelations: this.#correlations.size,
				correlationEvictions: this.#correlationEvictions,
			},
			milestones: { ...this.#milestones },
			latencyMs: {
				audioCommitToSttRequest: this.#commitToSttRequest.snapshot(),
				audioCommitToFinalTranscript: this.#commitToFinal.snapshot(),
				finalTranscriptToFirstLlmDelta: this.#finalToFirstLlmDelta.snapshot(),
				finalTranscriptToFirstPlaybackReadyMp3:
					this.#finalToFirstPlayback.snapshot(),
				ttsRequestToCompletion: this.#ttsOperationLatency.snapshot(),
				brainQueueWait: this.#brainQueueWait.snapshot(),
			},
			providers: {
				openrouterStt: providerSnapshot(this.#stt, false),
				openrouterTts: providerSnapshot(this.#tts, true),
			},
			business: {
				booking: structuredClone(this.#booking),
				notifier: { ...this.#notifier },
			},
			queue: { ...this.#queue },
			capacity: { ...this.#capacity },
		};
	}

	#recordProvider(
		aggregate: ProviderAggregate,
		input: SttMetricInput | TtsMetricInput,
	): void {
		aggregate.attempts = increment(aggregate.attempts);
		aggregate.requestLatencyMs.observe(input.latencyMs);
		if (safeWhole(input.attempt) > 1)
			aggregate.retries = increment(aggregate.retries);
		const outcome =
			input.outcome ?? (input.status === 200 ? "success" : "failure");
		if (outcome === "success")
			aggregate.successes = increment(aggregate.successes);
		else if (outcome === "stale") aggregate.stale = increment(aggregate.stale);
		else aggregate.failures = increment(aggregate.failures);
		const status = safeStatus(input.status);
		aggregate.statuses[status] = increment(aggregate.statuses[status]);
		const circuit = safeCircuit(input.circuit);
		aggregate.circuit[circuit] = increment(aggregate.circuit[circuit]);
	}

	#correlation(rawId: string): Correlation {
		const key = hashCorrelationId(rawId);
		let correlation = this.#correlations.get(key);
		if (correlation) return correlation;
		while (this.#correlations.size >= this.#correlationLimit) {
			const oldest = this.#correlations.keys().next().value;
			if (oldest === undefined) break;
			this.#correlations.delete(oldest);
			this.#correlationEvictions = increment(this.#correlationEvictions);
		}
		correlation = {
			firstLlmDeltaObserved: false,
			firstPlaybackObserved: false,
		};
		this.#correlations.set(key, correlation);
		return correlation;
	}
}

function providerSnapshot(
	aggregate: ProviderAggregate,
	includeCharacters: boolean,
): Record<string, unknown> {
	return {
		attempts: aggregate.attempts,
		successes: aggregate.successes,
		failures: aggregate.failures,
		stale: aggregate.stale,
		retries: aggregate.retries,
		bytes: aggregate.bytes,
		...(includeCharacters ? { characters: aggregate.characters } : {}),
		statuses: { ...aggregate.statuses },
		circuitObservations: { ...aggregate.circuit },
		currentCircuitState: aggregate.currentCircuitState,
		circuitTransitions: { ...aggregate.circuitTransitions },
		concurrency: { ...aggregate.concurrency },
		requestLatencyMs: aggregate.requestLatencyMs.snapshot(),
		...(includeCharacters
			? {}
			: { audioDurationMs: aggregate.mediaDurationMs.snapshot() }),
	};
}

function observeElapsed(
	histogram: BoundedHistogram,
	start: number | undefined,
	end: number | undefined,
): void {
	if (start === undefined || end === undefined || end < start) return;
	histogram.observe(end - start);
}

function validTimestamp(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nearestRank(sorted: number[], fraction: number): number | null {
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function safeStatus(status: number | "network"): SafeProviderStatus {
	if (status === "network") return "network";
	if (status >= 200 && status <= 299) return "2xx";
	if ([400, 401, 402, 403, 404, 413, 429].includes(status)) {
		return String(status) as SafeProviderStatus;
	}
	if (status >= 400 && status <= 499) return "4xxOther";
	if (status >= 500 && status <= 599) return "5xx";
	return "other";
}

function safeCircuit(value: string | undefined): SafeCircuitState {
	return value === "closed" || value === "open" || value === "half-open"
		? value
		: "unknown";
}

function fixedCounter<const Key extends string>(
	keys: readonly Key[],
): Record<Key, number> {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
}

function hashCorrelationId(value: string): string {
	return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

function boundedLimit(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (
		value === undefined ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		return fallback;
	}
	return value;
}

function safeWhole(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function increment(value: number): number {
	return saturatingAdd(value, 1);
}

function saturatingAdd(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
