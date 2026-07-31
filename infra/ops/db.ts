#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
	vacuumInto(source, destination);
	process.stdout.write(
		`${JSON.stringify({ operation: "backup", path: destination, sha256: digest(destination) })}\n`,
	);
}

function restore(sourceArgument?: string): void {
	if (process.env.BOTAMIN_RESTORE_CONFIRMED !== "true") {
		fail("set BOTAMIN_RESTORE_CONFIRMED=true after stopping the app service");
	}
	if (!sourceArgument) fail("restore requires a backup path");
	const source = resolve(sourceArgument);
	assertRegularFile(source, "backup");
	integrity(source);

	const target = databasePath();
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(target), `.restore-${process.pid}.db`);
	if (existsSync(temporary))
		fail(`temporary restore path exists: ${temporary}`);
	copyFileSync(source, temporary, constants.COPYFILE_EXCL);
	chmodSync(temporary, 0o600);

	try {
		migrate(temporary);
		integrity(temporary);
		const rollback = existsSync(target)
			? join(dirname(target), "backups", `pre-restore-${timestamp()}.db`)
			: undefined;
		if (rollback) vacuumInto(target, rollback);

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
			`${JSON.stringify({ operation: "restore", path: target, sourceSha256: digest(source), rollback })}\n`,
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
		"usage: db.js migrate | backup [PATH] | restore BACKUP_PATH | integrity [PATH] | permissions",
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
