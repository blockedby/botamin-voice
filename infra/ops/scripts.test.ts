import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("bounded readiness checks", () => {
	test("rejects live-but-unready and accepts ready", async () => {
		let ready = false;
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/health/live") return new Response("ok");
				if (path === "/health/ready" && ready) return new Response("ready");
				return new Response("unready", { status: 503 });
			},
		});
		try {
			const env = {
				...process.env,
				READY_MAX_ATTEMPTS: "2",
				READY_INTERVAL_SECONDS: "0",
				READY_REQUEST_TIMEOUT_SECONDS: "1",
			};
			const failed = Bun.spawn(
				["sh", "scripts/wait-ready.sh", `${server.url}health/ready`],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			expect(await failed.exited).not.toBe(0);
			expect(await new Response(failed.stderr).text()).toContain(
				"Readiness did not become available",
			);

			ready = true;
			const passed = Bun.spawn(
				["sh", "scripts/wait-ready.sh", `${server.url}health/ready`],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			expect(await passed.exited).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test("restore verifies before stop and restore/rollback require readiness", async () => {
		const restore = await readFile("scripts/restore.sh", "utf8");
		const rollback = await readFile("scripts/rollback.sh", "utf8");
		expect(restore.indexOf("verify-backup")).toBeGreaterThan(0);
		expect(restore.indexOf("verify-backup")).toBeLessThan(
			restore.indexOf("docker compose stop app"),
		);
		expect(restore).toContain("/health/ready");
		expect(rollback).toContain("/health/ready");
		expect(restore).toContain("scripts/wait-ready.sh");
		expect(rollback).toContain("scripts/wait-ready.sh");
	});
});

describe("file-backed Compose secret wiring", () => {
	test("deploy wrappers materialize and export every source before Compose", async () => {
		for (const path of [
			"scripts/deploy-local.sh",
			"scripts/deploy-production.sh",
		]) {
			const deployment = await readFile(path, "utf8");
			expect(deployment).toContain(
				"bun scripts/materialize-compose-secrets.ts",
			);
			expect(deployment).toContain("export OPENROUTER_API_KEY_FILE=");
			expect(deployment).toContain("export WEBHOOK_URL_FILE=");
			expect(deployment).toContain("export WEBHOOK_SIGNING_SECRET_FILE=");
			expect(deployment.indexOf("materialize-compose-secrets.ts")).toBeLessThan(
				deployment.indexOf("docker compose"),
			);
			expect(deployment).not.toMatch(/(?:source|\.)\s+\.env(?:\s|$)/m);
		}
	});

	test("device auth uses explicit blank files and recovery keeps deployed files", async () => {
		const deviceAuth = await readFile("scripts/device-auth.sh", "utf8");
		expect(deviceAuth).toContain("export OPENROUTER_API_KEY_FILE=/dev/null");
		expect(deviceAuth).toContain("export WEBHOOK_URL_FILE=/dev/null");
		expect(deviceAuth).toContain(
			"export WEBHOOK_SIGNING_SECRET_FILE=/dev/null",
		);
		for (const path of [
			"scripts/backup.sh",
			"scripts/restore.sh",
			"scripts/rollback.sh",
		]) {
			const operation = await readFile(path, "utf8");
			expect(operation).toContain(".runtime/secrets");
			expect(operation).toContain("export OPENROUTER_API_KEY_FILE=");
		}
	});
});

describe("OpenRouter smoke guard", () => {
	test("fails explicitly when an A2 smoke entrypoint is absent", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-smoke-test-"));
		temporaryDirectories.push(directory);
		const process = Bun.spawn(
			["sh", "scripts/run-openrouter-smoke.sh", "stt"],
			{
				env: { ...processEnv(), BOTAMIN_APP_ROOT: directory },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await process.exited).toBe(69);
		expect(await new Response(process.stderr).text()).toContain(
			"smoke integration is missing from this image",
		);
	});
});

function processEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}
