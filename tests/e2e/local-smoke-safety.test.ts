import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const script = "scripts/local-voice-e2e-smoke.ts";

async function run(env: Record<string, string | undefined>) {
	const child = Bun.spawn(["bun", "run", script], {
		cwd: root,
		env: { ...Bun.env, ...env },
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

describe("T30 opt-in local voice smoke safety", () => {
	test("is external and inert without the explicit owner opt-in", async () => {
		const result = await run({ BOTAMIN_EXTERNAL_VOICE_E2E: undefined });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(output).toMatchObject({
			smoke: "local-voice-e2e",
			external: true,
			status: "not_run",
			reason: "opt_in_required",
			booking: false,
		});
	});

	test("configuration failures expose only the safe aggregate schema", async () => {
		const result = await run({ BOTAMIN_EXTERNAL_VOICE_E2E: "1" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(Object.keys(output).sort()).toEqual(
			[
				"booking",
				"counts",
				"eventTypes",
				"external",
				"models",
				"reason",
				"smoke",
				"status",
				"timingsMs",
			].sort(),
		);
		expect(result.stdout).not.toMatch(
			/"(?:conversationId|turnId|generationId|segmentId|bookingId|transcript|speech|key|audio|base64)"\s*:/iu,
		);
		const source = await readFile(join(root, script), "utf8");
		expect(source.match(/console\.(?:info|log|error|warn)/gu)).toEqual([
			"console.info",
		]);
		expect(source).toContain("BOTAMIN_EXTERNAL_VOICE_E2E");
		expect(source).toContain("--pcm");
		expect(source).toContain("--fixture");
	});
});
