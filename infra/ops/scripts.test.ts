import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "../..");

interface WrapperRoot {
	root: string;
	commandLog: string;
	env: Record<string, string>;
}

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
	test("deploy wrappers force app recreation before Caddy and readiness", async () => {
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
			expect(deployment).toContain(
				"docker compose up -d --no-deps --force-recreate app",
			);
			if (path === "scripts/deploy-local.sh") {
				expect(deployment).toContain(
					"docker compose ps --status running --services app",
				);
				expect(deployment).toContain("docker compose stop --timeout 30 app");
				expect(deployment).toContain("bun /app/ops/db.js verify-rc4");
				expect(deployment).toContain("AUTO_MIGRATE=true docker compose up");
				expect(deployment).not.toContain(
					"AUTO_MIGRATE=false app bun /app/ops/db.js migrate",
				);
			}
			expect(deployment).toContain("docker compose up -d caddy");
			expect(deployment.indexOf("--force-recreate app")).toBeLessThan(
				deployment.indexOf("docker compose up -d caddy"),
			);
			expect(deployment.indexOf("docker compose up -d caddy")).toBeLessThan(
				deployment.indexOf("scripts/wait-ready.sh"),
			);
			expect(deployment).toContain("/health/ready");
			expect(deployment).not.toMatch(/(?:source|\.)\s+\.env(?:\s|$)/m);
		}
	});

	test("deploy commands consume the newly materialized inode without logging values", async () => {
		for (const script of ["deploy-local.sh", "deploy-production.sh"]) {
			const fixture = await createDeploymentRoot(script);
			const oldInode = (
				await lstat(join(fixture.root, ".runtime/secrets/openrouter_api_key"))
			).ino;
			const result = await runWrapper(fixture, script);
			expect(result.exitCode).toBe(0);
			const newInode = (
				await lstat(join(fixture.root, ".runtime/secrets/openrouter_api_key"))
			).ino;
			expect(newInode).not.toBe(oldInode);
			const commands = await readFile(fixture.commandLog, "utf8");
			if (script === "deploy-local.sh") {
				expect(commands).not.toContain("db.js migrate");
				expect(commands).toContain(
					"compose ps --status running --services app",
				);
				expect(commands).toContain(
					"compose run --rm --no-deps --entrypoint sh app -c [ -f /data/app.db ]",
				);
				expect(commands).toContain(
					"compose exec -T app bun /app/ops/db.js verify-rc4",
				);
			} else {
				expect(commands).toContain(
					"compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate",
				);
			}
			if (script === "deploy-production.sh") {
				expect(commands).toContain(
					"compose run --rm -e AUTO_MIGRATE=false app codex login status",
				);
			}
			const migrationIndex = commands.indexOf(
				"compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate",
			);
			const recreateIndex = commands.indexOf(
				"compose up -d --no-deps --force-recreate app",
			);
			const caddyIndex = commands.indexOf("compose up -d caddy");
			const readinessIndex = commands.indexOf("wait-ready ");
			if (script === "deploy-production.sh") {
				expect(migrationIndex).toBeGreaterThanOrEqual(0);
			}
			expect(recreateIndex).toBeGreaterThan(migrationIndex);
			expect(caddyIndex).toBeGreaterThan(recreateIndex);
			expect(readinessIndex).toBeGreaterThan(caddyIndex);
			const allOutput = `${result.stdout}${result.stderr}${commands}`;
			expect(allOutput).not.toContain(fixture.env.EXPECTED_OPENROUTER);
			expect(allOutput).not.toContain("old-openrouter-value");
		}
	});

	test("local cutover backs up and stops a running app before startup migration", async () => {
		const fixture = await createDeploymentRoot("deploy-local.sh");
		fixture.env.FAKE_APP_RUNNING = "true";
		const result = await runWrapper(fixture, "deploy-local.sh");
		expect(result.exitCode).toBe(0);
		const commands = await readFile(fixture.commandLog, "utf8");
		const backupIndex = commands.indexOf(
			"compose exec -T app bun /app/ops/db.js backup",
		);
		const stopIndex = commands.indexOf("compose stop --timeout 30 app");
		const startIndex = commands.indexOf(
			"compose up -d --no-deps --force-recreate app",
		);
		const readinessIndex = commands.indexOf("wait-ready ");
		const verificationIndex = commands.indexOf(
			"compose exec -T app bun /app/ops/db.js verify-rc4",
		);
		expect(backupIndex).toBeGreaterThanOrEqual(0);
		expect(stopIndex).toBeGreaterThan(backupIndex);
		expect(startIndex).toBeGreaterThan(stopIndex);
		expect(readinessIndex).toBeGreaterThan(startIndex);
		expect(verificationIndex).toBeGreaterThan(readinessIndex);
		expect(commands).not.toContain("db.js migrate");
	});

	test("local cutover protects an existing stopped database before startup", async () => {
		const fixture = await createDeploymentRoot("deploy-local.sh");
		fixture.env.FAKE_DB_EXISTS = "true";
		const result = await runWrapper(fixture, "deploy-local.sh");
		expect(result.exitCode).toBe(0);
		const commands = await readFile(fixture.commandLog, "utf8");
		const probeIndex = commands.indexOf(
			"compose run --rm --no-deps --entrypoint sh app -c [ -f /data/app.db ]",
		);
		const backupIndex = commands.indexOf(
			"compose run --rm --no-deps --entrypoint bun -e AUTO_MIGRATE=false app /app/ops/db.js backup",
		);
		const startIndex = commands.indexOf(
			"compose up -d --no-deps --force-recreate app",
		);
		expect(probeIndex).toBeGreaterThanOrEqual(0);
		expect(backupIndex).toBeGreaterThan(probeIndex);
		expect(startIndex).toBeGreaterThan(backupIndex);
		expect(commands).not.toContain("compose stop --timeout 30 app");
	});

	test("device auth uses explicit blank files", async () => {
		const deviceAuth = await readFile("scripts/device-auth.sh", "utf8");
		expect(deviceAuth).toContain("export OPENROUTER_API_KEY_FILE=/dev/null");
		expect(deviceAuth).toContain("export WEBHOOK_URL_FILE=/dev/null");
		expect(deviceAuth).toContain(
			"export WEBHOOK_SIGNING_SECRET_FILE=/dev/null",
		);
	});
});

describe("recovery wrapper secret-file safety", () => {
	test("uses file predicates and numeric metadata only", async () => {
		const helper = await readFile("scripts/compose-secret-files.sh", "utf8");
		expect(helper).toContain('[ ! -f "$compose_secret_path" ]');
		expect(helper).toContain('[ -L "$compose_secret_path" ]');
		expect(helper).toContain("stat -c '%a:%u:%h'");
		expect(helper).toContain(
			'[ ! -s "$compose_secret_dir/openrouter_api_key" ]',
		);
		expect(helper).not.toContain("%F");
		for (const script of ["backup.sh", "restore.sh", "rollback.sh"]) {
			expect(await readFile(`scripts/${script}`, "utf8")).toContain(
				". scripts/compose-secret-files.sh",
			);
		}
	});

	test("blank optional webhook files reach every intended command under locales", async () => {
		const locales = availableTestLocales();
		const cases = [
			{
				script: "backup.sh",
				args: [] as string[],
				expected: "compose exec -T app bun /app/ops/db.js backup",
			},
			{
				script: "restore.sh",
				args: ["/data/backups/fixture.db"],
				expected: "app /app/ops/db.js restore /data/backups/fixture.db",
			},
			{
				script: "rollback.sh",
				args: ["botamin:test"],
				expected: "app bun /app/ops/db.js migrate",
			},
		];
		for (const locale of locales) {
			for (const item of cases) {
				const fixture = await createRecoveryRoot(item.script);
				fixture.env.LC_ALL = locale;
				const result = await runWrapper(fixture, item.script, item.args);
				expect(result.exitCode).toBe(0);
				const commands = await readFile(fixture.commandLog, "utf8");
				expect(commands).toContain(item.expected);
				expect(commands).not.toContain(fixture.env.EXPECTED_OPENROUTER);
			}
		}
	});

	test("all recovery wrappers reject a whitespace-only OpenRouter file before Docker", async () => {
		for (const item of recoveryCases()) {
			const fixture = await createRecoveryRoot(item.script);
			await writeFile(
				join(fixture.root, ".runtime/secrets/openrouter_api_key"),
				" \t\n",
				{ mode: 0o600 },
			);
			const result = await runWrapper(fixture, item.script, item.args);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("must be nonblank");
			expect(await readFile(fixture.commandLog, "utf8")).toBe("");
		}
	});

	test("all recovery wrappers reject a symlink before Docker", async () => {
		for (const item of recoveryCases()) {
			const fixture = await createRecoveryRoot(item.script);
			const webhook = join(fixture.root, ".runtime/secrets/webhook_url");
			const target = join(fixture.root, "outside-webhook");
			await writeFile(target, "", { mode: 0o600 });
			await rm(webhook);
			await symlink(target, webhook);
			const result = await runWrapper(fixture, item.script, item.args);
			expect(result.exitCode).not.toBe(0);
			expect(await readFile(fixture.commandLog, "utf8")).toBe("");
		}
	});

	test("rejects a hard-linked secret by numeric link count", async () => {
		const fixture = await createRecoveryRoot("backup.sh");
		await link(
			join(fixture.root, ".runtime/secrets/webhook_url"),
			join(fixture.root, "webhook-hardlink"),
		);
		const result = await runWrapper(fixture, "backup.sh");
		expect(result.exitCode).not.toBe(0);
		expect(await readFile(fixture.commandLog, "utf8")).toBe("");
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

async function createDeploymentRoot(script: string): Promise<WrapperRoot> {
	const expectedOpenRouter = `new-openrouter-${script}`;
	const fixture = await createWrapperRoot([
		script,
		"materialize-compose-secrets.ts",
	]);
	await writeFile(
		join(fixture.root, ".env"),
		`APP_ORIGIN=${script === "deploy-production.sh" ? "https://voice.example.test" : "http://localhost:5173"}\nOPENROUTER_API_KEY=${expectedOpenRouter}\nWEBHOOK_URL=\nWEBHOOK_SIGNING_SECRET=\n`,
		{ mode: 0o600 },
	);
	await chmod(join(fixture.root, ".env"), 0o600);
	await createSecretFiles(fixture.root, "old-openrouter-value");
	fixture.env.EXPECTED_OPENROUTER = expectedOpenRouter;
	fixture.env.SITE_ADDRESS = "voice.example.test";
	fixture.env.LOCAL_READY_MAX_ATTEMPTS = "1";
	fixture.env.PRODUCTION_READY_MAX_ATTEMPTS = "1";
	if (script === "deploy-local.sh") fixture.env.EXPECT_AUTO_MIGRATE = "true";
	return fixture;
}

async function createRecoveryRoot(script: string): Promise<WrapperRoot> {
	const fixture = await createWrapperRoot([script, "compose-secret-files.sh"]);
	await createSecretFiles(fixture.root, "recovery-openrouter-value");
	fixture.env.EXPECTED_OPENROUTER = "recovery-openrouter-value";
	return fixture;
}

async function createWrapperRoot(scripts: string[]): Promise<WrapperRoot> {
	const root = await mkdtemp(join(tmpdir(), "botamin-wrapper-test-"));
	temporaryDirectories.push(root);
	const scriptsDirectory = join(root, "scripts");
	const binDirectory = join(root, "fake-bin");
	const commandLog = join(root, "commands.log");
	await mkdir(scriptsDirectory, { mode: 0o700 });
	await mkdir(binDirectory, { mode: 0o700 });
	await writeFile(commandLog, "", { mode: 0o600 });
	for (const script of scripts) {
		await copyFile(
			join(repositoryRoot, "scripts", script),
			join(scriptsDirectory, script),
		);
		await chmod(join(scriptsDirectory, script), 0o755);
	}
	await writeExecutable(
		join(binDirectory, "docker"),
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  compose*)
    test "$OPENROUTER_API_KEY_FILE" = "$EXPECTED_SECRET_DIR/openrouter_api_key"
    test "$WEBHOOK_URL_FILE" = "$EXPECTED_SECRET_DIR/webhook_url"
    test "$WEBHOOK_SIGNING_SECRET_FILE" = "$EXPECTED_SECRET_DIR/webhook_signing_secret"
    test "$(cat "$OPENROUTER_API_KEY_FILE")" = "$EXPECTED_OPENROUTER"
    test ! -s "$WEBHOOK_URL_FILE"
    test ! -s "$WEBHOOK_SIGNING_SECRET_FILE"
    ;;
esac
case "$*" in
  "compose ps --status running --services app")
    if [ "\${FAKE_APP_RUNNING:-false}" = "true" ]; then printf '%s\\n' app; fi
    exit 0
    ;;
  "compose run --rm --no-deps --entrypoint sh app -c [ -f /data/app.db ]")
    if [ "\${FAKE_DB_EXISTS:-false}" = "true" ]; then exit 0; fi
    exit 1
    ;;
  "compose up -d --no-deps --force-recreate app")
    if [ "\${EXPECT_AUTO_MIGRATE:-false}" = "true" ]; then
      test "\${AUTO_MIGRATE:-}" = "true"
    fi
    ;;
  "compose config") printf '%s\\n' 'services: {}' ;;
esac
`,
	);
	await symlink(process.execPath, join(binDirectory, "bun"));
	await writeExecutable(
		join(scriptsDirectory, "assert-image-content.sh"),
		`#!/bin/sh
set -eu
printf 'assert-image %s\\n' "$*" >> "$COMMAND_LOG"
`,
	);
	await writeExecutable(
		join(scriptsDirectory, "wait-ready.sh"),
		`#!/bin/sh
set -eu
test "$(cat "$OPENROUTER_API_KEY_FILE")" = "$EXPECTED_OPENROUTER"
test ! -s "$WEBHOOK_URL_FILE"
test ! -s "$WEBHOOK_SIGNING_SECRET_FILE"
printf 'wait-ready %s\\n' "$*" >> "$COMMAND_LOG"
`,
	);
	const expectedSecretDirectory = join(root, ".runtime/secrets");
	return {
		root,
		commandLog,
		env: {
			...processEnv(),
			PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
			COMMAND_LOG: commandLog,
			EXPECTED_SECRET_DIR: expectedSecretDirectory,
		},
	};
}

async function createSecretFiles(
	root: string,
	openRouter: string,
): Promise<void> {
	await mkdir(join(root, ".runtime/secrets"), { recursive: true, mode: 0o700 });
	await chmod(join(root, ".runtime"), 0o700);
	await chmod(join(root, ".runtime/secrets"), 0o700);
	for (const [name, value] of [
		["openrouter_api_key", openRouter],
		["webhook_url", ""],
		["webhook_signing_secret", ""],
	] as const) {
		await writeFile(join(root, ".runtime/secrets", name), value, {
			mode: 0o600,
		});
		await chmod(join(root, ".runtime/secrets", name), 0o600);
	}
}

async function writeExecutable(path: string, content: string): Promise<void> {
	await writeFile(path, content, { mode: 0o755 });
	await chmod(path, 0o755);
}

async function runWrapper(
	fixture: WrapperRoot,
	script: string,
	args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["sh", `scripts/${script}`, ...args], {
		cwd: fixture.root,
		env: fixture.env,
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

function recoveryCases(): Array<{ script: string; args: string[] }> {
	return [
		{ script: "backup.sh", args: [] },
		{ script: "restore.sh", args: ["/data/backups/fixture.db"] },
		{ script: "rollback.sh", args: ["botamin:test"] },
	];
}

function availableTestLocales(): string[] {
	const result = Bun.spawnSync(["locale", "-a"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const available = new TextDecoder().decode(result.stdout).split(/\s+/);
	const utf8 = available.find((locale) => /^C\.(?:UTF-?8|utf8)$/i.test(locale));
	return utf8 === undefined ? ["C"] : ["C", utf8];
}

function processEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}
