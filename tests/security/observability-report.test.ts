import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservabilityMetrics } from "../../apps/server/src/observability";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

type JsonRecord = Record<string, unknown>;

function recordAt(root: JsonRecord, ...path: string[]): JsonRecord {
	let current = root;
	for (const part of path) {
		const value = current[part];
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`test path is not an object: ${path.join(".")}`);
		}
		current = value as JsonRecord;
	}
	return current;
}

function safeSnapshot(): JsonRecord {
	const metrics = new ObservabilityMetrics({
		monotonicNow: () => 0,
		wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
	});
	return metrics.snapshot();
}

function runReport(path: string): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync(
		["bun", "run", "scripts/observability-report.ts", path],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

async function fixturePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "botamin-metrics-report-"));
	directories.push(directory);
	return join(directory, "snapshot.json");
}

describe("saved safe observability report", () => {
	test("prints only a complete fixed-schema aggregate snapshot", async () => {
		const path = await fixturePath();
		await writeFile(path, JSON.stringify(safeSnapshot()));
		const accepted = runReport(path);
		expect(accepted.exitCode).toBe(0);
		expect(JSON.parse(accepted.stdout?.toString() ?? "")).toMatchObject({
			schemaVersion: 1,
			generatedAt: "2026-07-31T00:00:00.000Z",
			retention: { activeCorrelations: 0 },
			providers: {
				openrouterStt: { statuses: { other: 0 } },
				openrouterTts: { circuitTransitions: { unknown: 0 } },
			},
			business: {
				orphanRecovery: { runs: 0, pending: false },
			},
		});
	});

	test("rejects unknown nested, secret, PII and cardinality-bearing key names without stdout", async () => {
		const path = await fixturePath();
		const cases: Array<{ objectPath: string[]; key: string }> = [
			{ objectPath: ["business"], key: "notes" },
			{
				objectPath: ["providers", "openrouterStt", "statuses"],
				key: "authorization",
			},
			{
				objectPath: ["business", "booking", "create"],
				key: "email",
			},
			{
				objectPath: ["milestones"],
				key: "conversation-01J00000000000000000000000",
			},
			{
				objectPath: ["latencyMs", "ttsRequestToCompletion"],
				key: "visitor@example.com",
			},
		];
		for (const candidate of cases) {
			const unsafe = structuredClone(safeSnapshot());
			recordAt(unsafe, ...candidate.objectPath)[candidate.key] = 1;
			await writeFile(path, JSON.stringify(unsafe));
			const rejected = runReport(path);
			expect(rejected.exitCode).not.toBe(0);
			expect(rejected.stdout?.toString() ?? "").toBe("");
		}
	});

	test("rejects incomplete fixed maps and invalid values before output", async () => {
		const path = await fixturePath();
		const invalidSnapshots: JsonRecord[] = [];

		const missingStatus = structuredClone(safeSnapshot());
		delete recordAt(missingStatus, "providers", "openrouterTts", "statuses")
			.other;
		invalidSnapshots.push(missingStatus);

		const missingHistogramField = structuredClone(safeSnapshot());
		delete recordAt(
			missingHistogramField,
			"latencyMs",
			"audioCommitToFinalTranscript",
		).p95;
		invalidSnapshots.push(missingHistogramField);

		const negativeCounter = structuredClone(safeSnapshot());
		recordAt(negativeCounter, "capacity").activeSessions = -1;
		invalidSnapshots.push(negativeCounter);

		const stringSample = structuredClone(safeSnapshot());
		recordAt(stringSample, "latencyMs", "brainQueueWait").p50 = "40";
		invalidSnapshots.push(stringSample);

		const dynamicState = structuredClone(safeSnapshot());
		recordAt(dynamicState, "providers", "openrouterStt").currentCircuitState =
			"conversation-id";
		invalidSnapshots.push(dynamicState);

		const invalidRecoveryPending = structuredClone(safeSnapshot());
		recordAt(invalidRecoveryPending, "business", "orphanRecovery").pending =
			"conversation-id";
		invalidSnapshots.push(invalidRecoveryPending);

		for (const invalid of invalidSnapshots) {
			await writeFile(path, JSON.stringify(invalid));
			const rejected = runReport(path);
			expect(rejected.exitCode).not.toBe(0);
			expect(rejected.stdout?.toString() ?? "").toBe("");
		}
	});
});
