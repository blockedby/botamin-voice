import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count } from "drizzle-orm";
import { ConversationStore } from "../../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../../db/database";
import {
	bookings,
	conversations,
	domainEvents,
	idempotencyKeys,
	notificationOutbox,
	turns,
} from "../../db/schema";
import { SqliteBookingService } from "../booking/service";
import { LeadDataDeletionService } from "./deletion";
import { redactForLog } from "./redaction";
import { TranscriptRetentionWorker } from "./retention";

const directories: string[] = [];
const at = "2026-07-30T20:22:00.000Z";

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("PII privacy services", () => {
	test("redacts contact-shaped values and sensitive structured fields", () => {
		const redacted = JSON.stringify(
			redactForLog({
				name: "Александр",
				contacts: [{ channel: "email", value: "alex@example.com" }],
				user_text: "raw transcript",
				contacts_json: '[{"value":"secret_handle"}]',
				message:
					"Call +7 999 123-45-67 or @alex_private; telegram secret_handle",
			}),
		);
		expect(redacted).not.toContain("Александр");
		expect(redacted).not.toContain("alex@example.com");
		expect(redacted).not.toContain("999 123");
		expect(redacted).not.toContain("@alex_private");
		expect(redacted).not.toContain("secret_handle");
		expect(redacted).not.toContain("raw transcript");
		expect(redacted).toContain("[REDACTED]");
	});

	test("startup and scheduled retention purge bounded turn PII without deleting bookings", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-retention-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		const store = new ConversationStore(database);
		store.create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "a".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: "2026-07-01T00:00:00.000Z",
			startedAt: "2026-07-01T00:00:00.000Z",
		});
		for (const text of ["old secret one", "old secret two"]) {
			store.appendTurn({
				id: Bun.randomUUIDv7(),
				conversationId,
				userText: text,
				assistantText: "old assistant PII",
				stateBefore: "COLLECT_BOOKING",
				stateAfter: "COLLECT_BOOKING",
				completedAt: "2026-07-02T00:00:00.000Z",
			});
		}
		store.appendTurn({
			id: Bun.randomUUIDv7(),
			conversationId,
			userText: "recent text",
			assistantText: "recent assistant",
			stateBefore: "COLLECT_BOOKING",
			stateAfter: "COLLECT_BOOKING",
			completedAt: "2026-08-20T00:00:00.000Z",
		});
		await new SqliteBookingService(database, {
			now: () => new Date("2026-07-03T00:00:00.000Z"),
		}).createBooking({
			conversationId,
			idempotencyKey: "retention-booking-0001",
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex" }],
			consentConfirmed: true,
		});

		let scheduled: (() => void) | undefined;
		const worker = new TranscriptRetentionWorker(database, {
			retentionDays: 30,
			now: () => new Date("2026-08-30T00:00:00.000Z"),
			batchSize: 1,
			maxBatchesPerRun: 1,
			intervalMs: 1_000,
			schedule: (callback) => {
				scheduled = callback;
				return 1;
			},
			cancel: () => undefined,
		});
		expect(worker.start()).toBe(1);
		expect(database.select({ value: count() }).from(turns).get()?.value).toBe(
			2,
		);
		scheduled?.();
		expect(database.select({ value: count() }).from(turns).get()?.value).toBe(
			1,
		);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(conversations).get()?.value,
		).toBe(1);
		expect(database.select().from(turns).get()?.userText).toBe("recent text");
		worker.stop();
		closeDomainDatabase(database);
	});

	test("deletes lead PII and raw outbox while preserving redacted audit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-delete-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		const store = new ConversationStore(database);
		store.create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "f".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: at,
			startedAt: at,
		});
		store.appendTurn({
			id: Bun.randomUUIDv7(),
			conversationId,
			userText: "Мой email alex@example.com",
			assistantText: "Контакт получен",
			stateBefore: "COLLECT_BOOKING",
			stateAfter: "BOOKED",
			completedAt: at,
		});
		const service = new SqliteBookingService(database);
		const created = await service.createBooking({
			conversationId,
			idempotencyKey: "delete-booking-0001",
			name: "Александр",
			contacts: [{ channel: "email", value: "alex@example.com" }],
			company: "Private Company",
			consentConfirmed: true,
		});
		await service.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "delete-qualification-01",
			patch: { notes: "Call +7 999 123-45-67" },
			completion: "partial",
		});
		expect(
			database.select({ value: count() }).from(notificationOutbox).get()?.value,
		).toBe(2);

		const result = new LeadDataDeletionService(database).deleteConversation(
			conversationId,
		);
		expect(result).toMatchObject({
			deleted: true,
			deletedBookings: 1,
			deletedTurns: 1,
			deletedOutboxEntries: 2,
		});
		for (const table of [
			bookings,
			conversations,
			idempotencyKeys,
			notificationOutbox,
			turns,
		]) {
			expect(database.select({ value: count() }).from(table).get()?.value).toBe(
				0,
			);
		}
		const auditPayloads = database
			.select({ payload: domainEvents.payloadJson })
			.from(domainEvents)
			.all()
			.map((row) => row.payload)
			.join("\n");
		expect(auditPayloads).toContain("privacy.deleted");
		expect(auditPayloads).not.toContain("Александр");
		expect(auditPayloads).not.toContain("alex@example.com");
		expect(auditPayloads).not.toContain("Private Company");
		expect(auditPayloads).not.toContain("999 123");

		const replay = new LeadDataDeletionService(database).deleteConversation(
			conversationId,
		);
		expect(replay.deleted).toBe(false);
		closeDomainDatabase(database);
	});
});
