import {
	CANONICAL_TTS_WAV_FORMAT,
	COMPLETE_AUDIO_SEGMENT_MAX_BYTES,
} from "@botamin/contracts";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_STT_MODEL = "openai/gpt-audio-mini";
export const DEFAULT_OPENROUTER_TTS_PROFILE = "xai_mp3" as const;
export const DEFAULT_OPENROUTER_TTS_MODEL = "x-ai/grok-voice-tts-1.0";
export const DEFAULT_OPENROUTER_TTS_VOICE = "eve";
export const GEMINI_3_1_TTS_MODEL =
	"google/gemini-3.1-flash-tts-preview" as const;

export type OpenRouterTtsProfile = "xai_mp3" | "gemini_3_1_pcm";

export function outputContentTypeForTtsProfile(
	profile: OpenRouterTtsProfile,
): "audio/mpeg" | "audio/wav" {
	return profile === "xai_mp3" ? "audio/mpeg" : "audio/wav";
}

/**
 * Case-sensitive release snapshot verified 2026-08-03 against the 30 voices
 * advertised for Gemini TTS. The public catalog is dynamic: update this list
 * deliberately for a later release; configuration must fail instead of choosing
 * a different voice when the configured value leaves this snapshot.
 */
export const GEMINI_3_1_TTS_VOICES = Object.freeze([
	"Zephyr",
	"Puck",
	"Charon",
	"Kore",
	"Fenrir",
	"Leda",
	"Orus",
	"Aoede",
	"Callirrhoe",
	"Autonoe",
	"Enceladus",
	"Iapetus",
	"Umbriel",
	"Algieba",
	"Despina",
	"Erinome",
	"Algenib",
	"Rasalgethi",
	"Laomedeia",
	"Achernar",
	"Alnilam",
	"Schedar",
	"Gacrux",
	"Pulcherrima",
	"Achird",
	"Zubenelgenubi",
	"Vindemiatrix",
	"Sadachbia",
	"Sadaltager",
	"Sulafat",
] as const);

export type Gemini31TtsVoice = (typeof GEMINI_3_1_TTS_VOICES)[number];

export class OpenRouterVoiceConfigError extends Error {
	readonly code = "OPENROUTER_VOICE_CONFIG_INVALID" as const;

	constructor(readonly field: string) {
		super(`Invalid OpenRouter voice configuration: ${field}`);
		this.name = "OpenRouterVoiceConfigError";
	}
}

export interface OpenRouterVoiceConfig {
	readonly apiKey: string | null;
	readonly baseUrl: string;
	readonly httpReferer?: string;
	readonly appTitle?: string;
	readonly stt: {
		readonly model: string;
		readonly audioFormat: "wav";
		readonly language: "ru";
		readonly textOnlyInputFallback: false;
		readonly connectTimeoutMs: number;
		readonly totalTimeoutMs: number;
		readonly maxRetries: 0 | 1;
		readonly retryBaseMs: number;
		readonly maxRetryAfterMs: number;
		readonly maxUtteranceMs: number;
		readonly maxAudioBytes: number;
		readonly maxConcurrency: number;
		readonly circuitFailureThreshold: number;
		readonly circuitCooldownMs: number;
	};
	readonly tts: {
		readonly profile: OpenRouterTtsProfile;
		readonly outputContentType: "audio/mpeg" | "audio/wav";
		readonly model: string;
		readonly voice: string;
		readonly responseFormat: "mp3" | "pcm";
		readonly speed?: number;
		readonly connectTimeoutMs: number;
		readonly totalTimeoutMs: number;
		readonly maxRetries: 0 | 1;
		readonly retryBaseMs: number;
		readonly maxRetryAfterMs: number;
		readonly circuitFailureThreshold: number;
		readonly circuitCooldownMs: number;
		readonly textOnlyFallback: boolean;
		readonly maxCharsPerSegment: number;
		readonly maxCharsPerTurn: number;
		readonly maxCharsPerSession: number;
		readonly maxConcurrency: number;
		readonly maxResponseBytes: number;
	};
}

type Environment = Readonly<Record<string, string | undefined>>;

function readInteger(
	env: Environment,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) throw new OpenRouterVoiceConfigError(name);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new OpenRouterVoiceConfigError(name);
	}
	return value;
}

function readRetryCount(
	env: Environment,
	name: string,
	fallback: 0 | 1,
): 0 | 1 {
	const value = readInteger(env, name, fallback, 0, 1);
	return value === 0 ? 0 : 1;
}

function readBoolean(
	env: Environment,
	name: string,
	fallback: boolean,
): boolean {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new OpenRouterVoiceConfigError(name);
}

function readSafeToken(
	env: Environment,
	name: string,
	fallback: string,
): string {
	const value = (env[name] ?? fallback).trim();
	if (
		value.length === 0 ||
		value.length > 200 ||
		!/^[-A-Za-z0-9_./:]+$/.test(value)
	) {
		throw new OpenRouterVoiceConfigError(name);
	}
	return value;
}

function readOptionalHeader(
	env: Environment,
	name: string,
): string | undefined {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	const value = raw.trim();
	if (value.length === 0 || value.length > 300 || /[\r\n]/.test(value)) {
		throw new OpenRouterVoiceConfigError(name);
	}
	return value;
}

function readBaseUrl(env: Environment): string {
	const raw = (env.OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL).trim();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OpenRouterVoiceConfigError("OPENROUTER_BASE_URL");
	}
	const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new OpenRouterVoiceConfigError("OPENROUTER_BASE_URL");
	}
	return url.toString().replace(/\/$/, "");
}

function readReferer(env: Environment): string | undefined {
	const value = readOptionalHeader(env, "OPENROUTER_HTTP_REFERER");
	if (value === undefined) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		throw new OpenRouterVoiceConfigError("OPENROUTER_HTTP_REFERER");
	}
	return value;
}

function readSpeed(env: Environment): number | undefined {
	const raw = env.OPENROUTER_TTS_SPEED;
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0.25 || value > 4) {
		throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_SPEED");
	}
	return value;
}

function readTtsProfile(env: Environment): OpenRouterTtsProfile {
	const profile = env.OPENROUTER_TTS_PROFILE ?? DEFAULT_OPENROUTER_TTS_PROFILE;
	if (profile !== "xai_mp3" && profile !== "gemini_3_1_pcm") {
		throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_PROFILE");
	}
	return profile;
}

function readTtsProfileConfig(
	env: Environment,
): Pick<
	OpenRouterVoiceConfig["tts"],
	| "profile"
	| "outputContentType"
	| "model"
	| "voice"
	| "responseFormat"
	| "speed"
	| "maxResponseBytes"
> {
	const profile = readTtsProfile(env);
	const model = env.OPENROUTER_TTS_MODEL ?? DEFAULT_OPENROUTER_TTS_MODEL;
	const voice = env.OPENROUTER_TTS_VOICE ?? DEFAULT_OPENROUTER_TTS_VOICE;
	const responseFormat = env.OPENROUTER_TTS_RESPONSE_FORMAT ?? "mp3";
	const speed = readSpeed(env);

	if (profile === "xai_mp3") {
		if (model !== DEFAULT_OPENROUTER_TTS_MODEL) {
			throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_MODEL");
		}
		if (voice !== DEFAULT_OPENROUTER_TTS_VOICE) {
			throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_VOICE");
		}
		if (responseFormat !== "mp3") {
			throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_RESPONSE_FORMAT");
		}
		return {
			profile,
			outputContentType: outputContentTypeForTtsProfile(profile),
			model,
			voice,
			responseFormat,
			...(speed === undefined ? {} : { speed }),
			maxResponseBytes: COMPLETE_AUDIO_SEGMENT_MAX_BYTES,
		};
	}

	if (model !== GEMINI_3_1_TTS_MODEL) {
		throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_MODEL");
	}
	if (!(GEMINI_3_1_TTS_VOICES as readonly string[]).includes(voice)) {
		throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_VOICE");
	}
	if (responseFormat !== "pcm") {
		throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_RESPONSE_FORMAT");
	}
	if (speed !== undefined) {
		throw new OpenRouterVoiceConfigError("OPENROUTER_TTS_SPEED");
	}
	return {
		profile,
		outputContentType: outputContentTypeForTtsProfile(profile),
		model,
		voice,
		responseFormat,
		maxResponseBytes:
			COMPLETE_AUDIO_SEGMENT_MAX_BYTES - CANONICAL_TTS_WAV_FORMAT.headerBytes,
	};
}

/**
 * Loads the one shared OpenRouter key and both voice profiles. It does not read
 * files and never includes the key in validation errors.
 */
export function loadOpenRouterVoiceConfig(
	env: Environment = Bun.env,
): OpenRouterVoiceConfig {
	const apiKey = env.OPENROUTER_API_KEY?.trim() || null;
	if (apiKey !== null && (apiKey.length > 500 || /[\r\n]/.test(apiKey))) {
		throw new OpenRouterVoiceConfigError("OPENROUTER_API_KEY");
	}

	const sttConnectTimeoutMs = readInteger(
		env,
		"STT_CONNECT_TIMEOUT_MS",
		8_000,
		1,
		60_000,
	);
	const sttTotalTimeoutMs = readInteger(
		env,
		"STT_TOTAL_TIMEOUT_MS",
		30_000,
		1,
		120_000,
	);
	if (sttConnectTimeoutMs > sttTotalTimeoutMs) {
		throw new OpenRouterVoiceConfigError("STT_CONNECT_TIMEOUT_MS");
	}
	const sttRetryBaseMs = readInteger(env, "STT_RETRY_BASE_MS", 400, 0, 10_000);

	const ttsConnectTimeoutMs = readInteger(
		env,
		"TTS_CONNECT_TIMEOUT_MS",
		8_000,
		1,
		60_000,
	);
	const ttsTotalTimeoutMs = readInteger(
		env,
		"TTS_TOTAL_TIMEOUT_MS",
		20_000,
		1,
		120_000,
	);
	if (ttsConnectTimeoutMs > ttsTotalTimeoutMs) {
		throw new OpenRouterVoiceConfigError("TTS_CONNECT_TIMEOUT_MS");
	}
	const ttsRetryBaseMs = readInteger(env, "TTS_RETRY_BASE_MS", 400, 0, 10_000);

	const sttAudioFormat = env.OPENROUTER_STT_AUDIO_FORMAT ?? "wav";
	if (sttAudioFormat !== "wav") {
		throw new OpenRouterVoiceConfigError("OPENROUTER_STT_AUDIO_FORMAT");
	}
	const sttLanguage = env.OPENROUTER_STT_LANGUAGE ?? "ru";
	if (sttLanguage !== "ru") {
		throw new OpenRouterVoiceConfigError("OPENROUTER_STT_LANGUAGE");
	}
	if (readBoolean(env, "STT_TEXT_ONLY_INPUT_FALLBACK", false)) {
		throw new OpenRouterVoiceConfigError("STT_TEXT_ONLY_INPUT_FALLBACK");
	}
	const maxUtteranceMs = readInteger(
		env,
		"STT_MAX_UTTERANCE_MS",
		60_000,
		100,
		120_000,
	);
	const maxAudioBytes = readInteger(
		env,
		"STT_MAX_AUDIO_BYTES",
		2_000_000,
		45,
		10_000_000,
	);
	// A canonical 100ms mono PCM16 frame is 3,200 bytes plus a 44-byte WAV header.
	if (maxUtteranceMs < 100 || maxAudioBytes < 3_244) {
		throw new OpenRouterVoiceConfigError("STT_MAX_AUDIO_BYTES");
	}

	const httpReferer = readReferer(env);
	const appTitle = readOptionalHeader(env, "OPENROUTER_APP_TITLE");
	const ttsProfile = readTtsProfileConfig(env);
	const maxCharsPerSegment = readInteger(
		env,
		"TTS_MAX_CHARS_PER_SEGMENT",
		240,
		1,
		20_000,
	);
	const maxCharsPerTurn = readInteger(
		env,
		"TTS_MAX_CHARS_PER_TURN",
		1_800,
		1,
		100_000,
	);
	const maxCharsPerSession = readInteger(
		env,
		"TTS_MAX_CHARS_PER_SESSION",
		8_000,
		1,
		1_000_000,
	);
	if (
		maxCharsPerSegment > maxCharsPerTurn ||
		maxCharsPerTurn > maxCharsPerSession
	) {
		throw new OpenRouterVoiceConfigError("TTS character budgets");
	}

	return {
		apiKey,
		baseUrl: readBaseUrl(env),
		...(httpReferer === undefined ? {} : { httpReferer }),
		...(appTitle === undefined ? {} : { appTitle }),
		stt: {
			model: readSafeToken(
				env,
				"OPENROUTER_STT_MODEL",
				DEFAULT_OPENROUTER_STT_MODEL,
			),
			audioFormat: "wav",
			language: "ru",
			textOnlyInputFallback: false,
			connectTimeoutMs: sttConnectTimeoutMs,
			totalTimeoutMs: sttTotalTimeoutMs,
			maxRetries: readRetryCount(env, "STT_MAX_RETRIES", 1),
			retryBaseMs: sttRetryBaseMs,
			maxRetryAfterMs: Math.max(2_000, sttRetryBaseMs * 5),
			maxUtteranceMs,
			maxAudioBytes,
			maxConcurrency: 2,
			circuitFailureThreshold: 3,
			circuitCooldownMs: 60_000,
		},
		tts: {
			...ttsProfile,
			connectTimeoutMs: ttsConnectTimeoutMs,
			totalTimeoutMs: ttsTotalTimeoutMs,
			maxRetries: readRetryCount(env, "TTS_MAX_RETRIES", 1),
			retryBaseMs: ttsRetryBaseMs,
			maxRetryAfterMs: Math.max(2_000, ttsRetryBaseMs * 5),
			circuitFailureThreshold: readInteger(
				env,
				"TTS_CIRCUIT_BREAKER_FAILURES",
				3,
				1,
				20,
			),
			circuitCooldownMs: readInteger(
				env,
				"TTS_CIRCUIT_BREAKER_COOLDOWN_MS",
				60_000,
				1,
				3_600_000,
			),
			textOnlyFallback: readBoolean(env, "TTS_TEXT_ONLY_FALLBACK", true),
			maxCharsPerSegment,
			maxCharsPerTurn,
			maxCharsPerSession,
			maxConcurrency: readInteger(env, "TTS_MAX_CONCURRENCY", 2, 1, 20),
		},
	};
}

export function createOpenRouterHeaders(
	config: OpenRouterVoiceConfig,
	options: { disableCache: boolean },
): Headers {
	const headers = new Headers({
		"Content-Type": "application/json",
	});
	if (config.apiKey !== null) {
		headers.set("Authorization", `Bearer ${config.apiKey}`);
	}
	if (config.httpReferer !== undefined) {
		headers.set("HTTP-Referer", config.httpReferer);
	}
	if (config.appTitle !== undefined) {
		headers.set("X-OpenRouter-Title", config.appTitle);
	}
	if (options.disableCache) headers.set("X-OpenRouter-Cache", "false");
	return headers;
}
