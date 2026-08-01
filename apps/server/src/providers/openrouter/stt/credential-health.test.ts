import { describe, expect, test } from "bun:test";
import type {
	SttTranscriptionRequest,
	TtsSynthesisRequest,
} from "@botamin/contracts";
import { createDeterministicMp3Fixture } from "../../../../../../packages/test-fixtures/src/mp3";
import { createDeterministicWavFixture } from "../../../../../../packages/test-fixtures/src/wav";
import { OpenRouterTtsAdapter } from "../tts/adapter";
import { OpenRouterSttAdapter } from "./adapter";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "./config";
import { OpenRouterCredentialHealth } from "./credential-health";

const CONVERSATION_ID = "01J00000000000000000000000";
const TURN_ID = "01J00000000000000000000001";
const GENERATION_ID = "01J00000000000000000000002";
const SEGMENT_ID = "01J00000000000000000000003";

function config(): OpenRouterVoiceConfig {
	const loaded = loadOpenRouterVoiceConfig({
		OPENROUTER_API_KEY: "isolated-openrouter-test-key",
		STT_MAX_RETRIES: "0",
		TTS_MAX_RETRIES: "0",
		STT_RETRY_BASE_MS: "0",
		TTS_RETRY_BASE_MS: "0",
	});
	return {
		...loaded,
		stt: {
			...loaded.stt,
			circuitFailureThreshold: 1,
		},
		tts: {
			...loaded.tts,
			circuitFailureThreshold: 1,
		},
	};
}

function sttRequest(): SttTranscriptionRequest {
	return {
		conversationId: CONVERSATION_ID,
		turnId: TURN_ID,
		audio: createDeterministicWavFixture(),
		contentType: "audio/wav",
		language: "ru",
		signal: new AbortController().signal,
	};
}

function ttsRequest(): TtsSynthesisRequest {
	return {
		conversationId: CONVERSATION_ID,
		turnId: TURN_ID,
		generationId: GENERATION_ID,
		segmentId: SEGMENT_ID,
		text: "Здравствуйте!",
		signal: new AbortController().signal,
	};
}

function transcriptResponse(): Response {
	return Response.json({
		id: "gen_health_stt",
		object: "chat.completion",
		created: 1_722_000_000,
		model: "openai/gpt-audio-mini",
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				native_finish_reason: "stop",
				message: { role: "assistant", content: "Добрый день" },
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
	});
}

function mp3Response(): Response {
	const bytes = createDeterministicMp3Fixture();
	return new Response(Uint8Array.from(bytes).buffer, {
		headers: { "Content-Type": "audio/mpeg" },
	});
}

describe("shared OpenRouter credential health", () => {
	test("STT 401/402 force-open its local circuit and degrade shared TTS health", async () => {
		for (const status of [401, 402] as const) {
			const sharedConfig = config();
			let sttFetches = 0;
			const stt = new OpenRouterSttAdapter({
				config: sharedConfig,
				monotonicNow: () => 0,
				fetch: async () => {
					sttFetches += 1;
					return new Response("provider error", { status });
				},
			});
			const tts = new OpenRouterTtsAdapter({
				config: sharedConfig,
				monotonicNow: () => 0,
				fetch: async () => mp3Response(),
			});

			await expect(stt.transcribe(sttRequest())).rejects.toMatchObject({
				status,
			});
			expect(sttFetches).toBe(1);
			expect(await stt.health()).toBe("degraded");
			expect(await tts.health()).toBe("degraded");

			await expect(stt.transcribe(sttRequest())).rejects.toMatchObject({
				code: "STT_CIRCUIT_OPEN",
			});
			expect(sttFetches).toBe(1);

			await expect(tts.synthesize(ttsRequest())).resolves.toMatchObject({
				final: true,
			});
			expect(await tts.health()).toBe("ready");
			expect(await stt.health()).toBe("degraded");
		}
	});

	test("TTS 401/402 force-open its local circuit and degrade shared STT health", async () => {
		for (const status of [401, 402] as const) {
			const credentialHealth = new OpenRouterCredentialHealth();
			let ttsFetches = 0;
			const stt = new OpenRouterSttAdapter({
				config: config(),
				credentialHealth,
				monotonicNow: () => 0,
				fetch: async () => transcriptResponse(),
			});
			const tts = new OpenRouterTtsAdapter({
				config: config(),
				credentialHealth,
				monotonicNow: () => 0,
				fetch: async () => {
					ttsFetches += 1;
					return new Response("provider error", { status });
				},
			});

			await expect(tts.synthesize(ttsRequest())).rejects.toMatchObject({
				status,
			});
			expect(ttsFetches).toBe(1);
			expect(await stt.health()).toBe("degraded");
			expect(await tts.health()).toBe("degraded");

			await expect(tts.synthesize(ttsRequest())).rejects.toMatchObject({
				code: "TTS_CIRCUIT_OPEN",
			});
			expect(ttsFetches).toBe(1);

			await expect(stt.transcribe(sttRequest())).resolves.toMatchObject({
				final: true,
			});
			expect(await stt.health()).toBe("ready");
			expect(await tts.health()).toBe("degraded");
		}
	});

	test("404 and 5xx circuits remain path-local", async () => {
		const stt404Health = new OpenRouterCredentialHealth();
		const stt404 = new OpenRouterSttAdapter({
			config: config(),
			credentialHealth: stt404Health,
			fetch: async () => new Response("model missing", { status: 404 }),
		});
		const unaffectedTts = new OpenRouterTtsAdapter({
			config: config(),
			credentialHealth: stt404Health,
			fetch: async () => mp3Response(),
		});
		await expect(stt404.transcribe(sttRequest())).rejects.toMatchObject({
			status: 404,
		});
		expect(await stt404.health()).toBe("degraded");
		expect(await unaffectedTts.health()).toBe("ready");

		const tts503Health = new OpenRouterCredentialHealth();
		const unaffectedStt = new OpenRouterSttAdapter({
			config: config(),
			credentialHealth: tts503Health,
			fetch: async () => transcriptResponse(),
		});
		const tts503 = new OpenRouterTtsAdapter({
			config: config(),
			credentialHealth: tts503Health,
			fetch: async () => new Response("upstream", { status: 503 }),
		});
		await expect(tts503.synthesize(ttsRequest())).rejects.toMatchObject({
			status: 503,
		});
		expect(await unaffectedStt.health()).toBe("ready");
		expect(await tts503.health()).toBe("degraded");
	});

	test("credential state is scoped and cannot leak between runtime configs or tests", async () => {
		const failedRuntime = new OpenRouterSttAdapter({
			config: config(),
			fetch: async () => new Response("provider error", { status: 401 }),
		});
		const separateRuntime = new OpenRouterTtsAdapter({
			config: config(),
			fetch: async () => mp3Response(),
		});
		await expect(failedRuntime.transcribe(sttRequest())).rejects.toMatchObject({
			status: 401,
		});
		expect(await failedRuntime.health()).toBe("degraded");
		expect(await separateRuntime.health()).toBe("ready");
	});
});
