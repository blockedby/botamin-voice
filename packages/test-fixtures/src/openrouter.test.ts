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
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
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

	test("records only safe protocol violation codes and supports queued HTTP behavior", async () => {
		const fixture = createOpenRouterFixture({
			behaviors: [
				{
					status: 429,
					retryAfter: "1",
					jsonBody: { secret: "must not be exposed" },
				},
				{ status: 500, malformedBody: true, wrongContentType: true },
			],
		});
		const body = JSON.stringify({
			model: "stt-model",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Transcribe this audio." },
						{
							type: "input_audio",
							input_audio: { data: "wrong", format: "mp3" },
						},
					],
				},
			],
		});
		const init = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		};
		const first = await fixture.fetch(
			"http://fixture/api/v1/chat/completions",
			init,
		);
		const second = await fixture.fetch(
			"http://fixture/api/v1/chat/completions",
			init,
		);
		expect(first.status).toBe(429);
		expect(first.headers.get("Retry-After")).toBe("1");
		expect(second.status).toBe(500);
		expect(fixture.protocolViolations).toEqual([
			"CHAT_AUDIO_FORMAT",
			"CHAT_AUDIO_BYTES",
			"CHAT_AUDIO_FORMAT",
			"CHAT_AUDIO_BYTES",
		]);
		expect(JSON.stringify(fixture)).not.toContain("must not be exposed");
	});

	test("serves the same handler on a Bun loopback server", async () => {
		const fixture = createOpenRouterFixture();
		const server = fixture.startServer();
		servers.push(server);
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/audio/speech`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
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
