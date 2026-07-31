import { afterEach, describe, expect, test } from "bun:test";
import type { SttTranscriptionRequest } from "@botamin/contracts";
import { createDeterministicWavFixture } from "../../../../../../packages/test-fixtures/src/wav";
import {
	OpenRouterSttAdapter,
	type OpenRouterSttTelemetryEvent,
} from "./adapter";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
	OpenRouterVoiceConfigError,
} from "./config";
import { OpenRouterSttError, type OpenRouterSttErrorCode } from "./errors";
import type { OpenRouterFetch } from "./http";

const CONVERSATION_ID = "01J00000000000000000000000";
const TURN_ID = "01J00000000000000000000001";
const TEST_KEY = "openrouter-test-secret";
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function config(
	stt: Partial<OpenRouterVoiceConfig["stt"]> = {},
	root: Partial<Pick<OpenRouterVoiceConfig, "apiKey" | "baseUrl">> = {},
): OpenRouterVoiceConfig {
	const loaded = loadOpenRouterVoiceConfig({
		OPENROUTER_API_KEY: TEST_KEY,
		STT_RETRY_BASE_MS: "0",
	});
	return { ...loaded, ...root, stt: { ...loaded.stt, ...stt } };
}

function request(
	overrides: Partial<SttTranscriptionRequest> = {},
): SttTranscriptionRequest {
	return {
		conversationId: CONVERSATION_ID,
		turnId: TURN_ID,
		audio: createDeterministicWavFixture(),
		contentType: "audio/wav",
		language: "ru",
		signal: new AbortController().signal,
		...overrides,
	};
}

function transcriptResponse(
	text = "Запишите меня на демонстрацию завтра",
	init: ResponseInit = {},
): Response {
	return Response.json(
		{ choices: [{ message: { content: text } }] },
		{ headers: { "x-request-id": "req_stt_1" }, ...init },
	);
}

async function captureError(
	promise: Promise<unknown>,
): Promise<OpenRouterSttError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OpenRouterSttError);
		return error as OpenRouterSttError;
	}
	throw new Error("Expected OpenRouterSttError");
}

function queuedFetch(
	responses: Array<Response | (() => Promise<Response>)>,
	calls: Array<{ url: string; init: RequestInit }> = [],
): OpenRouterFetch {
	return async (input, init = {}) => {
		calls.push({ url: String(input), init });
		const next = responses.shift();
		if (next === undefined) throw new Error("Unexpected fake fetch");
		return next instanceof Response ? next : next();
	};
}

describe("shared OpenRouter voice configuration", () => {
	test("loads one key and the corrected default STT/TTS profiles", () => {
		const loaded = loadOpenRouterVoiceConfig({ OPENROUTER_API_KEY: TEST_KEY });
		expect(loaded.apiKey).toBe(TEST_KEY);
		expect(loaded.stt.model).toBe("openai/gpt-audio-mini");
		expect(loaded.stt.audioFormat).toBe("wav");
		expect(loaded.stt.language).toBe("ru");
		expect(loaded.stt.textOnlyInputFallback).toBe(false);
		expect(loaded.tts.model).toBe("x-ai/grok-voice-tts-1.0");
		expect(loaded.tts.voice).toBe("eve");
		expect(loaded.tts.responseFormat).toBe("mp3");
	});

	test("rejects unsafe or out-of-contract configuration without echoing values", () => {
		for (const env of [
			{ STT_MAX_RETRIES: "2" },
			{ OPENROUTER_STT_AUDIO_FORMAT: "pcm16" },
			{ STT_TEXT_ONLY_INPUT_FALLBACK: "true" },
			{ TTS_MAX_CHARS_PER_SEGMENT: "10", TTS_MAX_CHARS_PER_TURN: "9" },
			{ OPENROUTER_STT_LANGUAGE: "ru\nAuthorization: bad" },
			{ OPENROUTER_BASE_URL: "https://user:secret@openrouter.ai/api/v1" },
		]) {
			expect(() => loadOpenRouterVoiceConfig(env)).toThrow(
				OpenRouterVoiceConfigError,
			);
		}
	});
});

describe("OpenRouterSttAdapter protocol", () => {
	test("uses native HTTP chat completions with unchanged WAV base64 and one final transcript", async () => {
		let capturedBody: unknown;
		let capturedHeaders = new Headers();
		let capturedMethod = "";
		let capturedPath = "";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (incoming) => {
				capturedMethod = incoming.method;
				capturedPath = new URL(incoming.url).pathname;
				capturedHeaders = incoming.headers;
				capturedBody = await incoming.json();
				return transcriptResponse();
			},
		});
		servers.push(server);
		const wav = createDeterministicWavFixture();
		const adapter = new OpenRouterSttAdapter({
			config: config(
				{},
				{
					baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
				},
			),
		});

		const result = await adapter.transcribe(request({ audio: wav }));

		expect(result).toEqual({
			conversationId: CONVERSATION_ID,
			turnId: TURN_ID,
			text: "Запишите меня на демонстрацию завтра",
			final: true,
		});
		expect(capturedMethod).toBe("POST");
		expect(capturedPath).toBe("/api/v1/chat/completions");
		expect(capturedHeaders.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
		expect(capturedHeaders.get("Content-Type")).toContain("application/json");
		const body = capturedBody as {
			model: string;
			messages: Array<{
				content: Array<{
					type: string;
					text?: string;
					input_audio?: { data: string; format: string };
				}>;
			}>;
		};
		expect(body.model).toBe("openai/gpt-audio-mini");
		expect(body.messages[0]?.content[0]?.text).toContain("Russian speech");
		expect(body.messages[0]?.content[0]?.text).toContain("only the transcript");
		expect(body.messages[0]?.content[1]?.type).toBe("input_audio");
		expect(body.messages[0]?.content[1]?.input_audio?.format).toBe("wav");
		expect(
			Buffer.from(
				body.messages[0]?.content[1]?.input_audio?.data ?? "",
				"base64",
			),
		).toEqual(Buffer.from(wav));
	});

	test("uses the configured model without changing the port contract", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const adapter = new OpenRouterSttAdapter({
			config: config({ model: "vendor/audio-model" }),
			fetch: queuedFetch([transcriptResponse()], calls),
		});
		await adapter.transcribe(request());
		const body = JSON.parse(String(calls[0]?.init.body)) as { model: string };
		expect(body.model).toBe("vendor/audio-model");
	});

	test("telemetry contains only safe dimensions", async () => {
		const events: OpenRouterSttTelemetryEvent[] = [];
		const wav = createDeterministicWavFixture();
		const adapter = new OpenRouterSttAdapter({
			config: config(),
			fetch: queuedFetch([transcriptResponse("Иван, +79990001122")]),
			telemetry: (event) => events.push(event),
		});
		await adapter.transcribe(request({ audio: wav }));
		const snapshot = JSON.stringify(events);
		expect(snapshot).not.toContain(TEST_KEY);
		expect(snapshot).not.toContain("Иван");
		expect(snapshot).not.toContain("79990001122");
		expect(snapshot).not.toContain(Buffer.from(wav).toString("base64"));
		expect(events[0]).toMatchObject({
			model: "openai/gpt-audio-mini",
			format: "wav",
			audioBytes: wav.byteLength,
			durationMs: 100,
			status: 200,
			providerRequestId: "req_stt_1",
		});
	});
});

describe("OpenRouterSttAdapter validation and failures", () => {
	test("rejects raw PCM, malformed/incompatible WAV, mismatched metadata and bounds before fetch", async () => {
		const wav = createDeterministicWavFixture();
		const stereo = wav.slice();
		new DataView(stereo.buffer).setUint16(22, 2, true);
		const badRiffSize = wav.slice();
		new DataView(badRiffSize.buffer).setUint32(4, 1, true);
		const invalidRequests: Array<{
			value: SttTranscriptionRequest;
			stt?: Partial<OpenRouterVoiceConfig["stt"]>;
			code: OpenRouterSttErrorCode;
		}> = [
			{ value: request({ audio: wav.slice(44) }), code: "STT_INVALID_REQUEST" },
			{
				value: request({ audio: new Uint8Array([1, 2]) }),
				code: "STT_INVALID_REQUEST",
			},
			{ value: request({ audio: stereo }), code: "STT_INVALID_REQUEST" },
			{ value: request({ audio: badRiffSize }), code: "STT_INVALID_REQUEST" },
			{
				value: request({ contentType: "audio/pcm" as "audio/wav" }),
				code: "STT_INVALID_REQUEST",
			},
			{ value: request({ language: "en" }), code: "STT_INVALID_REQUEST" },
			{
				value: request({ audio: wav }),
				stt: { maxAudioBytes: wav.byteLength - 1 },
				code: "STT_AUDIO_TOO_LARGE",
			},
			{
				value: request({ audio: wav }),
				stt: { maxUtteranceMs: 99 },
				code: "STT_AUDIO_TOO_LARGE",
			},
		];
		for (const item of invalidRequests) {
			let fetches = 0;
			const adapter = new OpenRouterSttAdapter({
				config: config(item.stt),
				fetch: async () => {
					fetches += 1;
					return transcriptResponse();
				},
			});
			const error = await captureError(adapter.transcribe(item.value));
			expect(error.code).toBe(item.code);
			expect(fetches).toBe(0);
		}
	});

	test("maps required non-retryable HTTP statuses to typed safe errors", async () => {
		const cases = [
			[400, "STT_PROVIDER_BAD_REQUEST"],
			[401, "STT_PROVIDER_AUTH"],
			[402, "STT_PROVIDER_CREDITS"],
			[404, "STT_PROVIDER_MODEL_UNAVAILABLE"],
			[413, "STT_PROVIDER_REQUEST_TOO_LARGE"],
		] as const;
		for (const [status, code] of cases) {
			let fetches = 0;
			const adapter = new OpenRouterSttAdapter({
				config: config(),
				fetch: async () => {
					fetches += 1;
					return Response.json(
						{ error: { code: status, message: "sensitive provider body" } },
						{ status },
					);
				},
			});
			const error = await captureError(adapter.transcribe(request()));
			expect(error).toMatchObject({ code, status, retryable: false });
			expect(error.message).not.toContain("sensitive");
			expect(fetches).toBe(1);
		}
	});

	test("retries 429 and retryable upstream statuses only once", async () => {
		for (const status of [429, 500, 502, 503, 524, 529]) {
			const calls: Array<{ url: string; init: RequestInit }> = [];
			const first = Response.json(
				{ error: { code: status, message: "discard me" } },
				{ status, headers: { "Retry-After": "0" } },
			);
			const adapter = new OpenRouterSttAdapter({
				config: config(),
				fetch: queuedFetch([first, transcriptResponse()], calls),
			});
			await expect(adapter.transcribe(request())).resolves.toMatchObject({
				final: true,
			});
			expect(calls).toHaveLength(2);
		}
	});

	test("stops after the single configured retry", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const adapter = new OpenRouterSttAdapter({
			config: config(),
			fetch: queuedFetch(
				[
					new Response("failure one", { status: 503 }),
					new Response("failure two", { status: 503 }),
				],
				calls,
			),
		});
		const error = await captureError(adapter.transcribe(request()));
		expect(error).toMatchObject({
			code: "STT_PROVIDER_UPSTREAM",
			status: 503,
			retryable: true,
		});
		expect(calls).toHaveLength(2);
	});

	test("rejects malformed, empty and non-JSON final transcript responses", async () => {
		const responses = [
			Response.json({ choices: [{ message: { content: "   " } }] }),
			Response.json({ choices: [] }),
			Response.json({
				choices: [
					{ message: { content: "one" } },
					{ message: { content: "two" } },
				],
			}),
			new Response("not-json", {
				headers: { "Content-Type": "application/json" },
			}),
			new Response("plain", { headers: { "Content-Type": "text/plain" } }),
		];
		for (const response of responses) {
			const adapter = new OpenRouterSttAdapter({
				config: config(),
				fetch: queuedFetch([response]),
			});
			const error = await captureError(adapter.transcribe(request()));
			expect(error.code).toBe("STT_INVALID_RESPONSE");
		}
	});
});

describe("OpenRouterSttAdapter lifecycle guards", () => {
	test("enforces connect and total timeouts without retrying timeout failures", async () => {
		let connectCalls = 0;
		const connectAdapter = new OpenRouterSttAdapter({
			config: config({ connectTimeoutMs: 5, totalTimeoutMs: 50 }),
			fetch: async () => {
				connectCalls += 1;
				return new Promise<Response>(() => undefined);
			},
		});
		const connectError = await captureError(
			connectAdapter.transcribe(request()),
		);
		expect(connectError.code).toBe("STT_TIMEOUT");
		expect(connectCalls).toBe(1);

		let totalCalls = 0;
		const totalAdapter = new OpenRouterSttAdapter({
			config: config({ connectTimeoutMs: 50, totalTimeoutMs: 5 }),
			fetch: async () => {
				totalCalls += 1;
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const totalError = await captureError(totalAdapter.transcribe(request()));
		expect(totalError.code).toBe("STT_TIMEOUT");
		expect(totalCalls).toBe(1);
	});

	test("pre-abort, in-flight abort and stale turn suppress every transcript", async () => {
		const pre = new AbortController();
		pre.abort();
		let fetches = 0;
		const adapter = new OpenRouterSttAdapter({
			config: config(),
			fetch: async () => {
				fetches += 1;
				return new Promise<Response>(() => undefined);
			},
		});
		await expect(
			adapter.transcribe(request({ signal: pre.signal })),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetches).toBe(0);

		const inFlight = new AbortController();
		const pending = adapter.transcribe(request({ signal: inFlight.signal }));
		await Bun.sleep(0);
		inFlight.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });

		let current = true;
		const staleAdapter = new OpenRouterSttAdapter({
			config: config(),
			isTurnCurrent: () => current,
			fetch: async () => {
				await Bun.sleep(5);
				return transcriptResponse();
			},
		});
		const stale = staleAdapter.transcribe(request());
		current = false;
		await expect(stale).rejects.toMatchObject({ name: "AbortError" });
	});

	test("bounds obsolete-turn memory while preserving recent stale suppression", async () => {
		const adapter = new OpenRouterSttAdapter({
			config: config(),
			fetch: queuedFetch([transcriptResponse()]),
		});
		adapter.markTurnObsolete(TURN_ID);
		for (let index = 0; index < 10_000; index += 1) {
			adapter.markTurnObsolete(`obsolete-turn-${index}`);
		}
		await expect(adapter.transcribe(request())).resolves.toMatchObject({
			final: true,
		});
		adapter.markTurnObsolete(TURN_ID);
		await expect(adapter.transcribe(request())).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	test("enforces one active request per turn and configured concurrency", async () => {
		const controller = new AbortController();
		const adapter = new OpenRouterSttAdapter({
			config: config({ maxConcurrency: 1 }),
			fetch: async () => new Promise<Response>(() => undefined),
		});
		const first = adapter.transcribe(request({ signal: controller.signal }));
		await Bun.sleep(0);
		const error = await captureError(
			adapter.transcribe(request({ turnId: "01J00000000000000000000002" })),
		);
		expect(error.code).toBe("STT_CONCURRENCY_LIMIT");
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
	});

	test("opens after retryable failures and permits one successful half-open probe", async () => {
		let now = 0;
		let fetches = 0;
		const adapter = new OpenRouterSttAdapter({
			config: config({
				maxRetries: 0,
				circuitFailureThreshold: 1,
				circuitCooldownMs: 10,
			}),
			now: () => now,
			fetch: async () => {
				fetches += 1;
				return fetches === 1
					? new Response("upstream", { status: 503 })
					: transcriptResponse();
			},
		});
		await captureError(adapter.transcribe(request()));
		expect(await adapter.health()).toBe("degraded");
		const openError = await captureError(
			adapter.transcribe(request({ turnId: "01J00000000000000000000002" })),
		);
		expect(openError.code).toBe("STT_CIRCUIT_OPEN");
		expect(fetches).toBe(1);
		now = 11;
		await expect(
			adapter.transcribe(request({ turnId: "01J00000000000000000000003" })),
		).resolves.toMatchObject({ final: true });
		expect(await adapter.health()).toBe("ready");
	});

	test("readiness is unavailable without the shared key", async () => {
		const adapter = new OpenRouterSttAdapter({
			config: config({}, { apiKey: null }),
		});
		expect(await adapter.health()).toBe("unavailable");
		const error = await captureError(adapter.transcribe(request()));
		expect(error.code).toBe("STT_CONFIG_INVALID");
	});
});
