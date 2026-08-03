import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
	buildDialogueExport,
	DialogueExportError,
	escapeMarkdownText,
	parseExportArgs,
} from "../../scripts/dialogue-export-reader";
import {
	parseDialogueExportArgs,
	performDialogueExport,
	readFromCompose,
	writeProtectedDialogueFile,
} from "../../scripts/dialogues-export";

const LATEST_ID = "01J00000000000000000000003";
const ACTIVE_ID = "01J00000000000000000000002";
const OLD_ID = "01J00000000000000000000001";
const SYNTHETIC_TRANSCRIPT = "Synthetic visitor sentinel@example.invalid";
const SYNTHETIC_ASSISTANT = "Synthetic Botamin reply";
const PRIVATE_STDERR_SENTINEL = "private-transcript-must-not-escape";
const EXCLUDED_SENTINELS = [
	"excluded-active-status",
	"excluded-completed-status",
	"excluded-complete-stage",
	"excluded-discovery-stage",
	"excluded-booking-stage",
	"excluded-greeting-stage",
	"excluded-codex-thread",
	"excluded-prompt-version",
	"excluded-source-contact@example.invalid",
	"excluded-locale",
	"2026-08-01T08:00:00.000Z",
	"2026-08-01T08:10:00.000Z",
	"2026-08-03T09:00:00.000Z",
	"2026-08-04T10:00:00.000Z",
	"2026-08-04T10:02:00.000Z",
	"2026-08-04T10:04:00.000Z",
	"2026-08-04T10:05:00.000Z",
	"excluded-error-code",
	"excluded-brain-model",
	"excluded-usage-payload",
	"excluded-booking-id",
	"excluded-booking-contact@example.invalid",
	"excluded-domain-event-payload",
];

const schema = `
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
 codex_thread_id TEXT, prompt_version TEXT NOT NULL, source TEXT NOT NULL,
 locale TEXT NOT NULL, qualification_enabled INTEGER NOT NULL,
 consent_at TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
 last_error_code TEXT
);
CREATE TABLE turns (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_text TEXT NOT NULL,
 assistant_text TEXT NOT NULL, state_before TEXT NOT NULL, state_after TEXT NOT NULL,
 speech_final_at TEXT, brain_started_at TEXT, first_text_delta_at TEXT,
 first_audio_at TEXT, completed_at TEXT, interrupted INTEGER NOT NULL DEFAULT 0,
 brain_model TEXT, usage_json TEXT
);
CREATE TABLE bookings (id TEXT, conversation_id TEXT, contacts_json TEXT);
CREATE TABLE domain_events (id TEXT, conversation_id TEXT, payload_json TEXT);
`;

type Fixture = { directory: string; databasePath: string };
type ChildEnvironment = Record<string, string | undefined>;
type FakeDockerCapture = { arguments: string[]; databaseUrl?: string };

async function createFixture(): Promise<Fixture> {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), "dialogue-export-"));
	const databasePath = join(fixtureDirectory, "app.db");
	const database = new Database(databasePath);
	try {
		database.run(schema);
		const conversation = database.prepare(`
			INSERT INTO conversations (
			 id, status, stage, codex_thread_id, prompt_version, source, locale,
			 qualification_enabled, consent_at, started_at, ended_at, last_error_code
			) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
		`);
		conversation.run(
			OLD_ID,
			"excluded-completed-status",
			"excluded-complete-stage",
			"excluded-codex-thread",
			"excluded-prompt-version",
			"excluded-source-contact@example.invalid",
			"excluded-locale",
			"2026-08-01T08:00:00.000Z",
			"2026-08-01T08:00:00.000Z",
			"2026-08-01T08:10:00.000Z",
			"excluded-error-code",
		);
		conversation.run(
			ACTIVE_ID,
			"excluded-active-status",
			"excluded-discovery-stage",
			"excluded-codex-thread",
			"excluded-prompt-version",
			"excluded-source-contact@example.invalid",
			"excluded-locale",
			"2026-08-03T09:00:00.000Z",
			"2026-08-03T09:00:00.000Z",
			null,
			"excluded-error-code",
		);
		conversation.run(
			LATEST_ID,
			"excluded-completed-status",
			"excluded-booking-stage",
			"excluded-codex-thread",
			"excluded-prompt-version",
			"excluded-source-contact@example.invalid",
			"excluded-locale",
			"2026-08-04T10:00:00.000Z",
			"2026-08-04T10:00:00.000Z",
			"2026-08-04T10:05:00.000Z",
			"excluded-error-code",
		);

		const turn = database.prepare(`
			INSERT INTO turns (
			 id, conversation_id, user_text, assistant_text, state_before,
			 state_after, completed_at, interrupted, brain_model, usage_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		// Deliberately insert the later turn first; export ordering is chronological.
		turn.run(
			"excluded-turn-later-id",
			LATEST_ID,
			"Second synthetic visitor turn",
			"Second synthetic Botamin turn",
			"excluded-discovery-stage",
			"excluded-booking-stage",
			"2026-08-04T10:04:00.000Z",
			1,
			"excluded-brain-model",
			"excluded-usage-payload",
		);
		turn.run(
			"excluded-turn-earlier-id",
			LATEST_ID,
			`${SYNTHETIC_TRANSCRIPT}\n\`\`\`unsafe fence\u0001`,
			SYNTHETIC_ASSISTANT,
			"excluded-greeting-stage",
			"excluded-discovery-stage",
			"2026-08-04T10:02:00.000Z",
			0,
			"excluded-brain-model",
			"excluded-usage-payload",
		);
		turn.run(
			"excluded-turn-incomplete-id",
			ACTIVE_ID,
			"Synthetic unfinished visitor turn",
			"",
			"excluded-greeting-stage",
			"excluded-greeting-stage",
			null,
			1,
			"excluded-brain-model",
			"excluded-usage-payload",
		);
		database
			.prepare("INSERT INTO bookings VALUES (?, ?, ?)")
			.run(
				"excluded-booking-id",
				LATEST_ID,
				"excluded-booking-contact@example.invalid",
			);
		database
			.prepare("INSERT INTO domain_events VALUES (?, ?, ?)")
			.run("event-id", LATEST_ID, "excluded-domain-event-payload");
	} finally {
		database.close(false);
	}
	return { directory: fixtureDirectory, databasePath };
}

async function removeFixture(fixture: Fixture): Promise<void> {
	await rm(fixture.directory, { recursive: true, force: true });
}

async function childOutput(
	command: string[],
	environment: ChildEnvironment,
	cwd = resolve(import.meta.dir, "../.."),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...process.env, ...environment },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function createFakeDocker(
	directory: string,
	mode: "success" | "hang" | "huge-stderr",
): Promise<{
	environment: ChildEnvironment;
	capturePath: string;
	pidPath: string;
}> {
	const binDirectory = join(directory, "bin");
	await mkdir(binDirectory, { recursive: true });
	const capturePath = join(directory, "docker-arguments.json");
	const pidPath = join(directory, "grandchild.pid");
	const scriptPath = join(binDirectory, "docker");
	await writeFile(
		scriptPath,
		`#!/usr/bin/env bun
await Bun.write(process.env.FAKE_DOCKER_CAPTURE, JSON.stringify({arguments:Bun.argv.slice(2), databaseUrl:process.env.DATABASE_URL}));
const mode = process.env.FAKE_DOCKER_MODE;
if (mode === "success") {
  process.stdout.write(JSON.stringify({formatVersion:1,conversationCount:1,turnCount:1,markdown:"# Диалоги Botamin\\n\\n## Диалог 1\\n\\n### Реплика 1\\n\\n#### Вы\\n\\nSynthetic compose visitor\\n\\n#### Botamin\\n\\nSynthetic compose reply\\n"}));
} else if (mode === "huge-stderr") {
  process.stderr.write("${PRIVATE_STDERR_SENTINEL}" + "x".repeat(128 * 1024));
  setInterval(() => {}, 1000);
} else {
  const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout:"inherit", stderr:"inherit"});
  await Bun.write(process.env.FAKE_DOCKER_PID, String(grandchild.pid));
  setInterval(() => {}, 1000);
}
`,
		{ mode: 0o755 },
	);
	await chmod(scriptPath, 0o755);
	return {
		capturePath,
		pidPath,
		environment: {
			...process.env,
			PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
			FAKE_DOCKER_MODE: mode,
			FAKE_DOCKER_CAPTURE: capturePath,
			FAKE_DOCKER_PID: pidPath,
		},
	};
}

async function readFakeDockerCapture(path: string): Promise<FakeDockerCapture> {
	return JSON.parse(await readFile(path, "utf8")) as FakeDockerCapture;
}

async function waitUntilProcessGone(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(20);
	}
	return false;
}

describe("protected dialogue export", () => {
	test("selects the latest conversation, orders turns, and renders only role-labelled text", async () => {
		const fixture = await createFixture();
		try {
			const result = buildDialogueExport(fixture.databasePath, {
				kind: "latest",
			});
			expect(result.conversationCount).toBe(1);
			expect(result.turnCount).toBe(2);
			expect(
				result.markdown.indexOf(escapeMarkdownText(SYNTHETIC_TRANSCRIPT)),
			).toBeLessThan(result.markdown.indexOf("Second synthetic visitor turn"));
			expect(result.markdown.match(/^#### Вы$/gmu)).toHaveLength(2);
			expect(result.markdown.match(/^#### Botamin$/gmu)).toHaveLength(2);
			expect(result.markdown).toContain("## Диалог 1");
			expect(result.markdown).toContain("### Реплика 2");
			expect(result.markdown).not.toContain("```");
			expect(result.markdown).toContain("\\\\u0001");
		} finally {
			await removeFixture(fixture);
		}
	});

	test("omits every persisted metadata label and value", async () => {
		const fixture = await createFixture();
		try {
			const result = buildDialogueExport(fixture.databasePath, {
				kind: "conversation",
				conversationId: LATEST_ID,
			});
			expect(result.markdown).toContain(
				escapeMarkdownText(SYNTHETIC_TRANSCRIPT),
			);
			expect(result.markdown).toContain(
				escapeMarkdownText(SYNTHETIC_ASSISTANT),
			);
			for (const sentinel of [
				LATEST_ID,
				"excluded-turn-later-id",
				"excluded-turn-earlier-id",
				...EXCLUDED_SENTINELS,
			]) {
				expect(result.markdown).not.toContain(sentinel);
			}
			for (const label of [
				"Generated:",
				"Started:",
				"Ended:",
				"Status:",
				"Stage:",
				"Complete:",
				"Interrupted:",
				"Model:",
				"Source:",
				"Locale:",
				"Consent:",
				"Thread:",
				"Booking:",
				"Event:",
				"ID:",
			]) {
				expect(result.markdown).not.toContain(label);
			}
			expect(result.markdown).not.toMatch(/2026-08-0[1-5]T/gu);
		} finally {
			await removeFixture(fixture);
		}
	});

	test("preserves bounded latest/limit/all/ID behavior without completion metadata", async () => {
		const fixture = await createFixture();
		try {
			const limited = buildDialogueExport(fixture.databasePath, {
				kind: "limit",
				limit: 2,
			});
			expect(limited.conversationCount).toBe(2);
			expect(limited.markdown).toContain("## Диалог 2");
			const all = buildDialogueExport(fixture.databasePath, { kind: "all" });
			expect(all.conversationCount).toBe(3);
			const active = buildDialogueExport(fixture.databasePath, {
				kind: "conversation",
				conversationId: ACTIVE_ID,
			});
			expect(active.markdown).toContain("Synthetic unfinished visitor turn");
			expect(active.markdown).toContain("#### Botamin\n\n\n");
			expect(active.markdown).not.toContain("Complete:");
			expect(active.markdown).not.toContain("Interrupted:");
		} finally {
			await removeFixture(fixture);
		}
	});

	test("fails closed when --all would exceed the 100-conversation bound", async () => {
		const fixture = await createFixture();
		const database = new Database(fixture.databasePath);
		try {
			const insert = database.prepare(`
				INSERT INTO conversations (
				 id, status, stage, prompt_version, source, locale,
				 qualification_enabled, consent_at, started_at
				) VALUES (?, 'synthetic', 'synthetic', 'synthetic', 'test', 'ru-RU', 1, ?, ?)
			`);
			for (let index = 0; index < 98; index += 1) {
				const timestamp = `2026-07-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
				insert.run(`synthetic-${index}`, timestamp, timestamp);
			}
		} finally {
			database.close(false);
		}
		try {
			expect(() =>
				buildDialogueExport(fixture.databasePath, { kind: "all" }),
			).toThrow(new DialogueExportError("EXPORT_TOO_LARGE"));
		} finally {
			await removeFixture(fixture);
		}
	});

	test("validates selectors and explicit, mutually exclusive sources", () => {
		expect(parseExportArgs([])).toEqual({ kind: "latest" });
		expect(parseExportArgs(["--limit", "100"])).toEqual({
			kind: "limit",
			limit: 100,
		});
		expect(parseExportArgs(["--all"])).toEqual({ kind: "all" });
		expect(
			parseExportArgs([
				"--conversation",
				"01989c10-4d88-7000-8000-000000000001",
			]),
		).toEqual({
			kind: "conversation",
			conversationId: "01989c10-4d88-7000-8000-000000000001",
		});
		expect(
			parseDialogueExportArgs([], {
				DATABASE_URL: "file:./data/app.db",
			}),
		).toEqual({ source: "compose", selection: { kind: "latest" } });
		expect(
			parseDialogueExportArgs(["--source", "direct"], {
				BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL: "file:/tmp/synthetic.db",
			}),
		).toEqual({
			source: "direct",
			databasePath: "/tmp/synthetic.db",
			selection: { kind: "latest" },
		});
		for (const invalid of [
			["--limit", "0"],
			["--limit", "101"],
			["--limit", "1.5"],
			["--all", "--limit", "2"],
			["--conversation", "not-an-id"],
			["--conversation", LATEST_ID, "--all"],
			["--unknown"],
			["--source", "direct"],
			["--source", "compose", "--database", "/tmp/app.db"],
			["--database", "/tmp/app.db"],
			["--source", "direct", "--database", "relative.db"],
			["--source", "direct", "--source", "compose"],
		]) {
			expect(() => parseDialogueExportArgs(invalid, {})).toThrow(
				DialogueExportError,
			);
		}
		expect(() =>
			parseDialogueExportArgs(
				["--source", "direct", "--database", "/tmp/app.db"],
				{
					BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL: "file:/tmp/other.db",
				},
			),
		).toThrow(DialogueExportError);
	});

	test("neutralizes Markdown blocks, HTML-like blocks, and controls", () => {
		const escaped = escapeMarkdownText(
			"# heading\r\n```js\n> quote\n- item\n* item\n+ item\n1. ordered\n- [ ] task\n---\n***\n___\n<div>html</div>\nhttps://example.invalid user@example.invalid\n    indented\tcode\u0000\u202E",
		);
		for (const expected of [
			"\\# heading",
			"\\`\\`\\`js",
			"\\> quote",
			"\\- item",
			"\\* item",
			"\\+ item",
			"1\\. ordered",
			"\\- \\[ \\] task",
			"\\-\\-\\-",
			"\\*\\*\\*",
			"\\_\\_\\_",
			"\\<div\\>html\\<\\/div\\>",
			"https\\:\\/\\/example\\.invalid user\\@example\\.invalid",
			"&#32;&#32;&#32;&#32;indented",
			"\\\\u0000",
			"\\\\u202E",
		]) {
			expect(escaped).toContain(expected);
		}
		for (const line of escaped.split("\n")) {
			expect(line).not.toMatch(
				/^(?: {4}| {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3}|~{3}|<(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div)(?:\s|>|$)))/iu,
			);
		}
	});

	test("creates 0700/0600 paths and removes temp output on an atomic failure", async () => {
		const fixture = await createFixture();
		const outputDirectory = join(fixture.directory, "dialogues");
		try {
			const target = await writeProtectedDialogueFile(
				outputDirectory,
				"synthetic export\n",
				{
					now: new Date("2026-08-05T07:00:00.000Z"),
					randomSuffix: () => "0123456789ab",
				},
			);
			expect(target).not.toContain(LATEST_ID);
			if (process.platform !== "win32") {
				expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700);
				expect((await stat(target)).mode & 0o777).toBe(0o600);
			}
			await rm(target);
			await expect(
				writeProtectedDialogueFile(outputDirectory, "must not appear\n", {
					now: new Date("2026-08-05T07:00:00.000Z"),
					randomSuffix: () => "abcdef012345",
					beforeRename: () => {
						throw new Error("synthetic failure");
					},
				}),
			).rejects.toThrow("synthetic failure");
			expect(await readdir(outputDirectory)).toEqual([]);
		} finally {
			await removeFixture(fixture);
		}
	});

	test("defaults to Compose despite a root dotenv DATABASE_URL and uses /data/app.db", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dialogue-compose-dotenv-"));
		const fake = await createFakeDocker(directory, "success");
		const outputDirectory = join(directory, "exports");
		const repositoryRoot = resolve(import.meta.dir, "../..");
		try {
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({
					private: true,
					scripts: {
						"dialogues:export": `bun ${join(repositoryRoot, "scripts/dialogues-export.ts")}`,
					},
				}),
			);
			await writeFile(
				join(directory, ".env"),
				"DATABASE_URL=file:./data/app.db\n",
			);
			const result = await childOutput(
				[
					process.execPath,
					"run",
					"dialogues:export",
					"--conversation",
					LATEST_ID,
				],
				{
					...fake.environment,
					DATABASE_URL: undefined,
					BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL: undefined,
					DIALOGUES_EXPORT_OUTPUT_DIR: outputDirectory,
				},
				directory,
			);
			expect(result.exitCode).toBe(0);
			expect(`${result.stdout}${result.stderr}`).not.toContain(
				"Synthetic compose visitor",
			);
			const capture = await readFakeDockerCapture(fake.capturePath);
			expect(capture.databaseUrl).toBe("file:./data/app.db");
			expect(capture.arguments.slice(0, 6)).toEqual([
				"compose",
				"exec",
				"-T",
				"app",
				"bun",
				"/app/scripts/dialogue-export-reader.ts",
			]);
			expect(capture.arguments).toContain("/data/app.db");
			expect(capture.arguments).toContain(LATEST_ID);
			expect(await readdir(outputDirectory)).toHaveLength(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("kills a hanging Compose exec process group by deadline and writes no host file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dialogue-compose-hang-"));
		const fake = await createFakeDocker(directory, "hang");
		const outputDirectory = join(directory, "exports");
		try {
			let caught: unknown;
			try {
				await performDialogueExport(
					{ source: "compose", selection: { kind: "latest" } },
					outputDirectory,
					{
						environment: fake.environment,
						timeoutMs: 150,
						terminateGraceMs: 50,
						terminateWaitMs: 500,
					},
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toEqual(new DialogueExportError("DATABASE_UNAVAILABLE"));
			expect(String(caught)).not.toContain(PRIVATE_STDERR_SENTINEL);
			expect(await readdir(outputDirectory).catch(() => [])).toEqual([]);
			const grandchildPid = Number(await readFile(fake.pidPath, "utf8"));
			expect(await waitUntilProcessGone(grandchildPid)).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("bounds huge Compose stderr, suppresses it, and writes no host file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dialogue-compose-stderr-"));
		const fake = await createFakeDocker(directory, "huge-stderr");
		const outputDirectory = join(directory, "exports");
		try {
			let caught: unknown;
			try {
				await performDialogueExport(
					{ source: "compose", selection: { kind: "latest" } },
					outputDirectory,
					{
						environment: fake.environment,
						timeoutMs: 2_000,
						terminateGraceMs: 50,
						terminateWaitMs: 500,
					},
				);
			} catch (error) {
				caught = error;
			}
			expect(caught).toEqual(new DialogueExportError("DATABASE_UNAVAILABLE"));
			expect(String(caught)).not.toContain(PRIVATE_STDERR_SENTINEL);
			expect(await readdir(outputDirectory).catch(() => [])).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("package CLI requires explicit direct source and never leaks transcript to terminal", async () => {
		const fixture = await createFixture();
		const outputDirectory = join(fixture.directory, "exports");
		try {
			const result = await childOutput(
				[
					process.execPath,
					"run",
					"dialogues:export",
					"--source",
					"direct",
					"--database",
					fixture.databasePath,
					"--conversation",
					LATEST_ID,
				],
				{
					DATABASE_URL: `file:${join(fixture.directory, "wrong.db")}`,
					BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL: undefined,
					DIALOGUES_EXPORT_OUTPUT_DIR: outputDirectory,
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(
				/^dialogues export: status=ok conversations=1 turns=2 path=/u,
			);
			for (const privateText of [
				SYNTHETIC_TRANSCRIPT,
				SYNTHETIC_ASSISTANT,
				...EXCLUDED_SENTINELS,
			]) {
				expect(`${result.stdout}${result.stderr}`).not.toContain(privateText);
			}
			const files = await readdir(outputDirectory);
			expect(files).toHaveLength(1);
			const contents = await readFile(
				join(outputDirectory, files[0] as string),
				"utf8",
			);
			expect(contents).toContain(escapeMarkdownText(SYNTHETIC_TRANSCRIPT));
		} finally {
			await removeFixture(fixture);
		}
	});

	test("fails with no direct conversation and leaves no output file", async () => {
		const fixtureDirectory = await mkdtemp(
			join(tmpdir(), "dialogue-export-empty-"),
		);
		const databasePath = join(fixtureDirectory, "empty.db");
		const database = new Database(databasePath);
		database.run(schema);
		database.close(false);
		const outputDirectory = join(fixtureDirectory, "exports");
		try {
			const result = await childOutput(
				[
					process.execPath,
					"run",
					"dialogues:export",
					"--source",
					"direct",
					"--database",
					databasePath,
				],
				{
					DATABASE_URL: undefined,
					BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL: undefined,
					DIALOGUES_EXPORT_OUTPUT_DIR: outputDirectory,
				},
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"dialogues export: status=failed conversations=0 turns=0 path=none reason=no-conversation\n",
			);
			expect(await readdir(outputDirectory).catch(() => [])).toEqual([]);
		} finally {
			await rm(fixtureDirectory, { recursive: true, force: true });
		}
	});

	test("Compose reader command cannot be redirected to a non-volume database", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "dialogue-compose-command-"),
		);
		const fake = await createFakeDocker(directory, "success");
		try {
			await readFromCompose(
				{ kind: "limit", limit: 2 },
				{ environment: fake.environment, timeoutMs: 2_000 },
			);
			const capture = await readFakeDockerCapture(fake.capturePath);
			expect(capture.arguments).toContain("--database");
			expect(capture.arguments).toContain("/data/app.db");
			expect(capture.arguments).not.toContain("DATABASE_URL");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
