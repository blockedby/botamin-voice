import { afterEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDomainDatabase, openDomainDatabase } from "./database";
import { idempotencyKeys } from "./schema";

const directories: string[] = [];

interface MigrationJournal {
	version: string;
	dialect: string;
	entries: unknown[];
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function legacyDatabaseFixture() {
	const directory = mkdtempSync(join(tmpdir(), "botamin-migration-"));
	directories.push(directory);
	const legacyMigrations = join(directory, "legacy-drizzle");
	const legacyMeta = join(legacyMigrations, "meta");
	mkdirSync(legacyMeta, { recursive: true });
	const currentMigrations = resolve(import.meta.dir, "../../../../drizzle");
	copyFileSync(
		join(currentMigrations, "0000_booking_domain.sql"),
		join(legacyMigrations, "0000_booking_domain.sql"),
	);
	const journal = JSON.parse(
		readFileSync(join(currentMigrations, "meta", "_journal.json"), "utf8"),
	) as MigrationJournal;
	writeFileSync(
		join(legacyMeta, "_journal.json"),
		JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
	);
	const filename = join(directory, "domain.db");
	return {
		filename,
		database: openDomainDatabase({
			filename,
			migrationsFolder: legacyMigrations,
		}),
	};
}

describe("domain database migrations", () => {
	test("upgrades legacy idempotency scopes and adds outbox claim identity", () => {
		const { database: legacy, filename } = legacyDatabaseFixture();
		legacy
			.insert(idempotencyKeys)
			.values({
				scope: "booking:create",
				key: "legacy-restart-key",
				requestHash: "legacy-request-hash",
				resultJson: "{}",
				conversationId: "conversation-legacy",
				createdAt: "2026-07-30T20:22:00.000Z",
			})
			.run();
		closeDomainDatabase(legacy);

		const upgraded = openDomainDatabase({ filename });
		expect(upgraded.select().from(idempotencyKeys).get()?.scope).toBe(
			"booking:create:conversation-legacy",
		);
		const outboxColumns = upgraded.$client
			.query<{ name: string }, []>("PRAGMA table_info(notification_outbox)")
			.all()
			.map((column) => column.name);
		expect(outboxColumns).toContain("claim_token");
		closeDomainDatabase(upgraded);
	});

	test("fails closed on legacy operation scopes without their subject", () => {
		for (const [scope, conversationId, bookingId] of [
			["booking:create", null, null],
			["booking:qualification", "conversation-legacy", null],
		] as const) {
			const { database: legacy, filename } = legacyDatabaseFixture();
			legacy.$client.run(
				`INSERT INTO idempotency_keys
				 (scope, key, request_hash, result_json, conversation_id, booking_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					scope,
					`legacy-key-${scope}`,
					"legacy-request-hash",
					"{}",
					conversationId,
					bookingId,
					"2026-07-30T20:22:00.000Z",
				],
			);
			closeDomainDatabase(legacy);

			expect(() => openDomainDatabase({ filename })).toThrow(
				"_idempotency_scope_migration_guard",
			);
			const unchanged = openDomainDatabase({
				filename,
				applyMigrations: false,
			});
			expect(unchanged.select().from(idempotencyKeys).get()?.scope).toBe(scope);
			closeDomainDatabase(unchanged);
		}
	});
});
