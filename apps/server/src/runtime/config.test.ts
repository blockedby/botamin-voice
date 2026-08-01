import { describe, expect, test } from "bun:test";
import { createRuntimeConfig, RuntimeConfigError } from "./config";

const validEnv = {
	APP_ORIGIN: "http://localhost:5173",
	BRAIN_PROVIDER: "codex-subscription",
	CODEX_MODEL: "gpt-5.6-luna",
	CODEX_EFFORT: "low",
	CODEX_HOME: "/tmp/botamin-test-codex-home",
	CODEX_CWD: "/tmp/botamin-test-brain",
	CODEX_TOOL_MODE: "envelope",
	CODEX_MAX_CONCURRENT_TURNS: "3",
	MAX_ACTIVE_CONVERSATIONS: "3",
	MAX_CONCURRENT_BRAIN_TURNS: "3",
	STT_PROVIDER: "openrouter",
	TTS_PROVIDER: "openrouter",
	OPENROUTER_API_KEY: "test-placeholder-not-a-secret",
	OPENROUTER_STT_AUDIO_FORMAT: "wav",
	OPENROUTER_STT_LANGUAGE: "ru",
	OPENROUTER_TTS_RESPONSE_FORMAT: "mp3",
	STT_TEXT_ONLY_INPUT_FALLBACK: "false",
	STORE_RAW_AUDIO: "false",
};

describe("validated runtime configuration", () => {
	test("builds one shared OpenRouter voice profile and safe Codex envelope mode", () => {
		const config = createRuntimeConfig(validEnv);
		expect(config.voice.apiKey).toBe(validEnv.OPENROUTER_API_KEY);
		expect(config.brain).toMatchObject({
			provider: "codex-subscription",
			model: "gpt-5.6-luna",
			toolMode: "envelope",
		});
		expect(config.voice.stt).toMatchObject({
			audioFormat: "wav",
			maxUtteranceMs: 60_000,
			maxAudioBytes: 2_000_000,
		});
		expect(config.voice.tts.responseFormat).toBe("mp3");
		expect(config.transcriptRetentionDays).toBe(30);
		expect(config.maxPendingBrainTurns).toBe(6);
		expect(config.admission.trustedProxyHops).toBe(0);
		expect(config.notifier).toEqual({ kind: "console" });
	});

	test("rejects dynamic tools because production has no injected awaited executor", () => {
		expect(() =>
			createRuntimeConfig({ ...validEnv, CODEX_TOOL_MODE: "dynamic" }),
		).toThrow(RuntimeConfigError);
	});

	test("parses bounded retention, queue, proxy admission, and webhook wiring", () => {
		const config = createRuntimeConfig({
			...validEnv,
			TRANSCRIPT_RETENTION_DAYS: "45",
			MAX_PENDING_BRAIN_TURNS: "1",
			TRUSTED_PROXY_HOPS: "1",
			NOTIFIER: "webhook",
			WEBHOOK_URL: "https://receiver.invalid/leads",
			WEBHOOK_SIGNING_SECRET: "test-signing-material-0000000000",
			WEBHOOK_TIMEOUT_MS: "1200",
		});
		expect(config.transcriptRetentionDays).toBe(45);
		expect(config.maxPendingBrainTurns).toBe(1);
		expect(config.admission.trustedProxyHops).toBe(1);
		expect(config.notifier).toMatchObject({
			kind: "webhook",
			url: "https://receiver.invalid/leads",
			timeoutMs: 1_200,
		});
	});

	test("rejects impossible WAV, retention, queue, proxy, and notifier relations", () => {
		for (const env of [
			{ ...validEnv, STT_MAX_AUDIO_BYTES: "44" },
			{ ...validEnv, STT_MAX_AUDIO_BYTES: "3243" },
			{ ...validEnv, TRANSCRIPT_RETENTION_DAYS: "0" },
			{ ...validEnv, TRANSCRIPT_RETENTION_DAYS: "3651" },
			{ ...validEnv, MAX_PENDING_BRAIN_TURNS: "257" },
			{ ...validEnv, TRUSTED_PROXY_HOPS: "4" },
			{
				...validEnv,
				MAX_ACTIVE_CONVERSATIONS_PER_SOURCE: "4",
			},
			{ ...validEnv, NOTIFIER: "webhook" },
			{ ...validEnv, NOTIFIER: "ordinary-log" },
		]) {
			expect(() => createRuntimeConfig(env)).toThrow();
		}
	});

	test("rejects alternate providers, raw-audio storage, and mismatched capacity", () => {
		for (const env of [
			{ ...validEnv, STT_PROVIDER: "other" },
			{ ...validEnv, TTS_PROVIDER: "other" },
			{ ...validEnv, STORE_RAW_AUDIO: "true" },
			{
				...validEnv,
				MAX_ACTIVE_CONVERSATIONS: "2",
				MAX_CONCURRENT_BRAIN_TURNS: "3",
			},
		]) {
			expect(() => createRuntimeConfig(env)).toThrow(RuntimeConfigError);
		}
	});
});
