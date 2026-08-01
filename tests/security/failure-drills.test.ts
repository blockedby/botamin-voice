import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeDomainDatabase,
	openDomainDatabase,
} from "../../apps/server/src/db";
import { ConversationStore } from "../../apps/server/src/db/conversation-store";
import { SqliteBookingService } from "../../apps/server/src/domain/booking";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "../../apps/server/src/orchestrator/orchestrator";
import { createInitialConversationState } from "../../apps/server/src/orchestrator/state";
import { OpenRouterSttAdapter } from "../../apps/server/src/providers/openrouter/stt";
import { loadOpenRouterVoiceConfig } from "../../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterTtsAdapter } from "../../apps/server/src/providers/openrouter/tts";
import type {
	BrainDelta,
	CreateBookingInput,
} from "../../packages/contracts/src";
import {
	createDeterministicWavFixture,
	createTestBookingContacts,
	createTestMeetingSlot,
	FakeBrain,
	FakeStt,
} from "../../packages/test-fixtures/src";

const directories: string[] = [];
const promptVersion = "d".repeat(64);

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

describe("safe provider failure drills", () => {
	test("OpenRouter STT 401/402/404 cannot damage an existing booking", async () => {
		for (const status of [401, 402, 404]) {
			const directory = mkdtempSync(
				join(tmpdir(), `botamin-stt-${status}-drill-`),
			);
			directories.push(directory);
			const database = openDomainDatabase({
				filename: join(directory, "app.db"),
			});
			const conversationId = Bun.randomUUIDv7();
			const turnId = Bun.randomUUIDv7();
			const generationId = Bun.randomUUIDv7();
			new ConversationStore(database).create({
				id: conversationId,
				stage: "BOOKED",
				promptVersion,
				source: "landing",
				locale: "ru-RU",
				qualificationEnabled: true,
				consentAt: "2026-07-31T00:00:00.000Z",
				startedAt: "2026-07-31T00:00:00.000Z",
			});
			const service = new SqliteBookingService(database, {
				notifierKind: "webhook",
			});
			await service.createBooking({
				conversationId,
				idempotencyKey: `stt-provider-drill-${status}`,
				name: "Мария",
				contacts: createTestBookingContacts(),
				company: "Private Example LLC",
				meetingSlot: createTestMeetingSlot(),
				consentConfirmed: true,
			});
			const booking = await service.findByConversationId(conversationId);
			if (!booking) throw new Error("expected existing booking");
			let fetches = 0;
			const circuitStates: string[] = [];
			const providerErrorMarker = `private-stt-provider-body-${status}`;
			const stt = new OpenRouterSttAdapter({
				config: loadOpenRouterVoiceConfig({
					OPENROUTER_API_KEY: "drill-placeholder-not-a-real-key",
					STT_MAX_RETRIES: "1",
					STT_RETRY_BASE_MS: "0",
				}),
				circuitTelemetry: (state) => circuitStates.push(state),
				fetch: async () => {
					fetches += 1;
					return Response.json(
						{ error: { code: status, message: providerErrorMarker } },
						{ status },
					);
				},
			});
			const brain = new FakeBrain();
			const orchestrator = new ConversationOrchestrator({
				conversationId,
				promptVersion,
				stt,
				brain,
				bookings: service,
				initialState: {
					...createInitialConversationState(),
					stage: "BOOKED",
					booking,
					bookingConfirmationDelivered: true,
					contactConsentConfirmed: true,
				},
			});
			const events = await collect(
				orchestrator.acceptAudioCommit({
					turnId,
					generationId,
					audio: createDeterministicWavFixture(),
					contentType: "audio/wav",
					knownFacts: { useCases: [], painPoints: [], objections: [] },
				}),
			);
			expect(fetches).toBe(1);
			expect(circuitStates).toEqual(["closed", "open"]);
			expect(brain.turns).toHaveLength(0);
			expect(events).toContainEqual({
				type: "degraded",
				generationId,
				provider: "stt",
				code: "STT_UNAVAILABLE",
				textFallback:
					"Речь сейчас не распознаётся. Повторите, пожалуйста, реплику ещё раз.",
			});
			expect(JSON.stringify(events)).not.toContain(providerErrorMarker);
			expect(
				database.$client
					.query<{ value: number }, []>(
						"SELECT COUNT(*) AS value FROM bookings",
					)
					.get()?.value,
			).toBe(1);
			expect((await service.findByConversationId(conversationId))?.id).toBe(
				booking.id,
			);
			await orchestrator.close();
			closeDomainDatabase(database);
		}
	});

	test("OpenRouter TTS 401/402/404 degrades once after durable booking", async () => {
		for (const status of [401, 402, 404]) {
			const directory = mkdtempSync(join(tmpdir(), `botamin-${status}-drill-`));
			directories.push(directory);
			const database = openDomainDatabase({
				filename: join(directory, "app.db"),
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
				consentAt: "2026-07-31T00:00:00.000Z",
				startedAt: "2026-07-31T00:00:00.000Z",
			});
			const bookingService = new SqliteBookingService(database, {
				notifierKind: "webhook",
			});
			const bookingInput: CreateBookingInput = {
				conversationId,
				idempotencyKey: `provider-drill-${status}-booking`,
				name: "Мария",
				contacts: createTestBookingContacts(),
				company: "Private Example LLC",
				meetingSlot: (await bookingService.candidateMeetingSlots())[0],
				consentConfirmed: true,
			};
			const script: BrainDelta[] = [
				{
					type: "tool.request",
					turnId,
					generationId,
					tool: {
						name: "create_booking",
						callId: `provider-drill-${status}`,
						args: bookingInput,
					},
				},
				{ type: "turn.completed", turnId, generationId },
			];
			let fetches = 0;
			const circuitStates: string[] = [];
			const providerErrorMarker = `private-provider-body-${status}`;
			const tts = new OpenRouterTtsAdapter({
				config: loadOpenRouterVoiceConfig({
					OPENROUTER_API_KEY: "drill-placeholder-not-a-real-key",
					TTS_MAX_RETRIES: "1",
					TTS_RETRY_BASE_MS: "0",
					TTS_TEXT_ONLY_FALLBACK: "true",
				}),
				circuitTelemetry: (state) => circuitStates.push(state),
				fetch: async () => {
					fetches += 1;
					return Response.json(
						{ error: { code: status, message: providerErrorMarker } },
						{ status },
					);
				},
			});
			const orchestrator = new ConversationOrchestrator({
				conversationId,
				promptVersion,
				stt: new FakeStt({ text: "Сохраните контакт" }),
				brain: new FakeBrain(script),
				bookings: bookingService,
				tts,
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
			expect(
				database.$client
					.query<{ value: number }, []>(
						"SELECT COUNT(*) AS value FROM bookings",
					)
					.get()?.value,
			).toBe(1);
			expect(
				database.$client
					.query<{ value: number }, []>(
						"SELECT COUNT(*) AS value FROM notification_outbox",
					)
					.get()?.value,
			).toBe(1);
			expect(fetches).toBe(1);
			expect(circuitStates).toEqual(["closed", "open"]);
			expect(await tts.health()).toBe("degraded");
			const committedIndex = events.findIndex(
				(event) => event.type === "booking.committed",
			);
			const degradedIndex = events.findIndex(
				(event) => event.type === "degraded" && event.provider === "tts",
			);
			expect(committedIndex).toBeGreaterThanOrEqual(0);
			expect(degradedIndex).toBeGreaterThan(committedIndex);
			expect(JSON.stringify(events)).not.toContain(providerErrorMarker);
			expect(orchestrator.state.booking?.status).toBe("booked");
			await orchestrator.close();
			closeDomainDatabase(database);
		}
	});
});
