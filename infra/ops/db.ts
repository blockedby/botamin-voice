#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	closeDomainDatabase,
	openDomainDatabase,
} from "../../apps/server/src/db/database";

const DATABASE_URL = process.env.DATABASE_URL ?? "file:/data/app.db";
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? "/app/drizzle";

function fail(message: string): never {
	throw new Error(`database operation failed: ${message}`);
}

function databasePath(): string {
	const value = DATABASE_URL.startsWith("file:")
		? DATABASE_URL.slice("file:".length)
		: DATABASE_URL;
	if (!value || value.includes("?") || value.includes("#")) {
		fail("DATABASE_URL must be a plain SQLite file path");
	}
	return isAbsolute(value) ? value : resolve(value);
}

function assertRegularFile(path: string, label: string): void {
	if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		fail(`${label} must be a regular file, not a symlink: ${path}`);
	}
}

function integrity(path: string): void {
	assertRegularFile(path, "SQLite file");
	const client = new Database(path, { readonly: true, strict: true });
	try {
		const row = client.query("PRAGMA integrity_check").get() as
			| { integrity_check: string }
			| undefined;
		if (row?.integrity_check !== "ok") {
			fail(`SQLite integrity_check did not return ok for ${path}`);
		}
	} finally {
		client.close(false);
	}
}

function digest(path: string): string {
	const hasher = createHash("sha256");
	hasher.update(readFileSync(path));
	return hasher.digest("hex");
}

function checksumPath(path: string): string {
	return `${path}.sha256`;
}

function writeChecksum(path: string): string {
	const checksum = digest(path);
	const sidecar = checksumPath(path);
	writeFileSync(sidecar, `${checksum}  ${basename(path)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	chmodSync(sidecar, 0o600);
	return checksum;
}

function assertDigest(path: string, expectedHex: string): void {
	const expected = Buffer.from(expectedHex, "hex");
	const actual = Buffer.from(digest(path), "hex");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		fail(`SHA-256 mismatch for backup: ${path}`);
	}
}

function verifyChecksum(path: string): string {
	const sidecar = checksumPath(path);
	assertRegularFile(sidecar, "SHA-256 sidecar");
	const sidecarStat = lstatSync(sidecar);
	if ((sidecarStat.mode & 0o077) !== 0) {
		fail(
			`SHA-256 sidecar must not grant group or other permissions: ${sidecar}`,
		);
	}
	const contents = readFileSync(sidecar, "utf8");
	const match = /^([0-9a-f]{64}) {2}([^\n]+)\n$/.exec(contents);
	if (!match || match[2] !== basename(path)) {
		fail(
			`SHA-256 sidecar has an invalid protected-backup contract: ${sidecar}`,
		);
	}
	const expectedHex = match[1];
	assertDigest(path, expectedHex);
	return expectedHex;
}

function timestamp(): string {
	return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function vacuumInto(source: string, destination: string): void {
	assertRegularFile(source, "source database");
	if (existsSync(destination))
		fail(`destination already exists: ${destination}`);
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const client = new Database(source, { readonly: true, strict: true });
	try {
		client.run("PRAGMA busy_timeout = 10000");
		client.query("VACUUM INTO ?").run(destination);
	} finally {
		client.close(false);
	}
	chmodSync(destination, 0o600);
	integrity(destination);
}

function protectedBackup(source: string, destination: string): string {
	if (existsSync(destination))
		fail(`destination already exists: ${destination}`);
	if (existsSync(checksumPath(destination))) {
		fail(`checksum destination already exists: ${checksumPath(destination)}`);
	}
	try {
		vacuumInto(source, destination);
		return writeChecksum(destination);
	} catch (error) {
		rmSync(destination, { force: true });
		rmSync(checksumPath(destination), { force: true });
		throw error;
	}
}

function migrate(path: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const database = openDomainDatabase({
		filename: path,
		migrationsFolder: MIGRATIONS_DIR,
	});
	closeDomainDatabase(database);
	chmodSync(path, 0o600);
	integrity(path);
}

function backup(destinationArgument?: string): void {
	const source = databasePath();
	const destination = destinationArgument
		? resolve(destinationArgument)
		: join(dirname(source), "backups", `app-${timestamp()}.db`);
	const sha256 = protectedBackup(source, destination);
	process.stdout.write(
		`${JSON.stringify({ operation: "backup", path: destination, checksumPath: checksumPath(destination), sha256 })}\n`,
	);
}

function verifyBackup(sourceArgument?: string): string {
	if (!sourceArgument) fail("backup verification requires a backup path");
	const source = resolve(sourceArgument);
	assertRegularFile(source, "backup");
	const sha256 = verifyChecksum(source);
	integrity(source);
	return sha256;
}

function restore(sourceArgument?: string): void {
	if (process.env.BOTAMIN_RESTORE_CONFIRMED !== "true") {
		fail("set BOTAMIN_RESTORE_CONFIRMED=true after stopping the app service");
	}
	if (!sourceArgument) fail("restore requires a backup path");
	const source = resolve(sourceArgument);
	const sourceSha256 = verifyBackup(source);

	const target = databasePath();
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(target), `.restore-${process.pid}.db`);
	if (existsSync(temporary))
		fail(`temporary restore path exists: ${temporary}`);
	copyFileSync(source, temporary, constants.COPYFILE_EXCL);
	chmodSync(temporary, 0o600);

	try {
		// Bind the restore candidate to the digest verified before this copy. A
		// replacement of the source between verification and copy is rejected.
		assertDigest(temporary, sourceSha256);
		migrate(temporary);
		integrity(temporary);
		const rollback = existsSync(target)
			? join(dirname(target), "backups", `pre-restore-${timestamp()}.db`)
			: undefined;
		if (rollback) protectedBackup(target, rollback);

		rmSync(`${target}-wal`, { force: true });
		rmSync(`${target}-shm`, { force: true });
		const displaced = `${target}.displaced-${process.pid}`;
		if (existsSync(target)) renameSync(target, displaced);
		try {
			renameSync(temporary, target);
			chmodSync(target, 0o600);
			rmSync(displaced, { force: true });
		} catch (error) {
			if (existsSync(displaced) && !existsSync(target)) {
				renameSync(displaced, target);
			}
			throw error;
		}
		integrity(target);
		process.stdout.write(
			`${JSON.stringify({ operation: "restore", path: target, sourceSha256, rollback })}\n`,
		);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function permissions(): void {
	const paths = ["/data", "/data/backups", "/codex-home"];
	const result = paths.map((path) => {
		const stat = lstatSync(path);
		let writable = true;
		try {
			accessSync(path, constants.W_OK);
		} catch {
			writable = false;
		}
		return {
			path,
			uid: stat.uid,
			gid: stat.gid,
			mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
			writable,
		};
	});
	process.stdout.write(
		`${JSON.stringify({ operation: "permissions", paths: result })}\n`,
	);
}

function usage(): never {
	fail(
		"usage: db.js migrate | backup [PATH] | verify-backup BACKUP_PATH | restore BACKUP_PATH | integrity [PATH] | permissions",
	);
}

try {
	const [command, argument] = process.argv.slice(2);
	switch (command) {
		case "migrate": {
			const path = databasePath();
			migrate(path);
			process.stdout.write(
				`${JSON.stringify({ operation: "migrate", path })}\n`,
			);
			break;
		}
		case "backup":
			backup(argument);
			break;
		case "verify-backup": {
			const sha256 = verifyBackup(argument);
			process.stdout.write(
				`${JSON.stringify({ operation: "verify-backup", path: resolve(argument ?? ""), sha256 })}\n`,
			);
			break;
		}
		case "restore":
			restore(argument);
			break;
		case "integrity": {
			const path = argument ? resolve(argument) : databasePath();
			integrity(path);
			process.stdout.write(
				`${JSON.stringify({ operation: "integrity", path, result: "ok" })}\n`,
			);
			break;
		}
		case "permissions":
			permissions();
			break;
		default:
			usage();
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
