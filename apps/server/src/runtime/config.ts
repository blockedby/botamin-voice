import { isAbsolute, resolve } from "node:path";
import { CANONICAL_PCM_100MS_BYTES, WAV_HEADER_BYTES } from "../gateway/wav";
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
	readonly maxPendingBrainTurns: number;
	readonly brainQueueTimeoutMs: number;
	readonly sessionMaxMs: number;
	readonly sessionStopDrainMs: number;
	readonly turnTimeoutMs: number;
	readonly transcriptRetentionDays: number;
	readonly orphanRecovery: {
		readonly batchSize: number;
		readonly maxPerSweep: number;
		readonly intervalMs: number;
	};
	readonly qualificationEnabled: boolean;
	readonly notifier:
		| { readonly kind: "console" }
		| {
				readonly kind: "webhook";
				readonly url: string;
				readonly signingSecret: string;
				readonly timeoutMs: number;
		  };
	readonly admission: {
		readonly trustedProxyHops: number;
		readonly windowMs: number;
		readonly maxCreatesPerSource: number;
		readonly maxSocketConnectionsPerSource: number;
		readonly maxActivePerSource: number;
		readonly clientHelloTimeoutMs: number;
		readonly abandonedSessionMs: number;
	};
	readonly brain: {
		readonly provider: "codex-subscription";
		readonly model: "gpt-5.6-luna";
		readonly effort: string;
		readonly serviceTier?: "priority";
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

function codexServiceTier(env: Environment): "priority" | undefined {
	const value = env.CODEX_SERVICE_TIER;
	if (value === undefined || value === "") return undefined;
	if (value === "priority") return value;
	throw new RuntimeConfigError("CODEX_SERVICE_TIER");
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

function notifierConfig(env: Environment): RuntimeConfig["notifier"] {
	const kind = env.NOTIFIER?.trim() || "console";
	if (kind === "console") return { kind };
	if (kind !== "webhook") throw new RuntimeConfigError("NOTIFIER");

	const rawUrl = env.WEBHOOK_URL?.trim();
	const signingSecret = env.WEBHOOK_SIGNING_SECRET?.trim();
	if (!rawUrl) throw new RuntimeConfigError("WEBHOOK_URL");
	if (
		!signingSecret ||
		signingSecret.length < 16 ||
		signingSecret.length > 512 ||
		/[\r\n]/u.test(signingSecret)
	) {
		throw new RuntimeConfigError("WEBHOOK_SIGNING_SECRET");
	}
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new RuntimeConfigError("WEBHOOK_URL");
	}
	const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== ""
	) {
		throw new RuntimeConfigError("WEBHOOK_URL");
	}
	return {
		kind,
		url: url.toString(),
		signingSecret,
		timeoutMs: integer(env, "WEBHOOK_TIMEOUT_MS", 5_000, 100, 30_000),
	};
}

/** Validates all production wiring without reading or logging secret values. */
export function createRuntimeConfig(env: Environment = Bun.env): RuntimeConfig {
	exact(env, "BRAIN_PROVIDER", "codex-subscription");
	exact(env, "CODEX_MODEL", "gpt-5.6-luna");
	const serviceTier = codexServiceTier(env);
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
	if (
		voice.stt.maxUtteranceMs < 100 ||
		voice.stt.maxAudioBytes < WAV_HEADER_BYTES + CANONICAL_PCM_100MS_BYTES
	) {
		throw new RuntimeConfigError("STT_MAX_AUDIO_BYTES");
	}
	const turnTimeoutMs = integer(env, "TURN_TIMEOUT_MS", 45_000, 1_000, 300_000);
	const maxActivePerSource = integer(
		env,
		"MAX_ACTIVE_CONVERSATIONS_PER_SOURCE",
		Math.min(2, maxActiveConversations),
		1,
		100,
	);
	if (maxActivePerSource > maxActiveConversations) {
		throw new RuntimeConfigError("MAX_ACTIVE_CONVERSATIONS_PER_SOURCE");
	}
	const clientHelloTimeoutMs = integer(
		env,
		"CLIENT_HELLO_TIMEOUT_MS",
		2_000,
		250,
		5_000,
	);
	const abandonedSessionMs = integer(
		env,
		"ABANDONED_SESSION_TIMEOUT_MS",
		10_000,
		1_000,
		60_000,
	);
	if (abandonedSessionMs < clientHelloTimeoutMs) {
		throw new RuntimeConfigError("ABANDONED_SESSION_TIMEOUT_MS");
	}

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
		maxPendingBrainTurns: integer(env, "MAX_PENDING_BRAIN_TURNS", 6, 0, 256),
		brainQueueTimeoutMs: integer(
			env,
			"BRAIN_QUEUE_TIMEOUT_MS",
			turnTimeoutMs,
			250,
			300_000,
		),
		sessionMaxMs: integer(env, "SESSION_MAX_MINUTES", 20, 1, 120) * 60_000,
		sessionStopDrainMs: integer(
			env,
			"SESSION_STOP_DRAIN_MS",
			5_000,
			100,
			30_000,
		),
		turnTimeoutMs,
		transcriptRetentionDays: integer(
			env,
			"TRANSCRIPT_RETENTION_DAYS",
			30,
			1,
			3_650,
		),
		orphanRecovery: {
			batchSize: integer(env, "ORPHAN_RECOVERY_BATCH_SIZE", 25, 1, 100),
			maxPerSweep: integer(env, "ORPHAN_RECOVERY_MAX_PER_SWEEP", 100, 1, 1_000),
			intervalMs: integer(
				env,
				"ORPHAN_RECOVERY_INTERVAL_MS",
				60_000,
				1_000,
				86_400_000,
			),
		},
		qualificationEnabled: boolean(
			env,
			"POST_BOOKING_QUALIFICATION_ENABLED",
			true,
		),
		notifier: notifierConfig(env),
		admission: {
			trustedProxyHops: integer(env, "TRUSTED_PROXY_HOPS", 0, 0, 3),
			windowMs: integer(env, "ADMISSION_WINDOW_MS", 60_000, 1_000, 600_000),
			maxCreatesPerSource: integer(
				env,
				"MAX_CONVERSATION_CREATES_PER_SOURCE",
				5,
				1,
				1_000,
			),
			maxSocketConnectionsPerSource: integer(
				env,
				"MAX_SESSION_CONNECTIONS_PER_SOURCE",
				20,
				1,
				2_000,
			),
			maxActivePerSource,
			clientHelloTimeoutMs,
			abandonedSessionMs,
		},
		brain: {
			provider: "codex-subscription",
			model: "gpt-5.6-luna",
			effort: env.CODEX_EFFORT?.trim() || "low",
			...(serviceTier ? { serviceTier } : {}),
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
