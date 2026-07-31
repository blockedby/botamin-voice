import { isAbsolute, resolve } from "node:path";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../providers/openrouter/stt/config";

export interface RuntimeConfig {
	readonly appOrigin: string;
	readonly port: number;
	readonly databaseUrl: string;
	readonly autoMigrate: boolean;
	readonly promptRuntimeDir: string;
	readonly maxActiveConversations: number;
	readonly maxConcurrentBrainTurns: number;
	readonly sessionMaxMs: number;
	readonly turnTimeoutMs: number;
	readonly qualificationEnabled: boolean;
	readonly brain: {
		readonly provider: "codex-subscription";
		readonly model: "gpt-5.6-luna";
		readonly effort: string;
		readonly toolMode: "envelope";
		readonly codexHome: string;
		readonly cwd: string;
	};
	readonly voice: OpenRouterVoiceConfig;
	readonly limits: {
		readonly httpBodyBytes: number;
		readonly wsJsonBytes: number;
		readonly wsFrameBytes: number;
		readonly historyEvents: number;
		readonly historyBytes: number;
	};
}

export class RuntimeConfigError extends Error {
	readonly code = "RUNTIME_CONFIG_INVALID" as const;

	constructor(readonly field: string) {
		super(`Invalid runtime configuration: ${field}`);
		this.name = "RuntimeConfigError";
	}
}

type Environment = Readonly<Record<string, string | undefined>>;

function integer(
	env: Environment,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) throw new RuntimeConfigError(name);
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new RuntimeConfigError(name);
	}
	return parsed;
}

function boolean(env: Environment, name: string, fallback: boolean): boolean {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new RuntimeConfigError(name);
}

function exact(env: Environment, name: string, expected: string): string {
	const value = env[name] ?? expected;
	if (value !== expected) throw new RuntimeConfigError(name);
	return value;
}

function absolutePath(env: Environment, name: string): string {
	const raw = env[name]?.trim();
	if (!raw) throw new RuntimeConfigError(name);
	return isAbsolute(raw) ? raw : resolve(raw);
}

function appOrigin(env: Environment): string {
	let url: URL;
	try {
		url = new URL(env.APP_ORIGIN ?? "http://localhost:5173");
	} catch {
		throw new RuntimeConfigError("APP_ORIGIN");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new RuntimeConfigError("APP_ORIGIN");
	}
	return url.origin;
}

/** Validates all production wiring without reading or logging secret values. */
export function createRuntimeConfig(env: Environment = Bun.env): RuntimeConfig {
	exact(env, "BRAIN_PROVIDER", "codex-subscription");
	exact(env, "CODEX_MODEL", "gpt-5.6-luna");
	exact(env, "CODEX_TOOL_MODE", "envelope");
	exact(env, "STT_PROVIDER", "openrouter");
	exact(env, "TTS_PROVIDER", "openrouter");
	if (boolean(env, "STORE_RAW_AUDIO", false)) {
		throw new RuntimeConfigError("STORE_RAW_AUDIO");
	}

	const maxActiveConversations = integer(
		env,
		"MAX_ACTIVE_CONVERSATIONS",
		3,
		1,
		100,
	);
	const maxConcurrentBrainTurns = integer(
		env,
		"MAX_CONCURRENT_BRAIN_TURNS",
		3,
		1,
		32,
	);
	if (maxConcurrentBrainTurns > maxActiveConversations) {
		throw new RuntimeConfigError("MAX_CONCURRENT_BRAIN_TURNS");
	}
	const codexConcurrency = integer(
		env,
		"CODEX_MAX_CONCURRENT_TURNS",
		maxConcurrentBrainTurns,
		1,
		32,
	);
	if (codexConcurrency !== maxConcurrentBrainTurns) {
		throw new RuntimeConfigError("CODEX_MAX_CONCURRENT_TURNS");
	}

	const voice = loadOpenRouterVoiceConfig(env);
	return {
		appOrigin: appOrigin(env),
		port: integer(env, "PORT", 3000, 1, 65_535),
		databaseUrl: env.DATABASE_URL?.trim() || "file:./data/app.db",
		autoMigrate: boolean(env, "AUTO_MIGRATE", true),
		promptRuntimeDir: resolve(
			env.PROMPT_RUNTIME_DIR ?? env.CODEX_CWD ?? ".runtime/brain",
		),
		maxActiveConversations,
		maxConcurrentBrainTurns,
		sessionMaxMs: integer(env, "SESSION_MAX_MINUTES", 20, 1, 120) * 60_000,
		turnTimeoutMs: integer(env, "TURN_TIMEOUT_MS", 45_000, 1_000, 300_000),
		qualificationEnabled: boolean(
			env,
			"POST_BOOKING_QUALIFICATION_ENABLED",
			true,
		),
		brain: {
			provider: "codex-subscription",
			model: "gpt-5.6-luna",
			effort: env.CODEX_EFFORT?.trim() || "low",
			toolMode: "envelope",
			codexHome: absolutePath(env, "CODEX_HOME"),
			cwd: absolutePath(env, "CODEX_CWD"),
		},
		voice,
		limits: {
			httpBodyBytes: 8_192,
			wsJsonBytes: 8_192,
			wsFrameBytes: Math.min(3_209, voice.stt.maxAudioBytes),
			historyEvents: 128,
			historyBytes: 5_000_000,
		},
	};
}
