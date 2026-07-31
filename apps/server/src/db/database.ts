import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { schema } from "./schema";

export type DomainDatabase = BunSQLiteDatabase<typeof schema> & {
	$client: Database;
};

export interface OpenDomainDatabaseOptions {
	filename: string;
	migrationsFolder?: string;
	busyTimeoutMs?: number;
	applyMigrations?: boolean;
}

function sqliteFilename(value: string): string {
	return value.startsWith("file:") ? value.slice("file:".length) : value;
}

function defaultMigrationsFolder(): string {
	const candidates = [
		resolve(import.meta.dir, "../../../../drizzle"),
		resolve(import.meta.dir, "../../../drizzle"),
	];
	const folder = candidates.find((candidate) =>
		existsSync(join(candidate, "meta", "_journal.json")),
	);
	if (folder === undefined) {
		throw new Error(
			"Domain migrations were not found relative to the server module; configure migrationsFolder",
		);
	}
	return folder;
}

/**
 * Opens one SQLite connection with the production durability/locking settings.
 * Every connection enables foreign keys and waits for a concurrent WAL writer.
 */
export function openDomainDatabase(
	options: OpenDomainDatabaseOptions,
): DomainDatabase {
	const client = new Database(sqliteFilename(options.filename), {
		create: true,
		readwrite: true,
	});
	client.run("PRAGMA foreign_keys = ON");
	client.run(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 10_000}`);
	client.run("PRAGMA journal_mode = WAL");
	client.run("PRAGMA synchronous = NORMAL");

	const database = drizzle(client, { schema });
	if (options.applyMigrations !== false) {
		try {
			migrate(database, {
				migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
			});
		} catch (error) {
			client.close(false);
			throw error;
		}
	}
	return database;
}

export function closeDomainDatabase(database: DomainDatabase): void {
	database.$client.close(false);
}
