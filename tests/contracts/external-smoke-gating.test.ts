import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

async function runWithoutOptIn(script: string) {
	const env = { ...Bun.env };
	delete env.OPENROUTER_EXTERNAL_SMOKE;
	delete env.OPENROUTER_API_KEY;
	const child = Bun.spawn(["bun", "run", script], {
		cwd: root,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("external paid OpenRouter smoke exclusion", () => {
	for (const kind of ["stt", "tts"] as const) {
		test(`${kind} smoke is not run by default and requires explicit paid opt-in`, async () => {
			const script = `scripts/openrouter-${kind}-smoke.ts`;
			const result = await runWithoutOptIn(script);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toBe("");
			const evidence = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(evidence).toMatchObject({
				smoke: `openrouter-${kind}`,
				status: "not_run",
				reason: "opt_in_required",
				bytes: 0,
			});
			const source = await readFile(join(root, script), "utf8");
			expect(source).toContain('OPENROUTER_EXTERNAL_SMOKE !== "1"');
		});
	}

	test("the explicit runner dispatches only the two guarded paid entrypoints", async () => {
		const runner = await readFile(
			join(root, "scripts/run-openrouter-smoke.sh"),
			"utf8",
		);
		expect(runner).toContain("openrouter-stt-smoke.ts");
		expect(runner).toContain("openrouter-tts-smoke.ts");
		expect(runner).toContain("intentionally paid and opt-in");
	});

	test("the TTS smoke selects its env profile and reports no audio or identifiers", async () => {
		const source = await readFile(
			join(root, "scripts/openrouter-tts-smoke.ts"),
			"utf8",
		);
		for (const aggregate of ["contentType", "bytes", "latencyMs"]) {
			expect(source).toContain(aggregate);
		}
		expect(source).toContain("loadOpenRouterVoiceConfig()");
		for (const forbidden of [
			"Bun.write",
			"artifact",
			"providerGenerationId",
			"config.tts.model",
			"config.tts.voice",
		]) {
			expect(source).not.toContain(forbidden);
		}
	});
});
