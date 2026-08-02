import { afterEach, describe, expect, test } from "bun:test";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "../../apps/server/src/orchestrator/orchestrator";
import {
	type ConversationState,
	createInitialConversationState,
} from "../../apps/server/src/orchestrator/state";
import { OpenRouterSttAdapter } from "../../apps/server/src/providers/openrouter/stt/adapter";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterSttError } from "../../apps/server/src/providers/openrouter/stt/errors";
import { OpenRouterTtsAdapter } from "../../apps/server/src/providers/openrouter/tts/adapter";
import type {
	BrainDelta,
	SttTranscriptionRequest,
} from "../../packages/contracts/src";
import {
	createDeterministicMp3Fixture,
	createDeterministicPcm16Fixture,
	createDeterministicWavFixture,
	createOpenRouterFixture,
	createTestBookingContacts,
	createTestMeetingSlot,
	FakeBookingService,
	FakeBrain,
	FakeNotifier,
	parseMonoPcm16Wav,
} from "../../packages/test-fixtures/src";
import type { OpenRouterFixtureServer } from "../../packages/test-fixtures/src/openrouter";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000001";
const generationId = "01J00000000000000000000002";
const segmentId = "01J00000000000000000000003";
const bookingId = "01J00000000000000000000004";
const key = "t22-openrouter-fixture-key";
const servers: OpenRouterFixtureServer[] = [];

function voiceConfig(
	baseUrl: string,
	overrides: {
		stt?: Partial<OpenRouterVoiceConfig["stt"]>;
		tts?: Partial<OpenRouterVoiceConfig["tts"]>;
	} = {},
): OpenRouterVoiceConfig {
	const loaded = loadOpenRouterVoiceConfig({
		OPENROUTER_API_KEY: key,
		OPENROUTER_BASE_URL: baseUrl,
		STT_RETRY_BASE_MS: "0",
		TTS_RETRY_BASE_MS: "0",
	});
	return {
		...loaded,
		stt: { ...loaded.stt, ...overrides.stt },
		tts: { ...loaded.tts, ...overrides.tts },
	};
}

function collectionState(): ConversationState {
	return {
		...createInitialConversationState(),
		stage: "COLLECT_BOOKING",
		contactConsentConfirmed: true,
	};
}

function valueState(): ConversationState {
	return { ...createInitialConversationState(), stage: "VALUE" };
}

async function collect(
	iterable: AsyncIterable<OrchestratorEvent>,
): Promise<OrchestratorEvent[]> {
	const events: OrchestratorEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("cross-component OpenRouter voice contracts", () => {
	test("one WAV crosses adapter unchanged; each provider retries once without repeating brain, tools, notifier or booking", async () => {
		const wav = createDeterministicWavFixture();
		const provider = createOpenRouterFixture({
			expectedWav: wav,
			expectedApiKey: key,
			expectedSttModel: "openai/gpt-audio-mini",
			expectedTts: {
				model: "x-ai/grok-voice-tts-1.0",
				voice: "eve",
			},
			chatBehaviors: [{ status: 503, retryAfter: "0" }, {}],
			ttsBehaviors: [
				{ status: 503, retryAfter: "0" },
				{ responseChunkBytes: 97 },
			],
		});
		const server = provider.startServer();
		servers.push(server);
		const config = voiceConfig(`http://127.0.0.1:${server.port}/api/v1`);
		const stt = new OpenRouterSttAdapter({ config });
		const tts = new OpenRouterTtsAdapter({ config });
		const notifier = new FakeNotifier();
		const bookings = new FakeBookingService({
			notifier,
			bookingId: () => bookingId,
		});
		const bookingScript: BrainDelta[] = [
			{
				type: "tool.request",
				turnId,
				generationId,
				tool: {
					name: "create_booking",
					callId: "t22-booking-call",
					args: {
						conversationId,
						idempotencyKey: "t22-booking-idempotency",
						name: "Тест",
						contacts: createTestBookingContacts(),
						company: "Example LLC",
						meetingSlot: createTestMeetingSlot(),
						consentConfirmed: true,
					},
				},
			},
			{ type: "turn.completed", turnId, generationId },
		];
		const brain = new FakeBrain(bookingScript);
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion: "a".repeat(64),
			stt,
			brain,
			bookings,
			tts,
			initialState: collectionState(),
			createId: () => segmentId,
		});

		const events = await collect(
			orchestrator.acceptAudioCommit({
				turnId,
				generationId,
				audio: wav,
				contentType: "audio/wav",
				knownFacts: { useCases: [], painPoints: [], objections: [] },
			}),
		);

		expect(provider.protocolViolations).toEqual([]);
		expect(provider.counters).toEqual({
			total: 7,
			chat: 2,
			tts: 5,
			invalid: 0,
			statuses: { "200": 5, "503": 2 },
		});
		expect(brain.turns).toHaveLength(1);
		expect(
			events.filter(
				(event) =>
					event.type === "tool.result" && event.name === "create_booking",
			),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "booking.committed"),
		).toHaveLength(1);
		expect(bookings.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
		]);
		expect(notifier.events.map((event) => event.type)).toEqual([
			"booking.created",
		]);
		expect(
			events.filter((event) => event.type === "transcript.final"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type.startsWith("transcript.")),
		).toEqual([
			expect.objectContaining({
				type: "transcript.final",
				turnId,
			}),
		]);
		const audio = events.filter((event) => event.type === "audio.segment");
		expect(audio).toHaveLength(4);
		expect(provider.counters.tts).toBe(audio.length + 1);
		for (const segment of audio) {
			expect(segment).toMatchObject({
				contentType: "audio/mpeg",
				final: true,
				bytes: createDeterministicMp3Fixture(),
			});
		}
	});

	test("adapter refuses raw PCM instead of converting it to WAV or issuing fetch", async () => {
		const provider = createOpenRouterFixture({ expectedApiKey: key });
		const adapter = new OpenRouterSttAdapter({
			config: voiceConfig("http://127.0.0.1:1/api/v1"),
			fetch: provider.fetch,
		});
		const request: SttTranscriptionRequest = {
			conversationId,
			turnId,
			audio: createDeterministicPcm16Fixture(),
			contentType: "audio/wav",
			language: "ru",
			signal: new AbortController().signal,
		};
		await expect(adapter.transcribe(request)).rejects.toMatchObject({
			code: "STT_INVALID_REQUEST",
		});
		expect(provider.counters.total).toBe(0);
		expect(() => parseMonoPcm16Wav(request.audio)).toThrow();
	});

	test("TTS non-2xx JSON can degrade visible text but can never become browser audio", async () => {
		const providerBody = Buffer.from(createDeterministicMp3Fixture()).toString(
			"base64",
		);
		const provider = createOpenRouterFixture({
			expectedWav: createDeterministicWavFixture(),
			expectedApiKey: key,
			chatBehaviors: [{}],
			ttsBehaviors: [
				{
					status: 402,
					jsonBody: { error: { message: providerBody } },
				},
			],
		});
		const server = provider.startServer();
		servers.push(server);
		const config = voiceConfig(`http://127.0.0.1:${server.port}/api/v1`);
		const brain = new FakeBrain([
			{
				type: "speech.delta",
				turnId,
				generationId,
				text: "Проверяем безопасный текстовый ответ без звука.",
			},
			{ type: "turn.completed", turnId, generationId },
		]);
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion: "b".repeat(64),
			stt: new OpenRouterSttAdapter({ config }),
			brain,
			bookings: new FakeBookingService(),
			tts: new OpenRouterTtsAdapter({ config }),
			initialState: valueState(),
			createId: () => segmentId,
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
		expect(provider.counters).toMatchObject({ chat: 1, tts: 1 });
		expect(events.some((event) => event.type === "text.done")).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "degraded", provider: "tts" }),
		);
		expect(events.some((event) => event.type === "audio.segment")).toBe(false);
		expect(JSON.stringify(events)).not.toContain(providerBody);
	});

	test("typed STT errors expose no provider response body", async () => {
		const secretBody = "provider-secret-body";
		const provider = createOpenRouterFixture({
			chatBehaviors: [
				{ status: 401, jsonBody: { error: { message: secretBody } } },
			],
		});
		const adapter = new OpenRouterSttAdapter({
			config: voiceConfig("http://127.0.0.1:1/api/v1", {
				stt: { maxRetries: 0 },
			}),
			fetch: provider.fetch,
		});
		let error: unknown;
		try {
			await adapter.transcribe({
				conversationId,
				turnId,
				audio: createDeterministicWavFixture(),
				contentType: "audio/wav",
				language: "ru",
				signal: new AbortController().signal,
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(OpenRouterSttError);
		expect(error).toMatchObject({ code: "STT_PROVIDER_AUTH", status: 401 });
		expect(String(error)).not.toContain(secretBody);
	});
});
