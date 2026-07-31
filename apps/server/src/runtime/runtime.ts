import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ConversationStageSchema,
	type BookingService,
	type BrainPort,
	type CreateConversationRequest,
	type ReadyHealthResponse,
	type SttPort,
	type TtsPort,
	ReadyHealthResponseSchema,
} from "@botamin/contracts";
import {
	ConversationStore,
	closeDomainDatabase,
	openDomainDatabase,
} from "../db";
import type { DomainDatabase } from "../db";
import { SqliteBookingService } from "../domain/booking";
import { TranscriptRetentionWorker } from "../domain/privacy";
import {
	ConversationOrchestrator,
	createInitialConversationState,
} from "../orchestrator";
import { createCodexBrainFromEnv } from "../providers/codex";
import { OpenRouterSttAdapter } from "../providers/openrouter/stt";
import { OpenRouterCredentialHealth } from "../providers/openrouter/stt/credential-health";
import { OpenRouterTtsAdapter } from "../providers/openrouter/tts";
import { SessionRegistry } from "../gateway/registry";
import { GatewaySession, type SessionPersistence } from "../gateway/session";
import {
	ConsoleLeadNotifier,
	type NamedLeadNotifier,
	PollingNotificationWorker,
	SignedWebhookNotifier,
} from "../notifiers";
import { createRuntimeConfig, type RuntimeConfig } from "./config";

export interface RuntimeGatewaySession {
	readonly conversationId: string;
	readonly expiresAt: Date;
	takeClientToken(): string;
	attach(socket: import("../gateway/session").GatewaySocket): void;
	receive(
		socket: import("../gateway/session").GatewaySocket,
		data: unknown,
	): Promise<void>;
	detach(socket: import("../gateway/session").GatewaySocket): void;
}

export interface RuntimeSessionRegistry {
	create(
		request: CreateConversationRequest,
		sourceKey?: string,
	): RuntimeGatewaySession | null;
	get(conversationId: string): RuntimeGatewaySession | null;
	stop(
		conversationId: string,
		reason?: "completed" | "disconnected",
	): Promise<void>;
}

export interface ServerRuntime {
	readonly config: RuntimeConfig;
	readonly registry: RuntimeSessionRegistry;
	readiness(): Promise<ReadyHealthResponse>;
	dispose(): Promise<void>;
}

interface PromptBundle {
	version: string;
	ready: boolean;
}

export interface ProductionRuntimeOverrides {
	/** Credential-free integration tests inject bounded fakes here. */
	brain?: BrainPort & { close?(): Promise<void> };
	stt?: SttPort;
	tts?: TtsPort;
	bookings?: BookingService;
	notifier?: NamedLeadNotifier;
	now?: () => Date;
	outboxPollIntervalMs?: number;
	retentionIntervalMs?: number;
}

export class SqliteSessionPersistence implements SessionPersistence {
	readonly #store: ConversationStore;

	constructor(
		private readonly database: DomainDatabase,
		private readonly now: () => Date,
	) {
		this.#store = new ConversationStore(database);
	}

	create(input: Parameters<ConversationStore["create"]>[0]): void {
		this.#store.create(input);
	}

	appendTurn(input: Parameters<SessionPersistence["appendTurn"]>[0]): void {
		this.#store.appendTurn({
			...input,
			stateBefore: ConversationStageSchema.parse(input.stateBefore),
			stateAfter: ConversationStageSchema.parse(input.stateAfter),
		});
	}

	setConversationActive(id: string, stage: string): void {
		this.update(
			"UPDATE conversations SET status = 'active', stage = ?, ended_at = NULL WHERE id = ? AND status IN ('active', 'disconnected')",
			[stage, id],
		);
	}

	updateConversationStage(id: string, stage: string): void {
		this.update(
			"UPDATE conversations SET stage = ? WHERE id = ? AND status = 'active'",
			[stage, id],
		);
	}

	failConversation(id: string, errorCode: string): void {
		this.update(
			"UPDATE conversations SET status = 'failed', stage = 'ERROR', ended_at = ?, last_error_code = ? WHERE id = ? AND status IN ('active', 'disconnected')",
			[this.now().toISOString(), errorCode, id],
		);
	}

	stopConversation(id: string, status: "completed" | "disconnected"): void {
		this.update(
			"UPDATE conversations SET status = ?, stage = ?, ended_at = ? WHERE id = ? AND status IN ('active', 'disconnected')",
			[
				status,
				status === "completed" ? "COMPLETE" : "DISCONNECTED",
				this.now().toISOString(),
				id,
			],
		);
	}

	private update(sql: string, parameters: string[]): void {
		try {
			this.database.$client.run(sql, parameters);
		} catch {
			// Lifecycle writes are best effort; booking transactions remain authoritative.
		}
	}
}

export async function createProductionRuntime(
	env: Record<string, string | undefined> = Bun.env,
	overrides: ProductionRuntimeOverrides = {},
): Promise<ServerRuntime> {
	const config = createRuntimeConfig(env);
	const databaseFilename = sqliteFilename(config.databaseUrl);
	mkdirSync(dirname(databaseFilename), { recursive: true, mode: 0o700 });
	const database = openDomainDatabase({
		filename: config.databaseUrl,
		applyMigrations: config.autoMigrate,
		...(env.MIGRATIONS_DIR ? { migrationsFolder: env.MIGRATIONS_DIR } : {}),
	});
	const now = overrides.now ?? (() => new Date());
	const persistence = new SqliteSessionPersistence(database, now);
	const notifier = overrides.notifier ?? createLeadNotifier(config, now);
	if (notifier.kind !== config.notifier.kind) {
		closeDomainDatabase(database);
		throw new Error("Notifier override kind does not match runtime config");
	}
	const bookings =
		overrides.bookings ??
		new SqliteBookingService(database, {
			notifierKind: notifier.kind,
			now,
		});
	const outboxWorker = new PollingNotificationWorker(database, notifier, {
		pollIntervalMs: overrides.outboxPollIntervalMs ?? 1_000,
		workerOptions: { now },
	});
	const retentionWorker = new TranscriptRetentionWorker(database, {
		retentionDays: config.transcriptRetentionDays,
		now,
		...(overrides.retentionIntervalMs === undefined
			? {}
			: { intervalMs: overrides.retentionIntervalMs }),
	});
	retentionWorker.start();
	const prompt = inspectPromptBundle(config.promptRuntimeDir);
	const brainEnv = {
		...env,
		CODEX_HOME: config.brain.codexHome,
		CODEX_CWD: config.brain.cwd,
		CODEX_MODEL: config.brain.model,
		CODEX_EFFORT: config.brain.effort,
		CODEX_TOOL_MODE: config.brain.toolMode,
		TURN_TIMEOUT_MS: String(config.turnTimeoutMs),
	};
	const brain = overrides.brain ?? createCodexBrainFromEnv(brainEnv);
	const sharedCredential = new OpenRouterCredentialHealth();
	const stt =
		overrides.stt ??
		new OpenRouterSttAdapter({
			config: config.voice,
			credentialHealth: sharedCredential,
		});
	const tts =
		overrides.tts ??
		new OpenRouterTtsAdapter({
			config: config.voice,
			credentialHealth: sharedCredential,
		});

	const registry = new SessionRegistry({
		maxActiveConversations: config.maxActiveConversations,
		maxActiveConversationsPerSource: config.admission.maxActivePerSource,
		maxConcurrentBrainTurns: config.maxConcurrentBrainTurns,
		maxPendingBrainTurns: config.maxPendingBrainTurns,
		brainQueueTimeoutMs: config.brainQueueTimeoutMs,
		sessionMaxMs: config.sessionMaxMs,
		abandonedSessionMs: config.admission.abandonedSessionMs,
		now,
		createSession: ({ conversationId, expiresAt, request, acquireTurn }) => {
			const initialState = {
				...createInitialConversationState({
					qualificationEnabled:
						request.qualificationEnabled && config.qualificationEnabled,
				}),
				// The validated REST consent is server-owned evidence for booking tools.
				contactConsentConfirmed: request.consent.contactProcessing,
			};
			const orchestrator = new ConversationOrchestrator({
				conversationId,
				promptVersion: prompt.version,
				stt,
				brain,
				bookings,
				tts,
				initialState,
				qualificationEnabled:
					request.qualificationEnabled && config.qualificationEnabled,
				speechChunker: {
					firstTarget: numberEnv(env.TTS_FIRST_SEGMENT_TARGET_CHARS, 100),
					softTarget: numberEnv(env.TTS_SOFT_SEGMENT_CHARS, 160),
					hardLimit: numberEnv(env.TTS_MAX_SEGMENT_CHARS, 240),
					idleFlushMs: numberEnv(env.TTS_IDLE_FLUSH_MS, 350),
				},
				speechBudgets: {
					maxCharsPerSegment: config.voice.tts.maxCharsPerSegment,
					maxCharsPerTurn: config.voice.tts.maxCharsPerTurn,
					maxCharsPerSession: config.voice.tts.maxCharsPerSession,
				},
			});
			persistence.create({
				id: conversationId,
				status: "active",
				stage: "CONNECTING",
				promptVersion: prompt.version,
				source: request.source,
				locale: request.locale ?? "ru-RU",
				qualificationEnabled: request.qualificationEnabled,
				consentAt: now().toISOString(),
				startedAt: now().toISOString(),
			});
			return new GatewaySession({
				conversationId,
				expiresAt,
				orchestrator,
				bookings,
				persistence,
				brainModel: config.brain.model,
				maxUtteranceMs: config.voice.stt.maxUtteranceMs,
				maxAudioBytes: config.voice.stt.maxAudioBytes,
				maxFrameBytes: config.limits.wsFrameBytes,
				maxJsonBytes: config.limits.wsJsonBytes,
				maxHistoryEvents: config.limits.historyEvents,
				maxHistoryBytes: config.limits.historyBytes,
				clientHelloTimeoutMs: config.admission.clientHelloTimeoutMs,
				stopDrainMs: config.sessionStopDrainMs,
				acquireTurn,
				now,
			});
		},
	});
	outboxWorker.start();

	let disposed = false;
	return {
		config,
		registry,
		async readiness(): Promise<ReadyHealthResponse> {
			const [databaseReady, brainHealth, sttHealth, ttsHealth] =
				await Promise.all([
					checkDatabase(database),
					brain.health(),
					stt.health(),
					tts.health(),
				]);
			const currentPrompt = inspectPromptBundle(config.promptRuntimeDir);
			const promptReady =
				prompt.ready &&
				currentPrompt.ready &&
				currentPrompt.version === prompt.version;
			const voiceStatus =
				sttHealth !== "ready"
					? "unready"
					: ttsHealth === "ready"
						? "ready"
						: config.voice.tts.textOnlyFallback
							? "degraded"
							: "unready";
			const checks: ReadyHealthResponse["checks"] = [
				{
					name: "database",
					status: databaseReady ? "ready" : "unready",
					...(databaseReady ? {} : { code: "DB_UNAVAILABLE" }),
				},
				{
					name: "brain",
					status:
						brainHealth.status === "healthy"
							? "ready"
							: brainHealth.status === "degraded"
								? "degraded"
								: "unready",
					...(brainHealth.code ? { code: brainHealth.code } : {}),
				},
				{
					name: "voice",
					status: voiceStatus,
					...(voiceStatus === "ready"
						? {}
						: {
								code:
									sttHealth !== "ready"
										? "OPENROUTER_STT_NOT_READY"
										: "OPENROUTER_TTS_DEGRADED",
							}),
				},
				{
					name: "prompts",
					status: promptReady ? "ready" : "unready",
					...(promptReady ? {} : { code: "PROMPT_BUNDLE_INVALID" }),
				},
				{
					name: "notifier",
					status: outboxWorker.ready ? "ready" : "unready",
					...(outboxWorker.ready ? {} : { code: "OUTBOX_WORKER_UNAVAILABLE" }),
				},
				{
					name: "capacity",
					status:
						registry.hasCapacity && registry.hasTurnCapacity
							? "ready"
							: "unready",
					...(registry.hasCapacity && registry.hasTurnCapacity
						? {}
						: { code: "CAPACITY_EXCEEDED" }),
				},
			];
			return ReadyHealthResponseSchema.parse({
				status: checks.some((check) => check.status === "unready")
					? "unready"
					: "ready",
				checks,
			});
		},
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			await registry.dispose();
			await outboxWorker.stop();
			retentionWorker.stop();
			await brain.close?.();
			closeDomainDatabase(database);
		},
	};
}

function createLeadNotifier(
	config: RuntimeConfig,
	now: () => Date,
): NamedLeadNotifier {
	if (config.notifier.kind === "console") return new ConsoleLeadNotifier();
	return new SignedWebhookNotifier({
		url: config.notifier.url,
		signingSecret: config.notifier.signingSecret,
		timeoutMs: config.notifier.timeoutMs,
		now,
	});
}

function sqliteFilename(value: string): string {
	if (value.includes("?") || value.includes("#")) {
		throw new Error("DATABASE_URL must be a plain SQLite path");
	}
	const filename = value.startsWith("file:") ? value.slice(5) : value;
	if (!filename || filename === ":memory:") {
		throw new Error("Production DATABASE_URL must be a durable SQLite file");
	}
	return filename;
}

function inspectPromptBundle(runtimeDir: string): PromptBundle {
	try {
		const entries = readdirSync(runtimeDir);
		if (entries.length !== 1 || entries[0] !== "AGENTS.md") {
			return { version: "0".repeat(64), ready: false };
		}
		const path = join(runtimeDir, "AGENTS.md");
		const stat = statSync(path);
		if (!stat.isFile() || (stat.mode & 0o222) !== 0 || stat.size === 0) {
			return { version: "0".repeat(64), ready: false };
		}
		const bytes = readFileSync(path);
		return {
			version: createHash("sha256").update(bytes).digest("hex"),
			ready: true,
		};
	} catch {
		return { version: "0".repeat(64), ready: false };
	}
}

async function checkDatabase(database: DomainDatabase): Promise<boolean> {
	const id = Bun.randomUUIDv7();
	try {
		database.$client.run("BEGIN IMMEDIATE");
		database.$client.run(
			"INSERT INTO domain_events (id, conversation_id, booking_id, type, payload_json, created_at) VALUES (?, ?, NULL, 'runtime.readiness', '{}', ?)",
			[id, id, new Date().toISOString()],
		);
		const row = database.$client
			.query<{ id: string }, [string]>(
				"SELECT id FROM domain_events WHERE id = ?",
			)
			.get(id);
		database.$client.run("ROLLBACK");
		return row?.id === id;
	} catch {
		try {
			database.$client.run("ROLLBACK");
		} catch {
			// Ignore rollback failure; readiness remains unready.
		}
		return false;
	}
}

function numberEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}
