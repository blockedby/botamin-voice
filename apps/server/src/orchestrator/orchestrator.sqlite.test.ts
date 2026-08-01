import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainDelta, CreateBookingInput } from "@botamin/contracts";
import { count } from "drizzle-orm";
import {
	createTestBookingContacts,
	FakeBrain,
	FakeStt,
	FakeTts,
} from "../../../../packages/test-fixtures/src";
import { ConversationStore } from "../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../db/database";
import { bookings, domainEvents, notificationOutbox } from "../db/schema";
import { SqliteBookingService } from "../domain/booking";
import { generateCandidateMeetingSlots } from "../domain/booking/support";
import type { NamedLeadNotifier } from "../notifiers/notifier";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "./orchestrator";
import { createInitialConversationState } from "./state";

const directories: string[] = [];
const promptVersion = "b".repeat(64);
const timestamp = "2026-07-30T20:22:00.000Z";

class FailingNotifier implements NamedLeadNotifier {
	readonly kind = "timeline-test";
	attempts = 0;
	async publish(): Promise<void> {
		this.attempts += 1;
		throw new Error("private notifier transport failure");
	}
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function collect(
	iterable: AsyncIterable<OrchestratorEvent>,
): Promise<OrchestratorEvent[]> {
	const events: OrchestratorEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("orchestrator with durable SQLite booking service", () => {
	test("DB/event/outbox commit survives notifier and TTS-independent confirmation timeline", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-orchestrator-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		const turnId = Bun.randomUUIDv7();
		const generationId = Bun.randomUUIDv7();
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
		const input: CreateBookingInput = {
			conversationId,
			idempotencyKey: "sqlite-orchestrator-create-01",
			name: "Мария",
			contacts: createTestBookingContacts(),
			company: "Private Example LLC",
			meetingSlot: generateCandidateMeetingSlots(new Date(timestamp))[0],
			consentConfirmed: true,
		};
		const script: BrainDelta[] = [
			{
				type: "tool.request",
				turnId,
				generationId,
				tool: {
					name: "create_booking",
					callId: "sqlite-create-call",
					args: input,
				},
			},
			{ type: "turn.completed", turnId, generationId },
		];
		const notifier = new FailingNotifier();
		const service = new SqliteBookingService(database, {
			notifier,
			now: () => new Date(timestamp),
		});
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion,
			stt: new FakeStt({ text: "Сохраните мой контакт" }),
			brain: new FakeBrain(script),
			bookings: service,
			tts: new FakeTts(),
			initialState: {
				...createInitialConversationState(),
				stage: "COLLECT_BOOKING",
				contactConsentConfirmed: true,
			},
		});

		const events = await collect(
			orchestrator.acceptAudioCommit({
				turnId,
				generationId,
				audio: new Uint8Array([82, 73, 70, 70]),
				contentType: "audio/wav",
				knownFacts: { useCases: [], painPoints: [], objections: [] },
			}),
		);
		const types = events.map((event) => event.type);
		expect(types.indexOf("booking.committed")).toBeLessThan(
			types.indexOf("text.delta"),
		);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(notificationOutbox).get()?.value,
		).toBe(1);
		expect(notifier.attempts).toBe(1);
		expect(orchestrator.state.booking?.status).toBe("booked");
		expect(JSON.stringify(events)).not.toContain(
			"private notifier transport failure",
		);
		closeDomainDatabase(database);
	});
});
