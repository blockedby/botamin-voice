import { describe, expect, test } from "bun:test";
import { OpenRouterSttAdapter } from "../../apps/server/src/providers/openrouter/stt/adapter";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterSttError } from "../../apps/server/src/providers/openrouter/stt/errors";
import { OpenRouterTtsAdapter } from "../../apps/server/src/providers/openrouter/tts/adapter";
import { OpenRouterTtsError } from "../../apps/server/src/providers/openrouter/tts/errors";
import type {
	SttTranscriptionRequest,
	TtsSynthesisRequest,
} from "../../packages/contracts/src";
import {
	createDeterministicWavFixture,
	createOpenRouterFixture,
} from "../../packages/test-fixtures/src";
import type {
	OpenRouterFixtureBehavior,
	OpenRouterFixtureStatus,
} from "../../packages/test-fixtures/src/openrouter";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000001";
const generationId = "01J00000000000000000000002";
const segmentId = "01J00000000000000000000003";
const key = "t22-provider-harness-key";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function config(
	overrides: {
		stt?: Partial<OpenRouterVoiceConfig["stt"]>;
		tts?: Partial<OpenRouterVoiceConfig["tts"]>;
	} = {},
): OpenRouterVoiceConfig {
	const loaded = loadOpenRouterVoiceConfig({
		OPENROUTER_API_KEY: key,
		STT_RETRY_BASE_MS: "0",
		TTS_RETRY_BASE_MS: "0",
	});
	return {
		...loaded,
		baseUrl: "http://fixture/api/v1",
		stt: { ...loaded.stt, ...overrides.stt },
		tts: { ...loaded.tts, ...overrides.tts },
	};
}

function sttRequest(
	signal = new AbortController().signal,
): SttTranscriptionRequest {
	return {
		conversationId,
		turnId,
		audio: createDeterministicWavFixture(),
		contentType: "audio/wav",
		language: "ru",
		signal,
	};
}

function ttsRequest(
	signal = new AbortController().signal,
): TtsSynthesisRequest {
	return {
		conversationId,
		turnId,
		generationId,
		segmentId,
		text: "Безопасная тестовая фраза",
		signal,
	};
}

async function sttError(
	status: OpenRouterFixtureStatus,
): Promise<{ error: OpenRouterSttError; calls: number }> {
	const fixture = createOpenRouterFixture({
		expectedApiKey: key,
		chatBehaviors: [
			{
				status,
				jsonBody: { error: { message: "private STT provider body" } },
			},
		],
	});
	const adapter = new OpenRouterSttAdapter({
		config: config({ stt: { maxRetries: 0 } }),
		fetch: fixture.fetch,
	});
	try {
		await adapter.transcribe(sttRequest());
	} catch (error) {
		expect(error).toBeInstanceOf(OpenRouterSttError);
		return { error: error as OpenRouterSttError, calls: fixture.counters.chat };
	}
	throw new Error("Expected STT failure");
}

async function ttsError(
	status: OpenRouterFixtureStatus,
): Promise<{ error: OpenRouterTtsError; calls: number }> {
	const fixture = createOpenRouterFixture({
		expectedApiKey: key,
		ttsBehaviors: [
			{
				status,
				jsonBody: { error: { message: "private TTS provider body" } },
			},
		],
	});
	const adapter = new OpenRouterTtsAdapter({
		config: config({ tts: { maxRetries: 0 } }),
		fetch: fixture.fetch,
	});
	try {
		await adapter.synthesize(ttsRequest());
	} catch (error) {
		expect(error).toBeInstanceOf(OpenRouterTtsError);
		return { error: error as OpenRouterTtsError, calls: fixture.counters.tts };
	}
	throw new Error("Expected TTS failure");
}

describe("reusable fake OpenRouter error matrix", () => {
	test("maps every required STT HTTP status without leaking bodies", async () => {
		const cases = [
			[400, "STT_PROVIDER_BAD_REQUEST", false],
			[401, "STT_PROVIDER_AUTH", false],
			[402, "STT_PROVIDER_CREDITS", false],
			[404, "STT_PROVIDER_MODEL_UNAVAILABLE", false],
			[413, "STT_PROVIDER_REQUEST_TOO_LARGE", false],
			[429, "STT_PROVIDER_RATE_LIMITED", true],
			[500, "STT_PROVIDER_UPSTREAM", true],
			[502, "STT_PROVIDER_UPSTREAM", true],
			[503, "STT_PROVIDER_UPSTREAM", true],
			[524, "STT_PROVIDER_UPSTREAM", true],
			[529, "STT_PROVIDER_UPSTREAM", true],
		] as const;
		for (const [status, code, retryable] of cases) {
			const result = await sttError(status);
			expect(result.calls).toBe(1);
			expect(result.error).toMatchObject({ status, code, retryable });
			expect(result.error.message).not.toContain("private");
		}
	});

	test("rejects a schema-invalid final ChatResult as no transcript", async () => {
		const fixture = createOpenRouterFixture({
			chatBehaviors: [
				{
					jsonBody: {
						id: "chatcmpl-malformed",
						object: "chat.completion",
						created: 1,
						model: "openai/gpt-audio-mini",
						choices: [
							{
								index: 0,
								finish_reason: "stop",
								message: { role: "assistant", content: " " },
							},
						],
					},
				},
			],
		});
		const adapter = new OpenRouterSttAdapter({
			config: config(),
			fetch: fixture.fetch,
		});
		await expect(adapter.transcribe(sttRequest())).rejects.toMatchObject({
			code: "STT_INVALID_RESPONSE",
		});
		expect(fixture.counters.chat).toBe(1);
	});

	test("maps every required TTS HTTP status and marks text degradation", async () => {
		const cases = [
			[400, "TTS_PROVIDER_BAD_REQUEST", false],
			[401, "TTS_PROVIDER_AUTH", false],
			[402, "TTS_PROVIDER_CREDITS", false],
			[403, "TTS_PROVIDER_FORBIDDEN", false],
			[404, "TTS_PROVIDER_MODEL_UNAVAILABLE", false],
			[413, "TTS_PROVIDER_REQUEST_TOO_LARGE", false],
			[429, "TTS_PROVIDER_RATE_LIMITED", true],
			[500, "TTS_PROVIDER_UPSTREAM", true],
			[502, "TTS_PROVIDER_UPSTREAM", true],
			[503, "TTS_PROVIDER_UPSTREAM", true],
			[524, "TTS_PROVIDER_UPSTREAM", true],
			[529, "TTS_PROVIDER_UPSTREAM", true],
		] as const;
		for (const [status, code, retryable] of cases) {
			const result = await ttsError(status);
			expect(result.calls).toBe(1);
			expect(result.error).toMatchObject({
				status,
				code,
				retryable,
				degradeToText: true,
			});
			expect(result.error.message).not.toContain("private");
		}
	});

	for (const endpoint of ["stt", "tts"] as const) {
		for (const [name, behavior] of [
			["empty", { emptyBody: true }],
			["wrong content", { wrongContentType: true }],
			["malformed", { malformedBody: true }],
		] satisfies ReadonlyArray<readonly [string, OpenRouterFixtureBehavior]>) {
			test(`${endpoint} rejects ${name} success responses`, async () => {
				const fixture = createOpenRouterFixture({
					expectedApiKey: key,
					...(endpoint === "stt"
						? { chatBehaviors: [behavior] }
						: { ttsBehaviors: [behavior] }),
				});
				if (endpoint === "stt") {
					const adapter = new OpenRouterSttAdapter({
						config: config(),
						fetch: fixture.fetch,
					});
					await expect(adapter.transcribe(sttRequest())).rejects.toMatchObject({
						code: "STT_INVALID_RESPONSE",
					});
					expect(fixture.counters.chat).toBe(1);
				} else {
					const adapter = new OpenRouterTtsAdapter({
						config: config(),
						fetch: fixture.fetch,
					});
					await expect(adapter.synthesize(ttsRequest())).rejects.toMatchObject({
						code: "TTS_INVALID_RESPONSE",
					});
					expect(fixture.counters.tts).toBe(1);
				}
			});
		}
	}
});

describe("deterministic retry, timeout, abort, stale and circuit behavior", () => {
	test("honors only bounded Retry-After and performs exactly one retry", async () => {
		for (const endpoint of ["stt", "tts"] as const) {
			const fixture = createOpenRouterFixture({
				expectedApiKey: key,
				...(endpoint === "stt"
					? {
							chatBehaviors: [{ status: 429, retryAfter: "999999" }, {}],
						}
					: {
							ttsBehaviors: [{ status: 503, retryAfter: "999999" }, {}],
						}),
			});
			const bounded = config({
				stt: { maxRetryAfterMs: 1 },
				tts: { maxRetryAfterMs: 1 },
			});
			if (endpoint === "stt") {
				await new OpenRouterSttAdapter({
					config: bounded,
					fetch: fixture.fetch,
				}).transcribe(sttRequest());
				expect(fixture.counters.chat).toBe(2);
			} else {
				await new OpenRouterTtsAdapter({
					config: bounded,
					fetch: fixture.fetch,
				}).synthesize(ttsRequest());
				expect(fixture.counters.tts).toBe(2);
			}
		}
	});

	test("connect timeouts are typed and never retried", async () => {
		const sttFixture = createOpenRouterFixture({
			chatBehaviors: [{ timeout: true }],
		});
		const stt = new OpenRouterSttAdapter({
			config: config({ stt: { connectTimeoutMs: 5, totalTimeoutMs: 20 } }),
			fetch: sttFixture.fetch,
		});
		await expect(stt.transcribe(sttRequest())).rejects.toMatchObject({
			code: "STT_TIMEOUT",
		});
		expect(sttFixture.counters.chat).toBe(1);

		const ttsFixture = createOpenRouterFixture({
			ttsBehaviors: [{ timeout: true }],
		});
		const tts = new OpenRouterTtsAdapter({
			config: config({ tts: { connectTimeoutMs: 5, totalTimeoutMs: 20 } }),
			fetch: ttsFixture.fetch,
		});
		await expect(tts.synthesize(ttsRequest())).rejects.toMatchObject({
			code: "TTS_TIMEOUT",
		});
		expect(ttsFixture.counters.tts).toBe(1);
	});

	test("user abort stops one in-flight STT request before retry", async () => {
		const started = deferred();
		const release = deferred();
		const fixture = createOpenRouterFixture({
			chatBehaviors: [{ waitFor: release.promise }],
			onRequest: () => started.resolve(),
		});
		const controller = new AbortController();
		const adapter = new OpenRouterSttAdapter({
			config: config(),
			fetch: fixture.fetch,
		});
		const pending = adapter.transcribe(sttRequest(controller.signal));
		await started.promise;
		controller.abort();
		release.resolve();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.counters.chat).toBe(1);
	});

	test("late STT turn and TTS generation are stale even after valid provider completion", async () => {
		let currentTurn = true;
		const sttStarted = deferred();
		const releaseStt = deferred();
		const sttFixture = createOpenRouterFixture({
			chatBehaviors: [{ waitFor: releaseStt.promise }],
			onRequest: () => sttStarted.resolve(),
		});
		const stt = new OpenRouterSttAdapter({
			config: config(),
			fetch: sttFixture.fetch,
			isTurnCurrent: () => currentTurn,
		});
		const staleTranscript = stt.transcribe(sttRequest());
		await sttStarted.promise;
		currentTurn = false;
		releaseStt.resolve();
		await expect(staleTranscript).rejects.toMatchObject({ name: "AbortError" });

		let currentGeneration = true;
		const ttsStarted = deferred();
		const releaseTts = deferred();
		const ttsFixture = createOpenRouterFixture({
			ttsBehaviors: [{ waitFor: releaseTts.promise }],
			onRequest: () => ttsStarted.resolve(),
		});
		const tts = new OpenRouterTtsAdapter({
			config: config(),
			fetch: ttsFixture.fetch,
			isGenerationCurrent: () => currentGeneration,
		});
		const staleAudio = tts.synthesize(ttsRequest());
		await ttsStarted.promise;
		currentGeneration = false;
		releaseTts.resolve();
		await expect(staleAudio).rejects.toMatchObject({ name: "AbortError" });
		expect(sttFixture.counters.chat).toBe(1);
		expect(ttsFixture.counters.tts).toBe(1);
	});

	test("TTS circuit opens, blocks traffic, half-opens once and closes on success", async () => {
		let now = 0;
		const fixture = createOpenRouterFixture({
			ttsBehaviors: [{ status: 503 }, {}],
		});
		const adapter = new OpenRouterTtsAdapter({
			config: config({
				tts: {
					maxRetries: 0,
					circuitFailureThreshold: 1,
					circuitCooldownMs: 10,
				},
			}),
			fetch: fixture.fetch,
			now: () => now,
		});
		await expect(adapter.synthesize(ttsRequest())).rejects.toMatchObject({
			code: "TTS_PROVIDER_UPSTREAM",
		});
		await expect(
			adapter.synthesize({
				...ttsRequest(),
				generationId: "01J00000000000000000000004",
				segmentId: "01J00000000000000000000005",
			}),
		).rejects.toMatchObject({ code: "TTS_CIRCUIT_OPEN" });
		expect(fixture.counters.tts).toBe(1);
		now = 11;
		await expect(
			adapter.synthesize({
				...ttsRequest(),
				generationId: "01J00000000000000000000006",
				segmentId: "01J00000000000000000000007",
			}),
		).resolves.toMatchObject({ final: true, contentType: "audio/mpeg" });
		expect(fixture.counters.tts).toBe(2);
		expect(await adapter.health()).toBe("ready");
	});
});
