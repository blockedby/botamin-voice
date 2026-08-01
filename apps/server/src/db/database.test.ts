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
	test("upgrades legacy scopes and adds internal meeting slot constraints", () => {
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
		const bookingColumns = upgraded.$client
			.query<{ name: string }, []>("PRAGMA table_info(bookings)")
			.all()
			.map((column) => column.name);
		expect(bookingColumns).toEqual(
			expect.arrayContaining([
				"meeting_start_at",
				"meeting_end_at",
				"meeting_timezone",
			]),
		);
		const bookingIndexes = upgraded.$client
			.query<{ name: string }, []>("PRAGMA index_list(bookings)")
			.all()
			.map((index) => index.name);
		expect(bookingIndexes).toContain("bookings_meeting_start_unique");
		closeDomainDatabase(upgraded);
	});

	test("preserves legacy bookings without inventing meeting slots during upgrade", () => {
		const { database: legacy, filename } = legacyDatabaseFixture();
		legacy.$client.run(
			`INSERT INTO conversations
			 (id, status, stage, prompt_version, source, locale, qualification_enabled, consent_at, started_at)
			 VALUES (?, 'active', 'BOOKED', ?, 'landing', 'ru-RU', 1, ?, ?)`,
			[
				"legacy-conversation",
				"a".repeat(64),
				"2026-07-30T20:22:00.000Z",
				"2026-07-30T20:22:00.000Z",
			],
		);
		legacy.$client.run(
			`INSERT INTO bookings
			 (id, conversation_id, name, contacts_json, created_at, updated_at)
			 VALUES ('legacy-booking', 'legacy-conversation', 'Legacy', '[]', ?, ?)`,
			["2026-07-30T20:22:00.000Z", "2026-07-30T20:22:00.000Z"],
		);
		closeDomainDatabase(legacy);

		const upgraded = openDomainDatabase({ filename });
		const row = upgraded.$client
			.query<
				{
					count: number;
					meetingStartAt: string | null;
					meetingEndAt: string | null;
					meetingTimeZone: string | null;
				},
				[]
			>(
				`SELECT count(*) AS count,
				 meeting_start_at AS meetingStartAt,
				 meeting_end_at AS meetingEndAt,
				 meeting_timezone AS meetingTimeZone
				 FROM bookings WHERE id = 'legacy-booking'`,
			)
			.get();
		expect(row).toEqual({
			count: 1,
			meetingStartAt: null,
			meetingEndAt: null,
			meetingTimeZone: null,
		});
		const columns = upgraded.$client
			.query<{ name: string }, []>("PRAGMA table_info(bookings)")
			.all()
			.map((column) => column.name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"meeting_start_at",
				"meeting_end_at",
				"meeting_timezone",
			]),
		);
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
