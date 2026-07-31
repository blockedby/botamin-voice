import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateBookingInput } from "@botamin/contracts";
import { count, eq } from "drizzle-orm";
import { ConversationStore } from "../../db/conversation-store";
import {
	closeDomainDatabase,
	type DomainDatabase,
	openDomainDatabase,
} from "../../db/database";
import {
	bookings,
	domainEvents,
	idempotencyKeys,
	notificationOutbox,
} from "../../db/schema";
import type { NamedLeadNotifier } from "../../notifiers/notifier";
import { BookingDomainError, SqliteBookingService } from "./service";

const directories: string[] = [];
const timestamp = "2026-07-30T20:22:00.000Z";
const promptVersion = "a".repeat(64);

function fixture(): {
	directory: string;
	filename: string;
	database: DomainDatabase;
	conversationId: string;
	input: CreateBookingInput;
} {
	const directory = mkdtempSync(join(tmpdir(), "botamin-booking-"));
	directories.push(directory);
	const filename = join(directory, "domain.db");
	const database = openDomainDatabase({ filename });
	const conversationId = Bun.randomUUIDv7();
	new ConversationStore(database).create({
		id: conversationId,
		stage: "COLLECT_BOOKING",
		promptVersion,
		source: "landing",
		locale: "ru-RU",
		qualificationEnabled: true,
		consentAt: timestamp,
		startedAt: timestamp,
	});
	return {
		directory,
		filename,
		database,
		conversationId,
		input: {
			conversationId,
			idempotencyKey: "booking-attempt-0001",
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex_private" }],
			company: "Private Example LLC",
			preferredTimeText: "завтра после 15:00",
			consentConfirmed: true,
		},
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("SQLite booking transaction", () => {
	test("enables WAL and migrates all durable domain tables", () => {
		const { database } = fixture();
		const journalMode = database.$client
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
			.get();
		const names = database.$client
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((row) => row.name);

		expect(journalMode?.journal_mode).toBe("wal");
		expect(names).toEqual(
			expect.arrayContaining([
				"conversations",
				"turns",
				"bookings",
				"domain_events",
				"idempotency_keys",
				"notification_outbox",
			]),
		);
		closeDomainDatabase(database);
	});

	test("returns the stable booking for key and conversation replays", async () => {
		const { database, input, conversationId } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		const sameKey = await service.createBooking(input);
		const sameConversation = await service.createBooking({
			...input,
			idempotencyKey: "booking-attempt-0002",
			name: "Ignored replacement",
		});

		expect(created.created).toBe(true);
		expect(sameKey).toMatchObject({
			bookingId: created.bookingId,
			created: false,
		});
		expect(sameConversation).toMatchObject({
			bookingId: created.bookingId,
			created: false,
		});
		expect((await service.findByConversationId(conversationId))?.name).toBe(
			"Александр",
		);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
		closeDomainDatabase(database);
	});

	test("rejects reuse of one key with a different request hash", async () => {
		const { database, input } = fixture();
		const service = new SqliteBookingService(database);
		await service.createBooking(input);

		try {
			await service.createBooking({ ...input, name: "Другой лид" });
			throw new Error("Expected conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(BookingDomainError);
			expect((error as BookingDomainError).code).toBe("IDEMPOTENCY_CONFLICT");
		}
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		closeDomainDatabase(database);
	});

	test("scopes one key independently across conversations and bookings", async () => {
		const { database, input } = fixture();
		const secondConversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: secondConversationId,
			stage: "COLLECT_BOOKING",
			promptVersion,
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: timestamp,
			startedAt: timestamp,
		});
		const service = new SqliteBookingService(database);
		const first = await service.createBooking(input);
		const secondInput: CreateBookingInput = {
			...input,
			conversationId: secondConversationId,
			name: "Мария",
		};
		const second = await service.createBooking(secondInput);

		expect(first.created).toBe(true);
		expect(second.created).toBe(true);
		expect(second.bookingId).not.toBe(first.bookingId);
		expect(await service.createBooking(input)).toMatchObject({
			bookingId: first.bookingId,
			created: false,
		});
		await expect(
			service.createBooking({ ...input, name: "Changed within first subject" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

		const qualificationKey = "shared-qualification-key";
		const firstQualification = {
			bookingId: first.bookingId,
			idempotencyKey: qualificationKey,
			patch: { role: "CEO" },
			completion: "partial" as const,
		};
		const secondQualification = {
			bookingId: second.bookingId,
			idempotencyKey: qualificationKey,
			patch: { role: "CMO" },
			completion: "partial" as const,
		};
		await service.appendQualification(firstQualification);
		await service.appendQualification(secondQualification);
		expect(await service.appendQualification(firstQualification)).toMatchObject(
			{
				bookingId: first.bookingId,
				updatedFields: ["role"],
			},
		);
		await expect(
			service.appendQualification({
				...firstQualification,
				patch: { role: "CFO" },
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		expect((await service.findById(first.bookingId))?.qualification?.role).toBe(
			"CEO",
		);
		expect(
			(await service.findById(second.bookingId))?.qualification?.role,
		).toBe("CMO");
		closeDomainDatabase(database);
	});

	test("preserves booking and replay state across a process-style restart", async () => {
		const { database, filename, input } = fixture();
		const created = await new SqliteBookingService(database).createBooking(
			input,
		);
		closeDomainDatabase(database);

		const restarted = openDomainDatabase({ filename });
		const replay = await new SqliteBookingService(restarted).createBooking(
			input,
		);
		expect(replay).toMatchObject({
			bookingId: created.bookingId,
			created: false,
			status: "booked",
		});
		expect(
			restarted.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		closeDomainDatabase(restarted);
	});

	test("serializes concurrent retries from apps/server as a non-root cwd", async () => {
		const { database, filename, input } = fixture();
		closeDomainDatabase(database);
		const worker = join(import.meta.dir, "concurrency-worker.ts");
		const processes = Array.from({ length: 8 }, () =>
			Bun.spawn(
				[
					process.execPath,
					worker,
					filename,
					input.conversationId,
					input.idempotencyKey,
				],
				{
					cwd: resolve(import.meta.dir, "../../../"),
					stderr: "pipe",
					stdout: "pipe",
				},
			),
		);
		const outputs = await Promise.all(
			processes.map(async (process) => {
				const [exitCode, stdout, stderr] = await Promise.all([
					process.exited,
					new Response(process.stdout).text(),
					new Response(process.stderr).text(),
				]);
				expect(stderr).toBe("");
				expect(exitCode).toBe(0);
				return JSON.parse(stdout) as {
					bookingId: string;
					created: boolean;
				};
			}),
		);

		expect(new Set(outputs.map((result) => result.bookingId)).size).toBe(1);
		expect(outputs.filter((result) => result.created)).toHaveLength(1);
		const reopened = openDomainDatabase({ filename });
		expect(
			reopened.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			reopened.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
		closeDomainDatabase(reopened);
	});

	test("merges partial qualification and accepts an empty skipped patch", async () => {
		const { database, input } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-partial-01",
			patch: { role: "Head of Sales", crm: "amoCRM" },
			completion: "partial",
		});
		const second = await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-partial-02",
			patch: { monthlyLeadVolume: "около 2000" },
			completion: "partial",
		});
		const skipped = await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-skipped-01",
			patch: {},
			completion: "skipped",
		});
		const snapshot = await service.findById(created.bookingId);

		expect(second.updatedFields).toEqual(["monthlyLeadVolume"]);
		expect(skipped).toMatchObject({
			bookingId: created.bookingId,
			qualificationStatus: "skipped",
			updatedFields: [],
		});
		expect(snapshot).toMatchObject({
			status: "booked",
			qualificationStatus: "skipped",
			qualification: {
				role: "Head of Sales",
				crm: "amoCRM",
				monthlyLeadVolume: "около 2000",
			},
		});
		closeDomainDatabase(database);
	});

	test("rejects empty partial qualification and qualification key conflicts", async () => {
		const { database, input } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		await expect(
			service.appendQualification({
				bookingId: created.bookingId,
				idempotencyKey: "qualification-empty-001",
				patch: {},
				completion: "partial",
			}),
		).rejects.toMatchObject({ code: "BOOKING_VALIDATION_FAILED" });
		await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-conflict-01",
			patch: { role: "CEO" },
			completion: "partial",
		});
		await expect(
			service.appendQualification({
				bookingId: created.bookingId,
				idempotencyKey: "qualification-conflict-01",
				patch: { role: "CMO" },
				completion: "partial",
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		closeDomainDatabase(database);
	});

	test("commits event and booking before notifier failure and keeps retry state", async () => {
		const { database, input } = fixture();
		let observedCommitted = false;
		const notifier: NamedLeadNotifier = {
			kind: "webhook",
			async publish(event) {
				observedCommitted =
					database
						.select({ value: count() })
						.from(bookings)
						.where(eq(bookings.id, event.data.bookingId))
						.get()?.value === 1 &&
					database
						.select({ value: count() })
						.from(domainEvents)
						.where(eq(domainEvents.id, event.eventId))
						.get()?.value === 1;
				throw new Error(`outage involving ${input.contacts[0]?.value}`);
			},
		};
		const result = await new SqliteBookingService(database, {
			notifier,
		}).createBooking(input);
		const outbox = database.select().from(notificationOutbox).get();
		const audit = database.select().from(domainEvents).get();

		expect(result.created).toBe(true);
		expect(observedCommitted).toBe(true);
		expect(outbox).toMatchObject({
			status: "failed",
			attemptCount: 1,
			lastError: "NOTIFIER_FAILED",
		});
		expect(outbox?.lastError).not.toContain("@alex_private");
		expect(audit?.payloadJson).not.toContain("Александр");
		expect(audit?.payloadJson).not.toContain("@alex_private");
		expect(audit?.payloadJson).toContain("[REDACTED]");
		closeDomainDatabase(database);
	});

	test("enforces booked-only status and append-only audit in SQLite", async () => {
		const { database, input } = fixture();
		const created = await new SqliteBookingService(database).createBooking(
			input,
		);
		const eventId = database
			.select({ id: domainEvents.id })
			.from(domainEvents)
			.get()?.id;
		if (eventId === undefined)
			throw new Error("Expected committed audit event");

		expect(() =>
			database.$client.run(
				"INSERT INTO bookings (id, conversation_id, name, contacts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					Bun.randomUUIDv7(),
					input.conversationId,
					"Duplicate",
					'[{"channel":"telegram","value":"@duplicate"}]',
					created.createdAt,
					created.createdAt,
				],
			),
		).toThrow("UNIQUE constraint failed");
		expect(() =>
			database.$client.run(
				"UPDATE bookings SET status = 'cancelled' WHERE id = ?",
				[created.bookingId],
			),
		).toThrow();
		expect(() =>
			database.$client.run(
				"UPDATE domain_events SET type = 'changed' WHERE id = ?",
				[eventId],
			),
		).toThrow("domain_events is append-only");
		expect(() =>
			database.$client.run("DELETE FROM domain_events WHERE id = ?", [eventId]),
		).toThrow("domain_events is append-only");
		expect(
			database.select({ value: count() }).from(idempotencyKeys).get()?.value,
		).toBe(1);
		closeDomainDatabase(database);
	});
});
