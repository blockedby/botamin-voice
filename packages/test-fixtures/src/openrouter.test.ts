import { afterEach, describe, expect, test } from "bun:test";
import {
	createDeterministicMp3Fixture,
	createDeterministicPcm16Fixture,
	createDeterministicPcm16Frame,
	createDeterministicPcm16Frames,
	createDeterministicWavFixture,
	createInvalidMp3Fixtures,
	createInvalidWavFixtures,
	createOpenRouterFixture,
	createRawPcm16Fixture,
	parseMonoPcm16Wav,
} from "./index";
import type { OpenRouterFixtureServer } from "./openrouter";

const servers: OpenRouterFixtureServer[] = [];
const fixtureKey = "qa-only-fixture-key";

function chatBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "stt-model",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Transcribe this audio." },
					{
						type: "input_audio",
						input_audio: {
							data: Buffer.from(createDeterministicWavFixture()).toString(
								"base64",
							),
							format: "wav",
						},
					},
				],
			},
		],
		...overrides,
	};
}

function ttsBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "tts-model",
		voice: "eve",
		input: "hello",
		response_format: "mp3",
		...overrides,
	};
}

function jsonInit(body: unknown, authorization = fixtureKey): RequestInit {
	return {
		method: "POST",
		headers: {
			Authorization: `Bearer ${authorization}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	};
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("fake OpenRouter fixture", () => {
	test("exports isolated microphone, raw PCM, canonical WAV and MP3 variants", () => {
		const pcm = createDeterministicPcm16Fixture();
		expect(createRawPcm16Fixture()).toEqual(pcm);
		expect(createDeterministicPcm16Frame()).toEqual(pcm);
		expect(createDeterministicPcm16Frames()).toEqual([pcm]);
		expect(() => parseMonoPcm16Wav(createRawPcm16Fixture())).toThrow();
		for (const wav of Object.values(createInvalidWavFixtures())) {
			expect(() => parseMonoPcm16Wav(wav)).toThrow();
			expect(() => createOpenRouterFixture({ expectedWav: wav })).toThrow();
		}
		const invalidMp3 = createInvalidMp3Fixtures();
		expect(invalidMp3.malformed).not.toEqual(createDeterministicMp3Fixture());
		expect(invalidMp3.truncated.byteLength).toBeLessThan(
			createDeterministicMp3Fixture().byteLength,
		);
	});

	test("shares protocol validation and complete responses through injected fetch", async () => {
		const fixture = createOpenRouterFixture({
			expectedTts: { model: "tts-model", voice: "eve" },
		});
		const wav = createDeterministicWavFixture();
		const chat = await fixture.fetch("http://fixture/api/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixtureKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "stt-model",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Transcribe this audio." },
							{
								type: "input_audio",
								input_audio: {
									data: Buffer.from(wav).toString("base64"),
									format: "wav",
								},
							},
						],
					},
				],
			}),
		});
		const chatBody = (await chat.json()) as {
			choices?: unknown[];
			usage?: unknown;
		};
		expect(chat.status).toBe(200);
		expect(chatBody.choices).toHaveLength(1);
		expect(chatBody.usage).toBeDefined();

		const tts = await fixture.fetch("http://fixture/api/v1/audio/speech", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixtureKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "tts-model",
				voice: "eve",
				input: "hello",
				response_format: "mp3",
			}),
		});
		expect(tts.headers.get("Content-Type")).toContain("audio/mpeg");
		expect([...new Uint8Array(await tts.arrayBuffer())]).toEqual([
			...createDeterministicMp3Fixture(),
		]);
		expect(fixture.counters).toMatchObject({
			total: 2,
			chat: 1,
			tts: 1,
			invalid: 0,
		});
	});

	test("fails closed before scripted behavior for every malformed protocol class", async () => {
		const alternateWav = createDeterministicWavFixture();
		alternateWav[44] = (alternateWav[44] ?? 0) ^ 1;
		const invalidCases: ReadonlyArray<{
			name: string;
			endpoint: "chat" | "tts";
			url?: string;
			init: RequestInit;
			status?: 400 | 404;
			violations: readonly string[];
		}> = [
			{
				name: "path",
				endpoint: "chat",
				url: "http://fixture/api/v1/not-a-provider-route",
				init: jsonInit(chatBody()),
				status: 404,
				violations: ["UNSUPPORTED_ROUTE"],
			},
			{
				name: "authorization",
				endpoint: "chat",
				init: jsonInit(chatBody(), "wrong-key"),
				violations: ["AUTHORIZATION"],
			},
			{
				name: "content type",
				endpoint: "chat",
				init: {
					...jsonInit(chatBody()),
					headers: {
						Authorization: `Bearer ${fixtureKey}`,
						"Content-Type": "text/plain",
					},
				},
				violations: ["CONTENT_TYPE"],
			},
			{
				name: "JSON",
				endpoint: "chat",
				init: { ...jsonInit(chatBody()), body: "{malformed" },
				violations: ["INVALID_JSON"],
			},
			{
				name: "STT model",
				endpoint: "chat",
				init: jsonInit(chatBody({ model: "wrong-model" })),
				violations: ["CHAT_MODEL"],
			},
			{
				name: "input_audio format",
				endpoint: "chat",
				init: jsonInit(
					chatBody({
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "Transcribe this audio." },
									{
										type: "input_audio",
										input_audio: {
											data: Buffer.from(
												createDeterministicWavFixture(),
											).toString("base64"),
											format: "mp3",
										},
									},
								],
							},
						],
					}),
				),
				violations: ["CHAT_AUDIO_FORMAT"],
			},
			{
				name: "input_audio base64",
				endpoint: "chat",
				init: jsonInit(
					chatBody({
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "Transcribe this audio." },
									{
										type: "input_audio",
										input_audio: { data: "%%%not-base64%%%", format: "wav" },
									},
								],
							},
						],
					}),
				),
				violations: ["CHAT_AUDIO_BASE64"],
			},
			{
				name: "input_audio WAV",
				endpoint: "chat",
				init: jsonInit(
					chatBody({
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "Transcribe this audio." },
									{
										type: "input_audio",
										input_audio: {
											data: Buffer.from("not a WAV").toString("base64"),
											format: "wav",
										},
									},
								],
							},
						],
					}),
				),
				violations: ["CHAT_AUDIO_WAV"],
			},
			{
				name: "unexpected valid WAV bytes",
				endpoint: "chat",
				init: jsonInit(
					chatBody({
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: "Transcribe this audio." },
									{
										type: "input_audio",
										input_audio: {
											data: Buffer.from(alternateWav).toString("base64"),
											format: "wav",
										},
									},
								],
							},
						],
					}),
				),
				violations: ["CHAT_AUDIO_BYTES"],
			},
			{
				name: "TTS authorization",
				endpoint: "tts",
				init: jsonInit(ttsBody(), "wrong-key"),
				violations: ["AUTHORIZATION"],
			},
			{
				name: "TTS content type",
				endpoint: "tts",
				init: {
					...jsonInit(ttsBody()),
					headers: {
						Authorization: `Bearer ${fixtureKey}`,
						"Content-Type": "text/plain",
					},
				},
				violations: ["CONTENT_TYPE"],
			},
			{
				name: "TTS body schema",
				endpoint: "tts",
				init: jsonInit([]),
				violations: ["TTS_BODY"],
			},
			{
				name: "TTS model",
				endpoint: "tts",
				init: jsonInit(ttsBody({ model: "wrong-model" })),
				violations: ["TTS_MODEL"],
			},
			{
				name: "TTS voice",
				endpoint: "tts",
				init: jsonInit(ttsBody({ voice: "wrong-voice" })),
				violations: ["TTS_VOICE"],
			},
			{
				name: "TTS input",
				endpoint: "tts",
				init: jsonInit(ttsBody({ input: " " })),
				violations: ["TTS_INPUT"],
			},
			{
				name: "TTS response format",
				endpoint: "tts",
				init: jsonInit(ttsBody({ response_format: "wav" })),
				violations: ["TTS_FORMAT"],
			},
			{
				name: "TTS speed schema",
				endpoint: "tts",
				init: jsonInit(ttsBody({ speed: "fast" })),
				violations: ["TTS_SPEED"],
			},
			{
				name: "TTS unexpected property schema",
				endpoint: "tts",
				init: jsonInit(ttsBody({ secret_extension: true })),
				violations: ["TTS_SCHEMA"],
			},
		];

		for (const invalidCase of invalidCases) {
			const fixture = createOpenRouterFixture({
				expectedApiKey: fixtureKey,
				expectedSttModel: "stt-model",
				expectedTts: { model: "tts-model", voice: "eve" },
				behaviors: [
					{
						status: 429,
						retryAfter: "1",
						jsonBody: { error: { message: "scripted result sentinel" } },
					},
				],
			});
			const invalid = await fixture.fetch(
				invalidCase.url ??
					`http://fixture${
						invalidCase.endpoint === "chat"
							? "/api/v1/chat/completions"
							: "/api/v1/audio/speech"
					}`,
				invalidCase.init,
			);
			expect(invalid.status, invalidCase.name).toBe(invalidCase.status ?? 400);
			expect(invalid.status, invalidCase.name).not.toBe(200);
			expect(invalid.status, invalidCase.name).not.toBe(429);
			expect(fixture.protocolViolations, invalidCase.name).toEqual(
				invalidCase.violations,
			);

			const valid = await fixture.fetch(
				`http://fixture${
					invalidCase.endpoint === "chat"
						? "/api/v1/chat/completions"
						: "/api/v1/audio/speech"
				}`,
				jsonInit(invalidCase.endpoint === "chat" ? chatBody() : ttsBody()),
			);
			expect(valid.status, invalidCase.name).toBe(429);
			expect(valid.headers.get("Retry-After"), invalidCase.name).toBe("1");
			expect(fixture.protocolViolations, invalidCase.name).toEqual(
				invalidCase.violations,
			);
			expect(JSON.stringify(fixture), invalidCase.name).not.toContain(
				"scripted result sentinel",
			);
		}
	});

	test("serves the same handler on a Bun loopback server", async () => {
		const fixture = createOpenRouterFixture();
		const server = fixture.startServer();
		servers.push(server);
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/audio/speech`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${fixtureKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "x",
					voice: "eve",
					input: "hello",
					response_format: "mp3",
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(fixture.counters.tts).toBe(1);
	});
});
