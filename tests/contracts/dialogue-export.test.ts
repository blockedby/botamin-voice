import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildDialogueExport,
	DialogueExportError,
	escapeMarkdownText,
	parseExportArgs,
} from "../../scripts/dialogue-export-reader";
import { writeProtectedDialogueFile } from "../../scripts/dialogues-export";

const LATEST_ID = "01J00000000000000000000003";
const ACTIVE_ID = "01J00000000000000000000002";
const OLD_ID = "01J00000000000000000000001";
const SYNTHETIC_TRANSCRIPT = "Synthetic visitor sentinel@example.invalid";
const SYNTHETIC_ASSISTANT = "Synthetic Botamin reply";
const EXCLUDED_SENTINELS = [
	"excluded-codex-thread",
	"excluded-prompt-version",
	"excluded-source-contact@example.invalid",
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
			) VALUES (?, ?, ?, ?, ?, ?, 'ru-RU', 1, ?, ?, ?, ?)
		`);
		conversation.run(
			OLD_ID,
			"completed",
			"COMPLETE",
			"excluded-codex-thread",
			"excluded-prompt-version",
			"excluded-source-contact@example.invalid",
			"2026-08-01T08:00:00.000Z",
			"2026-08-01T08:00:00.000Z",
			"2026-08-01T08:10:00.000Z",
			"excluded-error-code",
		);
		conversation.run(
			ACTIVE_ID,
			"active",
			"DISCOVERY",
			"excluded-codex-thread",
			"excluded-prompt-version",
			"excluded-source-contact@example.invalid",
			"2026-08-03T09:00:00.000Z",
			"2026-08-03T09:00:00.000Z",
			null,
			"excluded-error-code",
		);
		conversation.run(
			LATEST_ID,
			"completed",
			"COLLECT_BOOKING",
			"excluded-codex-thread",
			"excluded-prompt-version",
			"excluded-source-contact@example.invalid",
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
			"turn-later",
			LATEST_ID,
			"Second synthetic visitor turn",
			"Second synthetic Botamin turn",
			"DISCOVERY",
			"COLLECT_BOOKING",
			"2026-08-04T10:04:00.000Z",
			1,
			"excluded-brain-model",
			"excluded-usage-payload",
		);
		turn.run(
			"turn-earlier",
			LATEST_ID,
			`${SYNTHETIC_TRANSCRIPT}\n\`\`\`unsafe fence\u0001`,
			SYNTHETIC_ASSISTANT,
			"GREETING",
			"DISCOVERY",
			"2026-08-04T10:02:00.000Z",
			0,
			"excluded-brain-model",
			"excluded-usage-payload",
		);
		turn.run(
			"turn-incomplete",
			ACTIVE_ID,
			"Synthetic unfinished visitor turn",
			"",
			"GREETING",
			"GREETING",
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
	environment: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(command, {
		cwd: resolve(import.meta.dir, "../.."),
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

describe("protected dialogue export", () => {
	test("selects the latest conversation, orders turns, and renders explicit flags/times", async () => {
		const fixture = await createFixture();
		try {
			const result = buildDialogueExport(
				fixture.databasePath,
				{ kind: "latest" },
				new Date("2026-08-05T07:00:00.000Z"),
			);
			expect(result.conversationCount).toBe(1);
			expect(result.turnCount).toBe(2);
			expect(result.markdown.indexOf(SYNTHETIC_TRANSCRIPT)).toBeLessThan(
				result.markdown.indexOf("Second synthetic visitor turn"),
			);
			expect(result.markdown).toContain(
				"2026-08-04T10:00:00.000Z UTC / 2026-08-04 13:00:00 MSK (Europe/Moscow, UTC+03:00)",
			);
			expect(result.markdown).toContain("Stage: GREETING → DISCOVERY");
			expect(result.markdown).toContain("- Complete: yes");
			expect(result.markdown).toContain("- Interrupted: yes");
			expect(result.markdown).not.toContain("```");
			expect(result.markdown).toContain("\\\\u0001");
		} finally {
			await removeFixture(fixture);
		}
	});

	test("exports only transcript/status/stage/timestamps and omits internal metadata and IDs", async () => {
		const fixture = await createFixture();
		try {
			const result = buildDialogueExport(fixture.databasePath, {
				kind: "conversation",
				conversationId: LATEST_ID,
			});
			expect(result.markdown).toContain(SYNTHETIC_TRANSCRIPT);
			expect(result.markdown).toContain(SYNTHETIC_ASSISTANT);
			expect(result.markdown).not.toContain(LATEST_ID);
			for (const sentinel of EXCLUDED_SENTINELS) {
				expect(result.markdown).not.toContain(sentinel);
			}
		} finally {
			await removeFixture(fixture);
		}
	});

	test("supports bounded limit/all and complete/interrupted independently", async () => {
		const fixture = await createFixture();
		try {
			const limited = buildDialogueExport(fixture.databasePath, {
				kind: "limit",
				limit: 2,
			});
			expect(limited.conversationCount).toBe(2);
			const all = buildDialogueExport(fixture.databasePath, { kind: "all" });
			expect(all.conversationCount).toBe(3);
			const active = buildDialogueExport(fixture.databasePath, {
				kind: "conversation",
				conversationId: ACTIVE_ID,
			});
			expect(active.markdown).toContain("- Complete: no");
			expect(active.markdown).toContain("- Interrupted: yes");
			expect(active.markdown).toContain("_(no assistant text recorded)_");
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
				) VALUES (?, 'completed', 'COMPLETE', 'synthetic', 'test', 'ru-RU', 1, ?, ?)
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

	test("validates CLI modes and application entity IDs", () => {
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
		for (const invalid of [
			["--limit", "0"],
			["--limit", "101"],
			["--limit", "1.5"],
			["--all", "--limit", "2"],
			["--conversation", "not-an-id"],
			["--conversation", LATEST_ID, "--all"],
			["--unknown"],
		]) {
			expect(() => parseExportArgs(invalid)).toThrow(DialogueExportError);
		}
	});

	test("escapes Markdown fences and visible control characters", () => {
		const escaped = escapeMarkdownText("# title\r\n```x```\t\u0000\u202E");
		expect(escaped).not.toContain("```");
		expect(escaped).toContain("\\# title\n");
		expect(escaped).toContain("\\\\u0000");
		expect(escaped).toContain("\\\\u202E");
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

	test("package CLI writes the local DATABASE_URL export without terminal transcript leakage", async () => {
		const fixture = await createFixture();
		const outputDirectory = join(fixture.directory, "exports");
		try {
			const result = await childOutput(
				[
					process.execPath,
					"run",
					"dialogues:export",
					"--conversation",
					LATEST_ID,
				],
				{
					DATABASE_URL: `file:${fixture.databasePath}`,
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
			expect(contents).toContain(SYNTHETIC_TRANSCRIPT);
		} finally {
			await removeFixture(fixture);
		}
	});

	test("fails with no conversation and leaves no output file", async () => {
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
				[process.execPath, "run", "dialogues:export"],
				{
					DATABASE_URL: `file:${databasePath}`,
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
});
