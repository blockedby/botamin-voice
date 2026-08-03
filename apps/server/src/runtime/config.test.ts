import { describe, expect, test } from "bun:test";
import { createRuntimeConfig, RuntimeConfigError } from "./config";

const validEnv = {
	APP_ORIGIN: "http://localhost:5173",
	BRAIN_PROVIDER: "codex-subscription",
	CODEX_MODEL: "gpt-5.6-luna",
	CODEX_EFFORT: "low",
	CODEX_SERVICE_TIER: "",
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
			effort: "low",
			toolMode: "envelope",
		});
		expect(config.brain.serviceTier).toBeUndefined();
		expect(config.voice.stt).toMatchObject({
			audioFormat: "wav",
			maxUtteranceMs: 60_000,
			maxAudioBytes: 2_000_000,
		});
		expect(config.voice.tts.responseFormat).toBe("mp3");
		expect(config.voice.tts.outputContentType).toBe("audio/mpeg");
		expect(config.transcriptRetentionDays).toBe(30);
		expect(config.orphanRecovery).toEqual({
			batchSize: 25,
			maxPerSweep: 100,
			intervalMs: 60_000,
		});
		expect(config.maxPendingBrainTurns).toBe(6);
		expect(config.admission.trustedProxyHops).toBe(0);
		expect(config.notifier).toEqual({ kind: "console" });
	});

	test("admits only the complete opt-in Gemini readiness profile", () => {
		const geminiEnv = {
			...validEnv,
			OPENROUTER_TTS_PROFILE: "gemini_3_1_pcm",
			OPENROUTER_TTS_MODEL: "google/gemini-3.1-flash-tts-preview",
			OPENROUTER_TTS_VOICE: "Kore",
			OPENROUTER_TTS_RESPONSE_FORMAT: "pcm",
		};
		expect(createRuntimeConfig(geminiEnv).voice.tts).toMatchObject({
			profile: "gemini_3_1_pcm",
			outputContentType: "audio/wav",
			model: "google/gemini-3.1-flash-tts-preview",
			voice: "Kore",
			responseFormat: "pcm",
		});
		expect(() =>
			createRuntimeConfig({ ...geminiEnv, OPENROUTER_TTS_VOICE: "kore" }),
		).toThrow();
	});

	test("defaults missing reasoning effort to low and rejects every non-low value", () => {
		const withoutEffort = { ...validEnv };
		delete (withoutEffort as Partial<typeof validEnv>).CODEX_EFFORT;
		expect(createRuntimeConfig(withoutEffort).brain.effort).toBe("low");
		for (const effort of ["medium", "high", "xhigh", " low", "low ", ""]) {
			const env = { ...validEnv, CODEX_EFFORT: effort };
			if (effort === "") {
				delete (env as Partial<typeof validEnv>).CODEX_EFFORT;
				expect(createRuntimeConfig(env).brain.effort).toBe("low");
			} else {
				expect(() => createRuntimeConfig(env)).toThrow(
					expect.objectContaining({ field: "CODEX_EFFORT" }),
				);
			}
		}
		expect(() =>
			createRuntimeConfig({
				...validEnv,
				CODEX_SERVICE_TIER: "priority",
				CODEX_EFFORT: "high",
			}),
		).toThrow(expect.objectContaining({ field: "CODEX_EFFORT" }));
	});

	test("accepts only an explicit priority Codex service tier", () => {
		expect(
			createRuntimeConfig({ ...validEnv, CODEX_SERVICE_TIER: "priority" }).brain
				.serviceTier,
		).toBe("priority");
		const withoutField = { ...validEnv };
		delete (withoutField as Partial<typeof validEnv>).CODEX_SERVICE_TIER;
		expect(createRuntimeConfig(withoutField).brain.serviceTier).toBeUndefined();
		for (const value of ["fast", "standard", " priority", "priority "]) {
			expect(() =>
				createRuntimeConfig({ ...validEnv, CODEX_SERVICE_TIER: value }),
			).toThrow(expect.objectContaining({ field: "CODEX_SERVICE_TIER" }));
		}
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
			ORPHAN_RECOVERY_BATCH_SIZE: "7",
			ORPHAN_RECOVERY_MAX_PER_SWEEP: "21",
			ORPHAN_RECOVERY_INTERVAL_MS: "5000",
			MAX_PENDING_BRAIN_TURNS: "1",
			TRUSTED_PROXY_HOPS: "1",
			NOTIFIER: "webhook",
			WEBHOOK_URL: "https://receiver.invalid/leads",
			WEBHOOK_SIGNING_SECRET: "test-signing-material-0000000000",
			WEBHOOK_TIMEOUT_MS: "1200",
		});
		expect(config.transcriptRetentionDays).toBe(45);
		expect(config.orphanRecovery).toEqual({
			batchSize: 7,
			maxPerSweep: 21,
			intervalMs: 5_000,
		});
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
			{ ...validEnv, ORPHAN_RECOVERY_BATCH_SIZE: "101" },
			{ ...validEnv, ORPHAN_RECOVERY_MAX_PER_SWEEP: "1001" },
			{ ...validEnv, ORPHAN_RECOVERY_INTERVAL_MS: "999" },
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
