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
import { conversationContexts, idempotencyKeys } from "./schema";

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

function migrationFixture(entryCount = 1) {
	const directory = mkdtempSync(join(tmpdir(), "botamin-migration-"));
	directories.push(directory);
	const legacyMigrations = join(directory, "legacy-drizzle");
	const legacyMeta = join(legacyMigrations, "meta");
	mkdirSync(legacyMeta, { recursive: true });
	const currentMigrations = resolve(import.meta.dir, "../../../../drizzle");
	const journal = JSON.parse(
		readFileSync(join(currentMigrations, "meta", "_journal.json"), "utf8"),
	) as MigrationJournal;
	const entries = journal.entries.slice(0, entryCount) as Array<{
		tag: string;
	}>;
	for (const entry of entries) {
		copyFileSync(
			join(currentMigrations, `${entry.tag}.sql`),
			join(legacyMigrations, `${entry.tag}.sql`),
		);
	}
	writeFileSync(
		join(legacyMeta, "_journal.json"),
		JSON.stringify({ ...journal, entries }),
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

function legacyDatabaseFixture() {
	return migrationFixture(1);
}

describe("domain database migrations", () => {
	test("creates the compact conversation context table on a fresh database", () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-fresh-migration-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const columns = database.$client
			.query<{ name: string }, []>("PRAGMA table_info(conversation_contexts)")
			.all()
			.map((column) => column.name);
		expect(columns).toEqual([
			"conversation_id",
			"revision",
			"draft_json",
			"updated_at",
		]);
		const foreignKey = database.$client
			.query<{ from: string; on_delete: string; table: string }, []>(
				"PRAGMA foreign_key_list(conversation_contexts)",
			)
			.get();
		expect(foreignKey).toEqual(
			expect.objectContaining({
				from: "conversation_id",
				on_delete: "CASCADE",
				table: "conversations",
			}),
		);
		const tables = database.$client
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((table) => table.name);
		expect(tables).toContain("conversation_contexts");
		expect(
			tables.filter((name) => /fact|evidence|virtual_meeting/.test(name)),
		).toEqual([]);
		const contextIndexes = database.$client
			.query<{ name: string }, []>("PRAGMA index_list(conversation_contexts)")
			.all()
			.map((entry) => entry.name);
		expect(contextIndexes).toContain(
			"conversation_contexts_committing_cursor_idx",
		);
		const recoveryPlan = database.$client
			.query<{ detail: string }, [string, number]>(
				`EXPLAIN QUERY PLAN
				 SELECT conversation_id, revision
				 FROM conversation_contexts
				 WHERE conversation_id > ?
				   AND CASE WHEN json_valid(draft_json)
				     THEN json_extract(draft_json, '$.commitStatus')
				     ELSE NULL
				   END = 'committing'
				 ORDER BY conversation_id
				 LIMIT ?`,
			)
			.all("", 10)
			.map((entry) => entry.detail);
		expect(recoveryPlan.join(" ")).toContain(
			"conversation_contexts_committing_cursor_idx",
		);
		expect(database.select().from(conversationContexts).all()).toEqual([]);
		closeDomainDatabase(database);
	});

	test("rejects missing, mistyped, and mismatched context JSON members", () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-context-checks-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const timestamp = "2026-08-03T09:00:00.000Z";
		database.$client.run(
			`INSERT INTO conversations
			 (id, status, stage, prompt_version, source, locale,
			  qualification_enabled, consent_at, started_at)
			 VALUES ('conversation-checks', 'active', 'COLLECT_BOOKING',
			  'prompt', 'landing', 'ru-RU', 1, ?, ?)`,
			[timestamp, timestamp],
		);
		const validDraft = {
			revision: 0,
			factRegistry: { schemaVersion: 1, revision: 0, facts: {} },
			updatedAt: timestamp,
		};
		const { revision: _missingRevision, ...withoutRevision } = validDraft;
		const { updatedAt: _missingUpdatedAt, ...withoutUpdatedAt } = validDraft;
		const { factRegistry: _missingFactRegistry, ...withoutFactRegistry } =
			validDraft;
		const invalidDrafts: Array<[string, string]> = [
			["empty object", "{}"],
			["draft root is not an object", "[]"],
			["missing revision", JSON.stringify(withoutRevision)],
			["null revision", JSON.stringify({ ...validDraft, revision: null })],
			["string revision", JSON.stringify({ ...validDraft, revision: "0" })],
			["fraction revision", JSON.stringify({ ...validDraft, revision: 0.5 })],
			["negative revision", JSON.stringify({ ...validDraft, revision: -1 })],
			[
				"draft revision mismatch",
				JSON.stringify({ ...validDraft, revision: 1 }),
			],
			["missing fact registry", JSON.stringify(withoutFactRegistry)],
			[
				"missing facts object",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, revision: 0 },
				}),
			],
			[
				"missing fact revision",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, facts: {} },
				}),
			],
			[
				"null fact revision",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, revision: null, facts: {} },
				}),
			],
			[
				"string fact revision",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, revision: "0", facts: {} },
				}),
			],
			[
				"fraction fact revision",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, revision: 0.5, facts: {} },
				}),
			],
			[
				"negative fact revision",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, revision: -1, facts: {} },
				}),
			],
			[
				"fact revision mismatch",
				JSON.stringify({
					...validDraft,
					factRegistry: { schemaVersion: 1, revision: 1, facts: {} },
				}),
			],
			["missing updatedAt", JSON.stringify(withoutUpdatedAt)],
			["null updatedAt", JSON.stringify({ ...validDraft, updatedAt: null })],
			["wrong-type updatedAt", JSON.stringify({ ...validDraft, updatedAt: 3 })],
			[
				"nonmatching updatedAt",
				JSON.stringify({
					...validDraft,
					updatedAt: "2026-08-03T09:01:00.000Z",
				}),
			],
			["malformed JSON", '{"privateValue":"must-not-appear"'],
		];
		const insert = database.$client.query(
			`INSERT INTO conversation_contexts
			 (conversation_id, revision, draft_json, updated_at)
			 VALUES ('conversation-checks', 0, ?, ?)`,
		);
		for (const [label, draftJson] of invalidDrafts) {
			let thrown: unknown;
			try {
				insert.run(draftJson, timestamp);
			} catch (error) {
				thrown = error;
			}
			expect(String(thrown), label).toContain("CHECK constraint failed");
			expect(String(thrown), label).not.toContain("malformed JSON");
			expect(String(thrown), label).not.toContain("must-not-appear");
		}
		expect(
			database.$client
				.query(
					`SELECT json_type('{}', '$.revision') AS missing_type,
					        json_extract('{}', '$.revision') IS NULL AS extract_is_null`,
				)
				.get(),
		).toEqual({ missing_type: null, extract_is_null: 1 });
		expect(() =>
			insert.run(JSON.stringify(validDraft), timestamp),
		).not.toThrow();
		expect(
			database.$client
				.query("SELECT count(*) AS count FROM conversation_contexts")
				.get(),
		).toEqual({ count: 1 });
		closeDomainDatabase(database);
	});

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

	test("upgrades RC3 bookings additively without context backfill", () => {
		const { database: rc3, filename } = migrationFixture(4);
		rc3.$client.run(
			`INSERT INTO conversations
			 (id, status, stage, prompt_version, source, locale, qualification_enabled, consent_at, started_at)
			 VALUES (?, 'completed', 'BOOKED', ?, 'landing', 'ru-RU', 1, ?, ?)`,
			[
				"01J00000000000000000000RC3",
				"c".repeat(64),
				"2026-07-30T20:22:00.000Z",
				"2026-07-30T20:22:00.000Z",
			],
		);
		rc3.$client.run(
			`INSERT INTO bookings
			 (id, conversation_id, name, contacts_json, company,
			  meeting_start_at, meeting_end_at, meeting_timezone, created_at, updated_at)
			 VALUES (?, ?, 'RC3 Lead', ?, 'RC3 Company', ?, ?, 'Europe/Moscow', ?, ?)`,
			[
				"01J00000000000000000000BK3",
				"01J00000000000000000000RC3",
				'[{"channel":"email","value":"lead@example.com"},{"channel":"phone","value":"+79991234567"}]',
				"2099-01-05T06:00:00.000Z",
				"2099-01-05T06:20:00.000Z",
				"2026-07-30T20:22:00.000Z",
				"2026-07-30T20:22:00.000Z",
			],
		);
		closeDomainDatabase(rc3);

		const upgraded = openDomainDatabase({ filename });
		const preserved = upgraded.$client
			.query<{ count: number }, []>(
				"SELECT count(*) AS count FROM bookings WHERE id = '01J00000000000000000000BK3'",
			)
			.get();
		expect(preserved?.count).toBe(1);
		expect(upgraded.select().from(conversationContexts).all()).toEqual([]);
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
