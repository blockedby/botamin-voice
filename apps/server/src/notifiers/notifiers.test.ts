import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BookingCreatedEventSchema,
	type BookingDomainEvent,
} from "@botamin/contracts";
import { ConversationStore } from "../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../db/database";
import { notificationOutbox } from "../db/schema";
import { SqliteBookingService } from "../domain/booking/service";
import { ConsoleLeadNotifier, type NamedLeadNotifier } from "./notifier";
import { NotificationOutboxWorker } from "./outbox";
import { SignedWebhookNotifier, signWebhookPayload } from "./webhook";

const directories: string[] = [];
const at = "2026-07-30T20:22:00.000Z";

function event(): BookingDomainEvent {
	return BookingCreatedEventSchema.parse({
		v: 1,
		type: "booking.created",
		eventId: Bun.randomUUIDv7(),
		occurredAt: at,
		data: {
			bookingId: Bun.randomUUIDv7(),
			conversationId: Bun.randomUUIDv7(),
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex" }],
			status: "booked",
			qualificationStatus: "none",
		},
	});
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("lead notifiers and outbox", () => {
	test("writes structured lead payload only to the dedicated console sink", async () => {
		const lines: string[] = [];
		const payload = event();
		await new ConsoleLeadNotifier((line) => lines.push(line)).publish(payload);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			channel: "lead-notifier",
			event: payload,
		});
	});

	test("signs the exact webhook body and supplies event deduplication headers", async () => {
		const payload = event();
		let capturedBody = "";
		let capturedHeaders = new Headers();
		const notifier = new SignedWebhookNotifier({
			url: "https://receiver.invalid/leads",
			signingSecret: "local-test-secret",
			now: () => new Date("2026-07-30T20:22:03.000Z"),
			fetch: async (_input, init) => {
				capturedBody = String(init?.body);
				capturedHeaders = new Headers(init?.headers);
				return new Response(null, { status: 204 });
			},
		});
		await notifier.publish(payload);

		const timestamp = "1785442923";
		expect(capturedBody).toBe(JSON.stringify(payload));
		expect(capturedHeaders.get("x-botamin-event-id")).toBe(payload.eventId);
		expect(capturedHeaders.get("x-botamin-timestamp")).toBe(timestamp);
		expect(capturedHeaders.get("x-botamin-signature")).toBe(
			`sha256=${signWebhookPayload(timestamp, capturedBody, "local-test-secret")}`,
		);
	});

	test("leases one outbox row so concurrent workers publish it once", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-outbox-lease-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "d".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: at,
			startedAt: at,
		});
		await new SqliteBookingService(database, {
			notifierKind: "webhook",
			now: () => new Date(at),
		}).createBooking({
			conversationId,
			idempotencyKey: "outbox-lease-booking-01",
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex" }],
			consentConfirmed: true,
		});
		const eventId = database.select().from(notificationOutbox).get()?.eventId;
		if (eventId === undefined) throw new Error("Expected pending notification");

		let releasePublish: () => void = () => undefined;
		let markPublishing: () => void = () => undefined;
		const publishGate = new Promise<void>((resolve) => {
			releasePublish = resolve;
		});
		const publishing = new Promise<void>((resolve) => {
			markPublishing = resolve;
		});
		let calls = 0;
		const notifier: NamedLeadNotifier = {
			kind: "webhook",
			async publish() {
				calls += 1;
				markPublishing();
				await publishGate;
			},
		};
		const firstWorker = new NotificationOutboxWorker(database, notifier, {
			now: () => new Date(at),
		});
		const secondWorker = new NotificationOutboxWorker(database, notifier, {
			now: () => new Date(at),
		});
		const first = firstWorker.processEvent(eventId);
		await publishing;
		const second = await secondWorker.processEvent(eventId);
		expect(second.delivered).toBe(false);
		releasePublish();
		expect((await first).delivered).toBe(true);
		expect(calls).toBe(1);
		expect(database.select().from(notificationOutbox).get()).toMatchObject({
			status: "sent",
			attemptCount: 1,
		});
		closeDomainDatabase(database);
	});

	test("does not let an expired claimant overwrite or report after reclaim failure", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-outbox-race-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "e".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: at,
			startedAt: at,
		});
		await new SqliteBookingService(database, {
			notifierKind: "webhook",
			now: () => new Date(at),
		}).createBooking({
			conversationId,
			idempotencyKey: "outbox-race-booking-01",
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex" }],
			consentConfirmed: true,
		});
		const eventId = database.select().from(notificationOutbox).get()?.eventId;
		if (eventId === undefined) throw new Error("Expected pending notification");

		let releaseFirst: () => void = () => undefined;
		let markFirstPublishing: () => void = () => undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstPublishing = new Promise<void>((resolve) => {
			markFirstPublishing = resolve;
		});
		const attemptedEventIds: string[] = [];
		let firstNow = new Date(at);
		const firstNotifier: NamedLeadNotifier = {
			kind: "webhook",
			async publish(payload) {
				attemptedEventIds.push(payload.eventId);
				markFirstPublishing();
				await firstGate;
			},
		};
		const secondNotifier: NamedLeadNotifier = {
			kind: "webhook",
			async publish(payload) {
				attemptedEventIds.push(payload.eventId);
				throw new Error("deterministic second-worker failure");
			},
		};
		const firstWorker = new NotificationOutboxWorker(database, firstNotifier, {
			now: () => firstNow,
			leaseMs: 1_000,
			claimTokenFactory: () => "claim-a",
		});
		const secondWorker = new NotificationOutboxWorker(
			database,
			secondNotifier,
			{
				now: () => new Date("2026-07-30T20:22:02.000Z"),
				leaseMs: 1_000,
				claimTokenFactory: () => "claim-b",
			},
		);

		const firstResult = firstWorker.processEvent(eventId);
		await firstPublishing;
		const secondResult = await secondWorker.processEvent(eventId);
		firstNow = new Date("2026-07-30T20:22:03.000Z");
		releaseFirst();

		expect(secondResult.delivered).toBe(false);
		expect((await firstResult).delivered).toBe(false);
		expect(attemptedEventIds).toEqual([eventId, eventId]);
		expect(database.select().from(notificationOutbox).get()).toMatchObject({
			status: "failed",
			attemptCount: 2,
			claimToken: null,
			lastError: "NOTIFIER_FAILED",
			nextAttemptAt: "2026-07-30T20:22:04.000Z",
			sentAt: null,
		});
		closeDomainDatabase(database);
	});

	test("retries a failed persisted notification without recreating booking", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-outbox-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "c".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: at,
			startedAt: at,
		});
		let unavailable = true;
		const delivered: BookingDomainEvent[] = [];
		const notifier: NamedLeadNotifier = {
			kind: "webhook",
			async publish(payload) {
				if (unavailable) throw new Error("temporary outage");
				delivered.push(payload);
			},
		};
		const result = await new SqliteBookingService(database, {
			notifier,
			now: () => new Date(at),
		}).createBooking({
			conversationId,
			idempotencyKey: "outbox-booking-0001",
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex" }],
			consentConfirmed: true,
		});
		expect(result.created).toBe(true);
		expect(database.select().from(notificationOutbox).get()).toMatchObject({
			status: "failed",
			attemptCount: 1,
		});

		unavailable = false;
		const retried = await new NotificationOutboxWorker(database, notifier, {
			now: () => new Date("2026-07-30T20:22:02.000Z"),
		}).processDue();
		expect(retried).toEqual([expect.objectContaining({ delivered: true })]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.data.bookingId).toBe(result.bookingId);
		expect(database.select().from(notificationOutbox).get()).toMatchObject({
			status: "sent",
			attemptCount: 2,
			lastError: null,
		});
		closeDomainDatabase(database);
	});
});
