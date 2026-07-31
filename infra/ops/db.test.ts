import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
