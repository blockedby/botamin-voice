#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

const TOP_LEVEL_KEYS = [
	"schemaVersion",
	"generatedAt",
	"retention",
	"milestones",
	"latencyMs",
	"providers",
	"business",
	"queue",
	"capacity",
] as const;
const RETENTION_KEYS = [
	"sampleLimitPerHistogram",
	"correlationLimit",
	"activeCorrelations",
	"correlationEvictions",
] as const;
const MILESTONE_KEYS = [
	"audioCommits",
	"sttRequests",
	"finalTranscripts",
	"firstLlmDeltas",
	"ttsRequests",
	"ttsCompletions",
	"firstPlaybackReadyMp3",
] as const;
const LATENCY_KEYS = [
	"audioCommitToSttRequest",
	"audioCommitToFinalTranscript",
	"finalTranscriptToFirstLlmDelta",
	"finalTranscriptToFirstPlaybackReadyMp3",
	"ttsRequestToCompletion",
	"brainQueueWait",
] as const;
const HISTOGRAM_KEYS = [
	"observedCompleted",
	"retainedSamples",
	"p50",
	"p95",
	"min",
	"max",
] as const;
const PROVIDER_KEYS = ["openrouterStt", "openrouterTts"] as const;
const STT_PROVIDER_KEYS = [
	"attempts",
	"successes",
	"failures",
	"stale",
	"retries",
	"bytes",
	"statuses",
	"circuitObservations",
	"currentCircuitState",
	"circuitTransitions",
	"concurrency",
	"requestLatencyMs",
	"audioDurationMs",
] as const;
const TTS_PROVIDER_KEYS = [
	"attempts",
	"successes",
	"failures",
	"stale",
	"retries",
	"bytes",
	"characters",
	"statuses",
	"circuitObservations",
	"currentCircuitState",
	"circuitTransitions",
	"concurrency",
	"requestLatencyMs",
] as const;
const PROVIDER_COUNTER_KEYS = [
	"attempts",
	"successes",
	"failures",
	"stale",
	"retries",
	"bytes",
] as const;
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
const CONCURRENCY_KEYS = ["active", "limit", "rejected"] as const;
const BUSINESS_KEYS = ["booking", "notifier", "orphanRecovery"] as const;
const BOOKING_OPERATION_KEYS = ["create", "update"] as const;
const BOOKING_OUTCOME_KEYS = ["success", "replay", "failure"] as const;
const NOTIFIER_KEYS = ["sent", "failed", "claim_lost"] as const;
const ORPHAN_RECOVERY_KEYS = [
	"runs",
	"scanned",
	"recovered",
	"ignored",
	"invalid",
	"transientFailures",
	"pending",
] as const;
const ORPHAN_RECOVERY_COUNTER_KEYS = ORPHAN_RECOVERY_KEYS.filter(
	(key) => key !== "pending",
);
const QUEUE_KEYS = [
	"granted",
	"cancelled",
	"closed",
	"overflow",
	"timeout",
	"session_capacity",
] as const;
const CAPACITY_KEYS = [
	"activeSessions",
	"maxActiveSessions",
	"activeBrainTurns",
	"maxActiveBrainTurns",
	"pendingBrainTurns",
	"maxPendingBrainTurns",
] as const;
const CIRCUIT_STATES = new Set(CIRCUIT_KEYS);

function fail(message: string): never {
	throw new Error(`observability report failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord<const Key extends string>(
	value: unknown,
	path: string,
	keys: readonly Key[],
): Record<Key, unknown> {
	if (!isRecord(value)) fail(`${path} is not an aggregate object`);
	const expected = new Set<string>(keys);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) fail(`${path}.${key} is an unexpected field`);
	}
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) fail(`${path}.${key} is missing`);
	}
	return value as Record<Key, unknown>;
}

function safeInteger(value: unknown, path: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		fail(`${path} is not a non-negative safe integer`);
	}
}

function nullableSafeInteger(value: unknown, path: string): void {
	if (value !== null) safeInteger(value, path);
}

function counterMap(
	value: unknown,
	path: string,
	keys: readonly string[],
): void {
	const record = exactRecord(value, path, keys);
	for (const key of keys) safeInteger(record[key], `${path}.${key}`);
}

function histogram(value: unknown, path: string): void {
	const record = exactRecord(value, path, HISTOGRAM_KEYS);
	safeInteger(record.observedCompleted, `${path}.observedCompleted`);
	safeInteger(record.retainedSamples, `${path}.retainedSamples`);
	for (const key of ["p50", "p95", "min", "max"] as const) {
		nullableSafeInteger(record[key], `${path}.${key}`);
	}
}

function provider(value: unknown, path: string, kind: "stt" | "tts"): void {
	const keys = kind === "stt" ? STT_PROVIDER_KEYS : TTS_PROVIDER_KEYS;
	const record = exactRecord(value, path, keys);
	for (const key of PROVIDER_COUNTER_KEYS) {
		safeInteger(record[key], `${path}.${key}`);
	}
	if (kind === "tts") safeInteger(record.characters, `${path}.characters`);
	counterMap(record.statuses, `${path}.statuses`, STATUS_KEYS);
	counterMap(
		record.circuitObservations,
		`${path}.circuitObservations`,
		CIRCUIT_KEYS,
	);
	if (
		typeof record.currentCircuitState !== "string" ||
		!CIRCUIT_STATES.has(
			record.currentCircuitState as (typeof CIRCUIT_KEYS)[number],
		)
	) {
		fail(`${path}.currentCircuitState is not a fixed circuit state`);
	}
	counterMap(
		record.circuitTransitions,
		`${path}.circuitTransitions`,
		CIRCUIT_KEYS,
	);
	counterMap(record.concurrency, `${path}.concurrency`, CONCURRENCY_KEYS);
	histogram(record.requestLatencyMs, `${path}.requestLatencyMs`);
	if (kind === "stt") {
		histogram(record.audioDurationMs, `${path}.audioDurationMs`);
	}
}

function validateSnapshot(
	value: unknown,
): asserts value is Record<string, unknown> {
	const root = exactRecord(value, "snapshot", TOP_LEVEL_KEYS);
	if (root.schemaVersion !== 1) fail("unsupported snapshot schemaVersion");
	if (typeof root.generatedAt !== "string") {
		fail("generatedAt is not an ISO timestamp");
	}
	const parsedGeneratedAt = Date.parse(root.generatedAt);
	if (
		!Number.isFinite(parsedGeneratedAt) ||
		new Date(parsedGeneratedAt).toISOString() !== root.generatedAt
	) {
		fail("generatedAt is not an ISO timestamp");
	}
	counterMap(root.retention, "snapshot.retention", RETENTION_KEYS);
	counterMap(root.milestones, "snapshot.milestones", MILESTONE_KEYS);

	const latencies = exactRecord(
		root.latencyMs,
		"snapshot.latencyMs",
		LATENCY_KEYS,
	);
	for (const key of LATENCY_KEYS) {
		histogram(latencies[key], `snapshot.latencyMs.${key}`);
	}

	const providers = exactRecord(
		root.providers,
		"snapshot.providers",
		PROVIDER_KEYS,
	);
	provider(providers.openrouterStt, "snapshot.providers.openrouterStt", "stt");
	provider(providers.openrouterTts, "snapshot.providers.openrouterTts", "tts");

	const business = exactRecord(
		root.business,
		"snapshot.business",
		BUSINESS_KEYS,
	);
	const booking = exactRecord(
		business.booking,
		"snapshot.business.booking",
		BOOKING_OPERATION_KEYS,
	);
	for (const operation of BOOKING_OPERATION_KEYS) {
		counterMap(
			booking[operation],
			`snapshot.business.booking.${operation}`,
			BOOKING_OUTCOME_KEYS,
		);
	}
	counterMap(business.notifier, "snapshot.business.notifier", NOTIFIER_KEYS);
	const orphanRecovery = exactRecord(
		business.orphanRecovery,
		"snapshot.business.orphanRecovery",
		ORPHAN_RECOVERY_KEYS,
	);
	for (const key of ORPHAN_RECOVERY_COUNTER_KEYS) {
		safeInteger(orphanRecovery[key], `snapshot.business.orphanRecovery.${key}`);
	}
	if (typeof orphanRecovery.pending !== "boolean") {
		fail("snapshot.business.orphanRecovery.pending is not a boolean");
	}
	counterMap(root.queue, "snapshot.queue", QUEUE_KEYS);
	counterMap(root.capacity, "snapshot.capacity", CAPACITY_KEYS);
}

try {
	const path = process.argv[2];
	if (!path) fail("usage: observability-report.ts SAFE_SNAPSHOT.json");
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	// Validate the complete key graph and every leaf before writing any bytes.
	validateSnapshot(parsed);
	process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
