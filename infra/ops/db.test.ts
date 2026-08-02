import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function runDb(
	command: string[],
	databasePath: string,
	extraEnv: Record<string, string> = {},
): Bun.SpawnSyncReturns<Buffer, Buffer> {
	return Bun.spawnSync(["bun", "run", "infra/ops/db.ts", ...command], {
		cwd: join(import.meta.dir, "../.."),
		env: {
			...process.env,
			DATABASE_URL: `file:${databasePath}`,
			MIGRATIONS_DIR: join(import.meta.dir, "../../drizzle"),
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("protected SQLite backup and restore", () => {
	test("writes a protected SHA-256 sidecar and restores a verified backup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-db-test-"));
		temporaryDirectories.push(directory);
		const active = join(directory, "active.db");
		const backup = join(directory, "backups", "verified.db");

		expect(runDb(["migrate"], active).exitCode).toBe(0);
		expect(runDb(["backup", backup], active).exitCode).toBe(0);

		const bytes = await readFile(backup);
		const sidecar = await readFile(`${backup}.sha256`, "utf8");
		expect(sidecar).toBe(`${digest(bytes)}  verified.db\n`);
		expect((await stat(`${backup}.sha256`)).mode & 0o777).toBe(0o600);
		expect(runDb(["verify-backup", backup], active).exitCode).toBe(0);
		expect(
			runDb(["restore", backup], active, {
				BOTAMIN_RESTORE_CONFIRMED: "true",
			}).exitCode,
		).toBe(0);
	});

	test("rejects a tampered but valid SQLite backup without touching the active DB", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-db-test-"));
		temporaryDirectories.push(directory);
		const active = join(directory, "active.db");
		const backup = join(directory, "backups", "tampered.db");

		expect(runDb(["migrate"], active).exitCode).toBe(0);
		expect(runDb(["backup", backup], active).exitCode).toBe(0);
		const activeBefore = digest(await readFile(active));

		const client = new Database(backup);
		client.run("CREATE TABLE checksum_tamper (id INTEGER PRIMARY KEY)");
		client.close(false);
		const integrity = new Database(backup, { readonly: true })
			.query("PRAGMA integrity_check")
			.get() as { integrity_check: string };
		expect(integrity.integrity_check).toBe("ok");

		const result = runDb(["restore", backup], active, {
			BOTAMIN_RESTORE_CONFIRMED: "true",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("SHA-256 mismatch");
		expect(digest(await readFile(active))).toBe(activeBefore);
	});

	test("rejects a sidecar with group or other permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-db-test-"));
		temporaryDirectories.push(directory);
		const active = join(directory, "active.db");
		const backup = join(directory, "backups", "permissive.db");

		expect(runDb(["migrate"], active).exitCode).toBe(0);
		expect(runDb(["backup", backup], active).exitCode).toBe(0);
		await chmod(`${backup}.sha256`, 0o644);
		const result = runDb(["verify-backup", backup], active);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"must not grant group or other permissions",
		);
	});
});

describe("RC4 schema verification", () => {
	test("verifies the RC4 schema and upgrades an RC3 database", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-rc4-test-"));
		temporaryDirectories.push(directory);
		const rc3Migrations = join(directory, "rc3-drizzle");
		await mkdir(join(rc3Migrations, "meta"), { recursive: true });
		const currentMigrations = join(import.meta.dir, "../../drizzle");
		const journal = JSON.parse(
			await readFile(join(currentMigrations, "meta/_journal.json"), "utf8"),
		) as { entries: Array<{ tag: string }> };
		const entries = journal.entries.slice(0, 4);
		for (const entry of entries) {
			await copyFile(
				join(currentMigrations, `${entry.tag}.sql`),
				join(rc3Migrations, `${entry.tag}.sql`),
			);
		}
		await writeFile(
			join(rc3Migrations, "meta/_journal.json"),
			JSON.stringify({ ...journal, entries }),
		);

		const active = join(directory, "rc3.db");
		expect(
			runDb(["migrate"], active, { MIGRATIONS_DIR: rc3Migrations }).exitCode,
		).toBe(0);
		const rc3 = new Database(active);
		rc3.run(
			`INSERT INTO conversations
			 (id, status, stage, prompt_version, source, locale,
			  qualification_enabled, consent_at, started_at)
			 VALUES (?, 'completed', 'COMPLETE', 'rc3-prompt', 'landing', 'ru-RU', 1, ?, ?)`,
			[
				"conversation-rc3",
				"2026-08-01T09:00:00.000Z",
				"2026-08-01T09:00:00.000Z",
			],
		);
		rc3.run(
			`INSERT INTO bookings
			 (id, conversation_id, status, name, contacts_json, company,
			  qualification_json, qualification_status, created_at, updated_at,
			  meeting_start_at, meeting_end_at, meeting_timezone)
			 VALUES (?, ?, 'booked', 'RC3 user', ?, 'RC3 company', '{}', 'none', ?, ?, ?, ?, 'Europe/Moscow')`,
			[
				"booking-rc3",
				"conversation-rc3",
				JSON.stringify([
					{ channel: "email", value: "rc3@example.test" },
					{ channel: "telegram", value: "@rc3_test" },
				]),
				"2026-08-01T09:00:00.000Z",
				"2026-08-01T09:00:00.000Z",
				"2026-08-03T06:00:00.000Z",
				"2026-08-03T06:20:00.000Z",
			],
		);
		rc3.close(false);

		expect(runDb(["verify-rc4"], active).exitCode).not.toBe(0);
		expect(runDb(["migrate"], active).exitCode).toBe(0);
		expect(runDb(["verify-rc4"], active).exitCode).toBe(0);
		const upgraded = new Database(active, { readonly: true });
		expect(
			upgraded.query("SELECT id FROM bookings WHERE id = ?").get("booking-rc3"),
		).toEqual({ id: "booking-rc3" });
		expect(
			upgraded
				.query("SELECT count(*) AS count FROM conversation_contexts")
				.get(),
		).toEqual({ count: 0 });
		upgraded.close(false);
	});

	test("rejects a persisted revision mismatch without exposing draft data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-rc4-row-invalid-"));
		temporaryDirectories.push(directory);
		const active = join(directory, "active.db");
		expect(runDb(["migrate"], active).exitCode).toBe(0);
		const client = new Database(active);
		client.run("PRAGMA ignore_check_constraints = ON");
		client.run(
			`INSERT INTO conversations
			 (id, status, stage, prompt_version, source, locale,
			  qualification_enabled, consent_at, started_at)
			 VALUES ('conversation-invalid', 'active', 'COLLECT_BOOKING',
			  'prompt', 'landing', 'ru-RU', 1, ?, ?)`,
			["2026-08-02T09:00:00.000Z", "2026-08-02T09:00:00.000Z"],
		);
		client.run(
			`INSERT INTO conversation_contexts
			 (conversation_id, revision, draft_json, updated_at)
			 VALUES ('conversation-invalid', 1, ?, ?)`,
			[
				JSON.stringify({
					revision: 1,
					factRegistry: { revision: 2 },
					updatedAt: "2026-08-02T09:00:00.000Z",
					privateValue: "must-not-appear",
				}),
				"2026-08-02T09:00:00.000Z",
			],
		);
		client.close(false);
		const result = runDb(["verify-rc4"], active);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"persisted conversation context invariants are invalid",
		);
		expect(result.stderr.toString()).not.toContain("must-not-appear");
	});

	test("rejects duplicate legacy tables without exposing row values", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-rc4-invalid-"));
		temporaryDirectories.push(directory);
		const active = join(directory, "active.db");
		expect(runDb(["migrate"], active).exitCode).toBe(0);
		const client = new Database(active);
		client.run("CREATE TABLE duplicate_evidence (secret TEXT)");
		client.run("INSERT INTO duplicate_evidence VALUES ('private-value')");
		client.close(false);
		const result = runDb(["verify-rc4"], active);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("duplicate fact, evidence");
		expect(result.stderr.toString()).not.toContain("private-value");
	});
});
