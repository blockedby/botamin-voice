import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
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
import {
	materializeComposeSecrets,
	parseDotenv,
} from "../../scripts/materialize-compose-secrets";

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "../..");
const scriptPath = join(
	repositoryRoot,
	"scripts/materialize-compose-secrets.ts",
);
const composeAvailable =
	Bun.spawnSync(["docker", "compose", "version"], {
		stdout: "ignore",
		stderr: "ignore",
	}).exitCode === 0;

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("dotenv parsing for Compose secrets", () => {
	test("matches Compose comment, spacing, quoting, and escape rules without eval", async () => {
		const shellMarker = "/tmp/botamin-dotenv-must-not-eval";
		await rm(shellMarker, { force: true });
		const fixture = await readFile(
			join(repositoryRoot, "tests/fixtures/compose-dotenv.env"),
			"utf8",
		);
		const values = parseDotenv(fixture);

		expect(values.HASH).toBe("abc#def");
		expect(values.URL_FRAGMENT).toBe(
			"https://example.test/callback#confirmation",
		);
		expect(values.INLINE_COMMENT).toBe("kept value");
		expect(values.SPACES).toBe("Botamin Voice Demo");
		expect(values.EQUALS).toBe("left=middle=right");
		expect(values.SINGLE).toBe(
			"literal # value = spaces; quote: ' ; slash: \\\\",
		);
		expect(values.DOUBLE).toBe(
			'double # value = spaces; quote: "; slash: \\; newline:\n; tab:\t',
		);
		expect(values.SHELL_LITERAL).toBe(
			"$(touch /tmp/botamin-dotenv-must-not-eval)",
		);
		expect(await Bun.file(shellMarker).exists()).toBeFalse();
	});

	test("treats backticks as unquoted data", () => {
		expect(parseDotenv("VALUE=`literal value`\n").VALUE).toBe(
			"`literal value`",
		);
	});
});

describe("Compose secret materialization", () => {
	test("creates private directories and atomic mode-0600 files", async () => {
		const root = await temporaryRoot(
			"OPENROUTER_API_KEY=mode-test-key\nWEBHOOK_URL=\nWEBHOOK_SIGNING_SECRET=signing=value\n",
		);
		const materialized = await materializeComposeSecrets({ root });
		expect(materialized.map(({ name }) => name)).toEqual([
			"OPENROUTER_API_KEY",
			"WEBHOOK_URL",
			"WEBHOOK_SIGNING_SECRET",
		]);
		expect((await lstat(join(root, ".runtime"))).mode & 0o777).toBe(0o700);
		expect((await lstat(join(root, ".runtime/secrets"))).mode & 0o777).toBe(
			0o700,
		);
		for (const { path } of materialized) {
			const metadata = await lstat(path);
			expect(metadata.isFile()).toBeTrue();
			expect(metadata.isSymbolicLink()).toBeFalse();
			expect(metadata.mode & 0o777).toBe(0o600);
		}
		expect(
			await readFile(join(root, ".runtime/secrets/openrouter_api_key"), "utf8"),
		).toBe("mode-test-key");
	});

	test("rejects a symlink destination without changing its target", async () => {
		const root = await temporaryRoot("OPENROUTER_API_KEY=safe-new-value\n");
		await mkdir(join(root, ".runtime/secrets"), {
			recursive: true,
			mode: 0o700,
		});
		await chmod(join(root, ".runtime"), 0o700);
		await chmod(join(root, ".runtime/secrets"), 0o700);
		const target = join(root, "outside-target");
		await writeFile(target, "do-not-change", { mode: 0o600 });
		await symlink(target, join(root, ".runtime/secrets/openrouter_api_key"));

		await expect(materializeComposeSecrets({ root })).rejects.toThrow(
			"destination is not a safe regular file",
		);
		expect(await readFile(target, "utf8")).toBe("do-not-change");
	});

	test("requires a nonblank OpenRouter key unless allow-blank is explicit", async () => {
		const root = await temporaryRoot(
			"OPENROUTER_API_KEY=   \nWEBHOOK_URL=\nWEBHOOK_SIGNING_SECRET=\n",
		);
		await expect(materializeComposeSecrets({ root })).rejects.toThrow(
			"OPENROUTER_API_KEY must be nonblank",
		);
		await materializeComposeSecrets({ root, allowBlankOpenRouter: true });
		expect(
			await readFile(join(root, ".runtime/secrets/openrouter_api_key"), "utf8"),
		).toBe("");
	});

	test("CLI output contains only safe names and modes", async () => {
		const secret = "never-print-this-openrouter-value";
		const root = await temporaryRoot(
			`OPENROUTER_API_KEY=${secret}\nWEBHOOK_URL=https://private.example/hook\nWEBHOOK_SIGNING_SECRET=never-print-signing\n`,
		);
		const child = Bun.spawn([process.execPath, scriptPath], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(
			"OPENROUTER_API_KEY: openrouter_api_key (mode 0600)",
		);
		expect(`${stdout}${stderr}`).not.toContain(secret);
		expect(`${stdout}${stderr}`).not.toContain("https://private.example/hook");
		expect(`${stdout}${stderr}`).not.toContain("never-print-signing");
	});
});

describe.skipIf(!composeAvailable)("file-backed Compose rendering", () => {
	test("dotenv fixture matches docker compose config", async () => {
		const keys = [
			"HASH",
			"URL_FRAGMENT",
			"INLINE_COMMENT",
			"SPACES",
			"EQUALS",
			"SINGLE",
			"DOUBLE",
			"SHELL_LITERAL",
		] as const;
		const environment = processEnvironment();
		for (const key of keys) delete environment[key];
		const fixturePath = "tests/fixtures/compose-dotenv.env";
		const values = parseDotenv(await readFile(fixturePath, "utf8"));
		const child = Bun.spawn(
			[
				"docker",
				"compose",
				"--env-file",
				fixturePath,
				"-f",
				"tests/fixtures/compose-dotenv.yml",
				"config",
				"--format",
				"json",
			],
			{ cwd: repositoryRoot, env: environment, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const config = JSON.parse(stdout) as {
			services: { probe: { environment: Record<string, string> } };
		};
		const rendered = Object.fromEntries(
			keys.map((key) => [key, config.services.probe.environment[key]]),
		);
		// Compose escapes a literal dollar as $$ in its rendered service model.
		rendered.SHELL_LITERAL = rendered.SHELL_LITERAL?.replaceAll("$$", "$");
		expect(rendered).toEqual(
			Object.fromEntries(keys.map((key) => [key, values[key]])),
		);
		expect(
			await Bun.file("/tmp/botamin-dotenv-must-not-eval").exists(),
		).toBeFalse();
	});

	test("uses explicit file sources and never renders the environment key", async () => {
		const sentinel = "compose-must-not-render-this-key";
		const sourceRoot = "/tmp/botamin-compose-secret-sources";
		const environment = processEnvironment();
		environment.OPENROUTER_API_KEY = sentinel;
		environment.OPENROUTER_API_KEY_FILE = `${sourceRoot}/openrouter_api_key`;
		environment.WEBHOOK_URL_FILE = `${sourceRoot}/webhook_url`;
		environment.WEBHOOK_SIGNING_SECRET_FILE = `${sourceRoot}/webhook_signing_secret`;
		const child = Bun.spawn(
			[
				"docker",
				"compose",
				"--env-file",
				".env.example",
				"config",
				"--format",
				"json",
			],
			{ cwd: repositoryRoot, env: environment, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).not.toContain(sentinel);
		const config = JSON.parse(stdout) as {
			secrets: Record<string, { file: string; environment?: string }>;
		};
		expect(config.secrets.openrouter_api_key?.file).toBe(
			`${sourceRoot}/openrouter_api_key`,
		);
		expect(config.secrets.webhook_url?.file).toBe(`${sourceRoot}/webhook_url`);
		expect(config.secrets.webhook_signing_secret?.file).toBe(
			`${sourceRoot}/webhook_signing_secret`,
		);
		expect(config.secrets.openrouter_api_key?.environment).toBeUndefined();
	});

	test("clean config defaults all blank secret sources to /dev/null", async () => {
		const environment = processEnvironment();
		delete environment.OPENROUTER_API_KEY_FILE;
		delete environment.WEBHOOK_URL_FILE;
		delete environment.WEBHOOK_SIGNING_SECRET_FILE;
		const child = Bun.spawn(
			[
				"docker",
				"compose",
				"--env-file",
				".env.example",
				"config",
				"--format",
				"json",
			],
			{ cwd: repositoryRoot, env: environment, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		const config = JSON.parse(stdout) as {
			secrets: Record<string, { file: string }>;
		};
		expect(Object.values(config.secrets).map(({ file }) => file)).toEqual([
			"/dev/null",
			"/dev/null",
			"/dev/null",
		]);
	});
});

async function temporaryRoot(env: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "botamin-materialize-test-"));
	roots.push(root);
	await writeFile(join(root, ".env"), env, { mode: 0o600 });
	await chmod(join(root, ".env"), 0o600);
	return root;
}

function processEnvironment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}
