import { afterEach, describe, expect, test } from "bun:test";
import type { TtsSynthesisRequest } from "@botamin/contracts";
import {
	createDeterministicMp3Fixture,
	createMalformedMp3Fixture,
} from "../../../../../../packages/test-fixtures/src/mp3";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../stt/config";
import type { OpenRouterFetch } from "../stt/http";
import {
	OpenRouterTtsAdapter,
	type OpenRouterTtsTelemetryEvent,
} from "./adapter";
import { OpenRouterTtsError, type OpenRouterTtsErrorCode } from "./errors";

const CONVERSATION_ID = "01J00000000000000000000000";
const TURN_ID = "01J00000000000000000000001";
const GENERATION_ID = "01J00000000000000000000002";
const SEGMENT_ID = "01J00000000000000000000003";
const TEST_KEY = "openrouter-test-secret";
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function config(
	tts: Partial<OpenRouterVoiceConfig["tts"]> = {},
	root: Partial<Pick<OpenRouterVoiceConfig, "apiKey" | "baseUrl">> = {},
): OpenRouterVoiceConfig {
	const loaded = loadOpenRouterVoiceConfig({
		OPENROUTER_API_KEY: TEST_KEY,
		TTS_RETRY_BASE_MS: "0",
	});
	return { ...loaded, ...root, tts: { ...loaded.tts, ...tts } };
}

function request(
	overrides: Partial<TtsSynthesisRequest> = {},
): TtsSynthesisRequest {
	return {
		conversationId: CONVERSATION_ID,
		turnId: TURN_ID,
		generationId: GENERATION_ID,
		segmentId: SEGMENT_ID,
		text: "Здравствуйте!",
		signal: new AbortController().signal,
		...overrides,
	};
}

function mp3Response(
	bytes = createDeterministicMp3Fixture(),
	init: ResponseInit = {},
): Response {
	const headers = new Headers(init.headers);
	if (!headers.has("Content-Type")) headers.set("Content-Type", "audio/mpeg");
	if (!headers.has("x-request-id")) headers.set("x-request-id", "req_tts_1");
	return new Response(Uint8Array.from(bytes).buffer, { ...init, headers });
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

async function captureError(
	promise: Promise<unknown>,
): Promise<OpenRouterTtsError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OpenRouterTtsError);
		return error as OpenRouterTtsError;
	}
	throw new Error("Expected OpenRouterTtsError");
}

describe("OpenRouterTtsAdapter protocol", () => {
	test("posts native HTTP speech request and buffers chunked MP3 into one complete segment", async () => {
		const mp3 = createDeterministicMp3Fixture();
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
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(mp3.slice(0, 97));
							controller.enqueue(mp3.slice(97));
							controller.close();
						},
					}),
					{
						headers: {
							"Content-Type": "audio/mpeg",
							"X-Generation-Id": "gen_provider_1",
						},
					},
				);
			},
		});
		servers.push(server);
		const adapter = new OpenRouterTtsAdapter({
			config: config(
				{},
				{
					baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
				},
			),
		});

		const result = await adapter.synthesize(request());

		expect(result).toMatchObject({
			generationId: GENERATION_ID,
			segmentId: SEGMENT_ID,
			providerGenerationId: "gen_provider_1",
			contentType: "audio/mpeg",
			final: true,
		});
		expect(Array.from(result.bytes)).toEqual(Array.from(mp3));
		expect(capturedMethod).toBe("POST");
		expect(capturedPath).toBe("/api/v1/audio/speech");
		expect(capturedHeaders.get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
		expect(capturedHeaders.get("X-OpenRouter-Cache")).toBe("false");
		const body = capturedBody as Record<string, unknown>;
		expect(body).toEqual({
			model: "x-ai/grok-voice-tts-1.0",
			voice: "eve",
			input: "Здравствуйте!",
			response_format: "mp3",
		});
		expect(body.speed).toBeUndefined();
	});

	test("sends configured model, voice, format and optional speed", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const adapter = new OpenRouterTtsAdapter({
			config: config({ model: "vendor/voice", voice: "voice_1", speed: 1.1 }),
			fetch: queuedFetch([mp3Response()], calls),
		});
		await adapter.synthesize(request());
		expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
			model: "vendor/voice",
			voice: "voice_1",
			response_format: "mp3",
			speed: 1.1,
		});
	});

	test("telemetry excludes spoken text, PII, key and audio", async () => {
		const events: OpenRouterTtsTelemetryEvent[] = [];
		const mp3 = createDeterministicMp3Fixture();
		const adapter = new OpenRouterTtsAdapter({
			config: config(),
			fetch: queuedFetch([mp3Response(mp3)]),
			telemetry: (event) => events.push(event),
		});
		await adapter.synthesize(request({ text: "Иван, звоните +79990001122" }));
		const snapshot = JSON.stringify(events);
		expect(snapshot).not.toContain(TEST_KEY);
		expect(snapshot).not.toContain("Иван");
		expect(snapshot).not.toContain("79990001122");
		expect(snapshot).not.toContain(Buffer.from(mp3).toString("base64"));
		expect(events[0]).toMatchObject({
			model: "x-ai/grok-voice-tts-1.0",
			voice: "eve",
			format: "mp3",
			status: 200,
			bytes: mp3.byteLength,
			providerRequestId: "req_tts_1",
		});
	});
});

describe("OpenRouterTtsAdapter response and HTTP failures", () => {
	test("rejects wrong content type, empty, malformed and oversized MP3", async () => {
		const valid = createDeterministicMp3Fixture();
		const trailingGarbage = new Uint8Array(valid.byteLength + 1);
		trailingGarbage.set(valid);
		trailingGarbage[trailingGarbage.byteLength - 1] = 1;
		const truncated = valid.slice(0, valid.byteLength - 1);
		const cases: Array<{
			response: Response;
			config?: Partial<OpenRouterVoiceConfig["tts"]>;
			code: OpenRouterTtsErrorCode;
		}> = [
			{
				response: new Response(Uint8Array.from(valid).buffer, {
					headers: { "Content-Type": "audio/wav" },
				}),
				code: "TTS_INVALID_RESPONSE",
			},
			{ response: mp3Response(new Uint8Array()), code: "TTS_INVALID_RESPONSE" },
			{
				response: mp3Response(createMalformedMp3Fixture()),
				code: "TTS_INVALID_RESPONSE",
			},
			{ response: mp3Response(trailingGarbage), code: "TTS_INVALID_RESPONSE" },
			{ response: mp3Response(truncated), code: "TTS_INVALID_RESPONSE" },
			{
				response: mp3Response(valid),
				config: { maxResponseBytes: valid.byteLength - 1 },
				code: "TTS_RESPONSE_TOO_LARGE",
			},
		];
		for (const item of cases) {
			const adapter = new OpenRouterTtsAdapter({
				config: config(item.config),
				fetch: queuedFetch([item.response]),
			});
			const error = await captureError(adapter.synthesize(request()));
			expect(error.code).toBe(item.code);
			expect(error.degradeToText).toBe(true);
		}
	});

	test("maps non-retryable provider statuses and never forwards provider bodies as audio", async () => {
		const cases = [
			[400, "TTS_PROVIDER_BAD_REQUEST"],
			[401, "TTS_PROVIDER_AUTH"],
			[402, "TTS_PROVIDER_CREDITS"],
			[403, "TTS_PROVIDER_FORBIDDEN"],
			[404, "TTS_PROVIDER_MODEL_UNAVAILABLE"],
			[413, "TTS_PROVIDER_REQUEST_TOO_LARGE"],
		] as const;
		for (const [status, code] of cases) {
			let fetches = 0;
			const adapter = new OpenRouterTtsAdapter({
				config: config(),
				fetch: async () => {
					fetches += 1;
					return Response.json(
						{ error: { code: status, message: "spoken/provider secret" } },
						{ status },
					);
				},
			});
			const error = await captureError(adapter.synthesize(request()));
			expect(error).toMatchObject({ code, status, retryable: false });
			expect(error.message).not.toContain("spoken");
			expect(fetches).toBe(1);
		}
	});

	test("retries 429 and retryable 5xx once, honoring a bounded Retry-After", async () => {
		for (const status of [429, 500, 502, 503, 524, 529]) {
			const calls: Array<{ url: string; init: RequestInit }> = [];
			const adapter = new OpenRouterTtsAdapter({
				config: config({ maxRetryAfterMs: 1 }),
				fetch: queuedFetch(
					[
						new Response("discard provider error", {
							status,
							headers: { "Retry-After": "999999" },
						}),
						mp3Response(),
					],
					calls,
				),
			});
			await expect(adapter.synthesize(request())).resolves.toMatchObject({
				final: true,
			});
			expect(calls).toHaveLength(2);
		}
	});

	test("never performs more than the one configured retry", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const adapter = new OpenRouterTtsAdapter({
			config: config(),
			fetch: queuedFetch(
				[
					new Response("one", { status: 502 }),
					new Response("two", { status: 503 }),
				],
				calls,
			),
		});
		const error = await captureError(adapter.synthesize(request()));
		expect(error).toMatchObject({
			code: "TTS_PROVIDER_UPSTREAM",
			status: 503,
			retryable: true,
		});
		expect(calls).toHaveLength(2);
	});
});

describe("OpenRouterTtsAdapter lifecycle, budgets and readiness", () => {
	test("enforces connect/total timeout and does not retry timeout failures", async () => {
		let connectCalls = 0;
		const connectAdapter = new OpenRouterTtsAdapter({
			config: config({ connectTimeoutMs: 5, totalTimeoutMs: 50 }),
			fetch: async () => {
				connectCalls += 1;
				return new Promise<Response>(() => undefined);
			},
		});
		const connectError = await captureError(
			connectAdapter.synthesize(request()),
		);
		expect(connectError.code).toBe("TTS_TIMEOUT");
		expect(connectCalls).toBe(1);

		let totalCalls = 0;
		const totalAdapter = new OpenRouterTtsAdapter({
			config: config({ connectTimeoutMs: 50, totalTimeoutMs: 5 }),
			fetch: async () => {
				totalCalls += 1;
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "audio/mpeg" },
				});
			},
		});
		const totalError = await captureError(totalAdapter.synthesize(request()));
		expect(totalError.code).toBe("TTS_TIMEOUT");
		expect(totalCalls).toBe(1);
	});

	test("abort and stale generation reject late complete audio", async () => {
		const controller = new AbortController();
		const adapter = new OpenRouterTtsAdapter({
			config: config(),
			fetch: async () => new Promise<Response>(() => undefined),
		});
		const pending = adapter.synthesize(request({ signal: controller.signal }));
		await Bun.sleep(0);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });

		let current = true;
		const staleAdapter = new OpenRouterTtsAdapter({
			config: config(),
			isGenerationCurrent: () => current,
			fetch: async () => {
				await Bun.sleep(5);
				return mp3Response();
			},
		});
		const stale = staleAdapter.synthesize(request());
		current = false;
		await expect(stale).rejects.toMatchObject({ name: "AbortError" });
	});

	test("enforces per-segment, turn and session character budgets before provider calls", async () => {
		let fetches = 0;
		const adapter = new OpenRouterTtsAdapter({
			config: config({
				maxCharsPerSegment: 6,
				maxCharsPerTurn: 8,
				maxCharsPerSession: 10,
			}),
			fetch: async () => {
				fetches += 1;
				return mp3Response();
			},
		});
		await captureError(adapter.synthesize(request({ text: "1234567" })));
		expect(fetches).toBe(0);
		await adapter.synthesize(request({ text: "12345" }));
		const turnBudget = await captureError(
			adapter.synthesize(
				request({
					segmentId: "01J00000000000000000000004",
					text: "6789",
				}),
			),
		);
		expect(turnBudget.code).toBe("TTS_BUDGET_EXCEEDED");
		await adapter.synthesize(
			request({
				turnId: "01J00000000000000000000005",
				segmentId: "01J00000000000000000000006",
				text: "67890",
			}),
		);
		const sessionBudget = await captureError(
			adapter.synthesize(
				request({
					turnId: "01J00000000000000000000007",
					segmentId: "01J00000000000000000000008",
					text: "1",
				}),
			),
		);
		expect(sessionBudget.code).toBe("TTS_BUDGET_EXCEEDED");
		expect(adapter.usage(CONVERSATION_ID, TURN_ID)).toEqual({
			sessionCharacters: 10,
			turnCharacters: 5,
		});
	});

	test("bounds obsolete-generation memory while preserving recent stale suppression", async () => {
		const adapter = new OpenRouterTtsAdapter({
			config: config(),
			fetch: queuedFetch([mp3Response()]),
		});
		adapter.markGenerationObsolete(GENERATION_ID);
		for (let index = 0; index < 10_000; index += 1) {
			adapter.markGenerationObsolete(`obsolete-generation-${index}`);
		}
		await expect(adapter.synthesize(request())).resolves.toMatchObject({
			final: true,
		});
		adapter.markGenerationObsolete(GENERATION_ID);
		await expect(adapter.synthesize(request())).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	test("enforces concurrency without launching a second synthesis", async () => {
		const controller = new AbortController();
		let fetches = 0;
		const adapter = new OpenRouterTtsAdapter({
			config: config({ maxConcurrency: 1 }),
			fetch: async () => {
				fetches += 1;
				return new Promise<Response>(() => undefined);
			},
		});
		const first = adapter.synthesize(request({ signal: controller.signal }));
		await Bun.sleep(0);
		const error = await captureError(
			adapter.synthesize(
				request({
					generationId: "01J00000000000000000000009",
					segmentId: "01J0000000000000000000000A",
				}),
			),
		);
		expect(error.code).toBe("TTS_CONCURRENCY_LIMIT");
		expect(fetches).toBe(1);
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
	});

	test("opens, degrades to text-only, half-opens after cooldown and closes on success", async () => {
		let now = 0;
		let fetches = 0;
		const adapter = new OpenRouterTtsAdapter({
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
					: mp3Response();
			},
		});
		await captureError(adapter.synthesize(request()));
		expect(await adapter.health()).toBe("degraded");
		const open = await captureError(
			adapter.synthesize(
				request({
					generationId: "01J00000000000000000000009",
					segmentId: "01J0000000000000000000000A",
				}),
			),
		);
		expect(open).toMatchObject({
			code: "TTS_CIRCUIT_OPEN",
			degradeToText: true,
		});
		expect(fetches).toBe(1);
		now = 11;
		await adapter.synthesize(
			request({
				generationId: "01J0000000000000000000000B",
				segmentId: "01J0000000000000000000000C",
			}),
		);
		expect(await adapter.health()).toBe("ready");
	});

	test("401/402/404 immediately open degraded mode and missing key is unavailable", async () => {
		for (const status of [401, 402, 404]) {
			const adapter = new OpenRouterTtsAdapter({
				config: config({ maxRetries: 0 }),
				fetch: async () => new Response("provider error", { status }),
			});
			await captureError(adapter.synthesize(request()));
			expect(await adapter.health()).toBe("degraded");
		}
		const missing = new OpenRouterTtsAdapter({
			config: config({}, { apiKey: null }),
		});
		expect(await missing.health()).toBe("unavailable");
		const error = await captureError(missing.synthesize(request()));
		expect(error).toMatchObject({
			code: "TTS_CONFIG_INVALID",
			degradeToText: true,
		});
	});
});
