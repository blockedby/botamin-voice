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

describe("saved safe observability report", () => {
	test("prints aggregate snapshot and rejects injected strings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-metrics-report-"));
		directories.push(directory);
		const path = join(directory, "safe.json");
		const metrics = new ObservabilityMetrics({
			now: () => Date.parse("2026-07-31T00:00:00.000Z"),
		});
		await writeFile(path, JSON.stringify(metrics.snapshot()));
		const accepted = Bun.spawnSync(
			["bun", "run", "scripts/observability-report.ts", path],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(accepted.exitCode).toBe(0);
		expect(JSON.parse(accepted.stdout.toString())).toMatchObject({
			schemaVersion: 1,
			retention: { activeCorrelations: 0 },
		});

		const unsafe = JSON.parse(await Bun.file(path).text()) as Record<
			string,
			unknown
		>;
		unsafe.business = { notes: "private spoken contact" };
		await writeFile(path, JSON.stringify(unsafe));
		const rejected = Bun.spawnSync(
			["bun", "run", "scripts/observability-report.ts", path],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(rejected.exitCode).not.toBe(0);
		expect(rejected.stdout.toString()).toBe("");
	});
});
