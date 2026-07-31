import { Database } from "bun:sqlite";
import { resolve } from "node:path";
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
		migrate(database, {
			migrationsFolder:
				options.migrationsFolder ?? resolve(process.cwd(), "drizzle"),
		});
	}
	return database;
}

export function closeDomainDatabase(database: DomainDatabase): void {
	database.$client.close(false);
}
