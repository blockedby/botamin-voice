import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	AppendQualificationInput,
	CreateBookingInput,
} from "@botamin/contracts";
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
import { generateCandidateMeetingSlots } from "./support";

const directories: string[] = [];
const timestamp = "2026-07-30T20:22:00.000Z";
const [meetingSlot, secondMeetingSlot] = generateCandidateMeetingSlots(
	new Date("2099-01-01T00:00:00.000Z"),
);
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
			contacts: [
				{ channel: "email", value: "alex@example.com" },
				{ channel: "telegram", value: "@alex_private" },
			],
			company: "Private Example LLC",
			meetingSlot,
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

	test("generates contextual Thursday candidates and skips committed anchors", async () => {
		const { database, input } = fixture();
		const now = new Date("2025-01-09T09:00:00.000Z");
		const expected = generateCandidateMeetingSlots(now);
		const service = new SqliteBookingService(database, { now: () => now });

		expect(await service.candidateMeetingSlots()).toEqual(expected);
		await service.createBooking({ ...input, meetingSlot: expected[0] });
		const afterCommit = await service.candidateMeetingSlots();

		expect(afterCommit).toHaveLength(2);
		expect(afterCommit[1]).toEqual(expected[1]);
		expect(
			afterCommit.every((slot) => slot.startAt !== expected[0].startAt),
		).toBe(true);
		expect(
			(await service.candidateMeetingSlots("morning")).map(
				(slot) => slot.startAt,
			),
		).toEqual(["2025-01-10T06:20:00.000Z", "2025-01-10T07:20:00.000Z"]);
		expect(expected).toEqual(generateCandidateMeetingSlots(now));
		expect(expected.map((slot) => slot.startAt)).toEqual([
			"2025-01-10T06:00:00.000Z",
			"2025-01-10T13:00:00.000Z",
		]);
		expect(
			generateCandidateMeetingSlots(new Date("2025-01-10T20:00:00.000Z")).map(
				(slot) => slot.startAt,
			),
		).toEqual(["2025-01-13T06:00:00.000Z", "2025-01-13T13:00:00.000Z"]);
		expect(expected[0].timeZone).toBe("Europe/Moscow");
		expect(
			new Date(expected[0].startAt).getTime() - now.getTime(),
		).toBeGreaterThan(0);
		closeDomainDatabase(database);
	});

	test("rejects incomplete leads and clock-invalid slots without creating a booking", async () => {
		const { database, input } = fixture();
		const now = new Date(timestamp);
		const service = new SqliteBookingService(database, { now: () => now });
		const todayInMoscow = {
			startAt: "2026-07-30T06:00:00.000Z",
			endAt: "2026-07-30T06:20:00.000Z",
			timeZone: "Europe/Moscow" as const,
			durationMinutes: 20 as const,
		};

		for (const invalid of [
			{ ...input, company: undefined },
			{ ...input, contacts: [{ channel: "email", value: "alex@example.com" }] },
			{ ...input, meetingSlot: todayInMoscow },
		]) {
			await expect(
				service.createBooking(invalid as CreateBookingInput),
			).rejects.toMatchObject({
				code: "BOOKING_VALIDATION_FAILED",
			});
		}
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(0);
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
		expect(await service.findByConversationId(conversationId)).toMatchObject({
			name: "Александр",
			company: input.company,
			meetingSlot: input.meetingSlot,
		});
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
			meetingSlot: secondMeetingSlot,
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
			patch: { monthlyLeadVolume: "около 100" },
			completion: "partial" as const,
		};
		const secondQualification = {
			bookingId: second.bookingId,
			idempotencyKey: qualificationKey,
			patch: { monthlyLeadVolume: "около 200" },
			completion: "partial" as const,
		};
		await service.appendQualification(firstQualification);
		await service.appendQualification(secondQualification);
		expect(await service.appendQualification(firstQualification)).toMatchObject(
			{
				bookingId: first.bookingId,
				updatedFields: ["monthlyLeadVolume"],
			},
		);
		await expect(
			service.appendQualification({
				...firstQualification,
				patch: { monthlyLeadVolume: "около 300" },
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		expect(
			(await service.findById(first.bookingId))?.qualification
				?.monthlyLeadVolume,
		).toBe("около 100");
		expect(
			(await service.findById(second.bookingId))?.qualification
				?.monthlyLeadVolume,
		).toBe("около 200");
		closeDomainDatabase(database);
	});

	test("rejects a committed internal slot for a different conversation", async () => {
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
		await service.createBooking(input);

		await expect(
			service.createBooking({
				...input,
				conversationId: secondConversationId,
				idempotencyKey: "booking-slot-conflict-02",
			}),
		).rejects.toMatchObject({ code: "BOOKING_VALIDATION_FAILED" });
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		closeDomainDatabase(database);
	});

	test("preserves booking and replay state across a process-style restart", async () => {
		const { database, filename, input } = fixture();
		const created = await new SqliteBookingService(database).createBooking(
			input,
		);
		closeDomainDatabase(database);

		const restarted = openDomainDatabase({ filename });
		const replay = await new SqliteBookingService(restarted, {
			now: () => new Date("2100-01-01T00:00:00.000Z"),
		}).createBooking(input);
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

	test("persists and merges the two optional qualification fields", async () => {
		const { database, input } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		const first = await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-partial-01",
			patch: { monthlyLeadVolume: "около 2000" },
			completion: "partial",
		});
		const second = await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-complete-01",
			patch: { salesManagerCount: 12 },
			completion: "complete",
		});
		const snapshot = await service.findById(created.bookingId);

		expect(first).toMatchObject({
			qualificationStatus: "partial",
			updatedFields: ["monthlyLeadVolume"],
		});
		expect(second).toMatchObject({
			qualificationStatus: "complete",
			updatedFields: ["salesManagerCount"],
		});
		expect(snapshot).toMatchObject({
			status: "booked",
			qualificationStatus: "complete",
			qualification: {
				monthlyLeadVolume: "около 2000",
				salesManagerCount: 12,
			},
		});
		closeDomainDatabase(database);
	});

	test("reads and normalizes a populated legacy qualification row on append", async () => {
		const { database, input, conversationId } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		database
			.update(bookings)
			.set({
				qualificationJson: JSON.stringify({
					role: "Head of Sales",
					crm: "amoCRM",
					monthlyLeadVolume: "около 700",
				}),
				qualificationStatus: "partial",
			})
			.where(eq(bookings.id, created.bookingId))
			.run();

		const legacySnapshot = await service.findById(created.bookingId);
		expect(legacySnapshot).toMatchObject({
			id: created.bookingId,
			conversationId,
			qualificationStatus: "partial",
			qualification: { monthlyLeadVolume: "около 700" },
		});
		expect(legacySnapshot?.qualification).toEqual({
			monthlyLeadVolume: "около 700",
		});

		const appendInput = {
			bookingId: created.bookingId,
			idempotencyKey: "qualification-legacy-append-01",
			patch: { salesManagerCount: 6 },
			completion: "complete" as const,
		};
		const appended = await service.appendQualification(appendInput);
		expect(await service.appendQualification(appendInput)).toEqual(appended);
		expect(appended).toMatchObject({
			bookingId: created.bookingId,
			qualificationStatus: "complete",
			updatedFields: ["salesManagerCount"],
		});

		const stored = database
			.select({
				id: bookings.id,
				conversationId: bookings.conversationId,
				qualificationJson: bookings.qualificationJson,
				qualificationStatus: bookings.qualificationStatus,
			})
			.from(bookings)
			.where(eq(bookings.id, created.bookingId))
			.get();
		expect(stored).toEqual({
			id: created.bookingId,
			conversationId,
			qualificationJson:
				'{"monthlyLeadVolume":"около 700","salesManagerCount":6}',
			qualificationStatus: "complete",
		});
		const normalizedSnapshot = await service.findById(created.bookingId);
		expect(normalizedSnapshot).toMatchObject({
			id: created.bookingId,
			conversationId,
			qualificationStatus: "complete",
		});
		expect(normalizedSnapshot?.qualification).toEqual({
			monthlyLeadVolume: "около 700",
			salesManagerCount: 6,
		});
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(2);
		closeDomainDatabase(database);
	});

	test("fails closed on malformed persisted qualification JSON", async () => {
		const { database, input } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		database
			.update(bookings)
			.set({ qualificationJson: "{" })
			.where(eq(bookings.id, created.bookingId))
			.run();

		await expect(service.findById(created.bookingId)).rejects.toThrow();
		await expect(
			service.appendQualification({
				bookingId: created.bookingId,
				idempotencyKey: "qualification-malformed-row-01",
				patch: { salesManagerCount: 6 },
				completion: "partial",
			}),
		).rejects.toThrow();
		expect(
			database
				.select({
					qualificationJson: bookings.qualificationJson,
					qualificationStatus: bookings.qualificationStatus,
				})
				.from(bookings)
				.where(eq(bookings.id, created.bookingId))
				.get(),
		).toEqual({ qualificationJson: "{", qualificationStatus: "none" });
		expect(
			database.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(idempotencyKeys).get()?.value,
		).toBe(1);
		closeDomainDatabase(database);
	});

	test("accepts an empty skipped patch", async () => {
		const { database, input } = fixture();
		const service = new SqliteBookingService(database);
		const created = await service.createBooking(input);
		const skipped = await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-skipped-01",
			patch: {},
			completion: "skipped",
		});

		expect(skipped).toMatchObject({
			bookingId: created.bookingId,
			qualificationStatus: "skipped",
			updatedFields: [],
		});
		expect(await service.findById(created.bookingId)).toMatchObject({
			qualificationStatus: "skipped",
			qualification: {},
		});
		closeDomainDatabase(database);
	});

	test("rejects empty or legacy qualification and key conflicts", async () => {
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
		for (const [field, value] of [
			["role", "Head of Sales"],
			["crm", "amoCRM"],
		] as const) {
			const legacyInput = {
				bookingId: created.bookingId,
				idempotencyKey: `qualification-legacy-${field}`,
				patch: { [field]: value },
				completion: "partial",
			} as unknown as AppendQualificationInput;
			await expect(
				service.appendQualification(legacyInput),
			).rejects.toMatchObject({
				code: "BOOKING_VALIDATION_FAILED",
			});
		}
		expect(await service.findById(created.bookingId)).toMatchObject({
			qualificationStatus: "none",
			qualification: {},
		});
		await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-conflict-01",
			patch: { salesManagerCount: 3 },
			completion: "partial",
		});
		await expect(
			service.appendQualification({
				bookingId: created.bookingId,
				idempotencyKey: "qualification-conflict-01",
				patch: { salesManagerCount: 4 },
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
				"INSERT INTO bookings (id, conversation_id, name, contacts_json, company, meeting_start_at, meeting_end_at, meeting_timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					Bun.randomUUIDv7(),
					input.conversationId,
					"Duplicate",
					'[{"channel":"email","value":"duplicate@example.com"},{"channel":"telegram","value":"@duplicate"}]',
					"Duplicate LLC",
					secondMeetingSlot.startAt,
					secondMeetingSlot.endAt,
					secondMeetingSlot.timeZone,
					created.createdAt,
					created.createdAt,
				],
			),
		).toThrow("UNIQUE constraint failed");
		expect(() =>
			database.$client.run(
				"UPDATE bookings SET meeting_start_at = '2099-01-05 06:00:00' WHERE id = ?",
				[created.bookingId],
			),
		).toThrow("booking requires a valid internal meeting slot");
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
