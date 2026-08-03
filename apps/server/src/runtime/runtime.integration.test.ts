import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	BrainPort,
	BrainTurnInput,
	SttPort,
	TtsPort,
} from "@botamin/contracts";
import { createServerApp } from "../app";
import { closeDomainDatabase, openDomainDatabase } from "../db";
import { createProductionRuntime, SqliteSessionPersistence } from "./runtime";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const brain: BrainPort & { close(): Promise<void> } = {
	createThread: async () => "fake-thread",
	async *runTurn(_input: BrainTurnInput) {},
	interrupt: async () => undefined,
	health: async () => ({ status: "healthy" }),
	close: async () => undefined,
};
const stt: SttPort = {
	transcribe: async () => {
		throw new Error("not used by readiness");
	},
	health: async () => "ready",
};
const tts: TtsPort = {
	synthesize: async () => {
		throw new Error("not used by readiness");
	},
	health: async () => "ready",
};

describe("production runtime readiness with injected credential-free ports", () => {
	test("terminal failure status is one guarded SQLite transition", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-runtime-status-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const persistence = new SqliteSessionPersistence(
			database,
			() => new Date("2026-07-30T20:22:00.000Z"),
		);
		const id = Bun.randomUUIDv7();
		persistence.create({
			id,
			stage: "GREETING",
			promptVersion: "a".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: "2026-07-30T20:20:00.000Z",
			startedAt: "2026-07-30T20:20:00.000Z",
		});
		persistence.failConversation(id, "BRAIN_PROTOCOL_ERROR");
		persistence.failConversation(id, "BRAIN_RATE_LIMITED");
		persistence.stopConversation(id, "completed");
		expect(
			database.$client
				.query<
					{ status: string; stage: string; last_error_code: string },
					[string]
				>(
					"SELECT status, stage, last_error_code FROM conversations WHERE id = ?",
				)
				.get(id),
		).toEqual({
			status: "failed",
			stage: "ERROR",
			last_error_code: "BRAIN_PROTOCOL_ERROR",
		});
		closeDomainDatabase(database);
	});

	test("Codex subscription auth loss fails readiness without exposing auth detail", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-auth-loss-"));
		directories.push(directory);
		const promptDir = join(directory, "brain");
		const codexHome = join(directory, "codex-home");
		await mkdir(promptDir, { recursive: true });
		await mkdir(codexHome, { recursive: true });
		const agents = join(promptDir, "AGENTS.md");
		await writeFile(agents, "# auth-loss fake prompt\n", { mode: 0o444 });
		await chmod(agents, 0o444);
		const authLostBrain: BrainPort & { close(): Promise<void> } = {
			...brain,
			health: async () => ({
				status: "unavailable",
				code: "CODEX_SUBSCRIPTION_AUTH_REQUIRED",
			}),
		};
		const runtime = await createProductionRuntime(
			{
				APP_ORIGIN: "http://localhost:5173",
				AUTO_MIGRATE: "true",
				DATABASE_URL: `file:${join(directory, "data", "app.db")}`,
				MIGRATIONS_DIR: resolve("drizzle"),
				BRAIN_PROVIDER: "codex-subscription",
				CODEX_MODEL: "gpt-5.6-luna",
				CODEX_HOME: codexHome,
				CODEX_CWD: promptDir,
				PROMPT_RUNTIME_DIR: promptDir,
				CODEX_TOOL_MODE: "envelope",
				CODEX_MAX_CONCURRENT_TURNS: "1",
				MAX_ACTIVE_CONVERSATIONS: "1",
				MAX_CONCURRENT_BRAIN_TURNS: "1",
				STT_PROVIDER: "openrouter",
				TTS_PROVIDER: "openrouter",
				OPENROUTER_API_KEY: "test-placeholder-not-a-secret",
				OPENROUTER_STT_AUDIO_FORMAT: "wav",
				OPENROUTER_STT_LANGUAGE: "ru",
				OPENROUTER_TTS_RESPONSE_FORMAT: "mp3",
				STT_TEXT_ONLY_INPUT_FALLBACK: "false",
				STORE_RAW_AUDIO: "false",
			},
			{ brain: authLostBrain, stt, tts },
		);
		try {
			const ready = await runtime.readiness();
			expect(ready.status).toBe("unready");
			expect(ready.checks.find((check) => check.name === "brain")).toEqual({
				name: "brain",
				status: "unready",
				code: "CODEX_SUBSCRIPTION_AUTH_REQUIRED",
			});
			const response = await createServerApp(runtime).request("/health/ready");
			expect(response.status).toBe(503);
			const body = JSON.stringify(await response.json());
			expect(body).not.toContain("auth.json");
			expect(body).not.toContain("refresh_token");
		} finally {
			await runtime.dispose();
		}
	});

	test("checks actual migrated SQLite, prompt bundle, fakes, and capacity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-runtime-test-"));
		directories.push(directory);
		const promptDir = join(directory, "brain");
		const codexHome = join(directory, "codex-home");
		await mkdir(promptDir, { recursive: true });
		await mkdir(codexHome, { recursive: true });
		const agents = join(promptDir, "AGENTS.md");
		await writeFile(agents, "# deterministic fake prompt\n", { mode: 0o444 });
		await chmod(agents, 0o444);
		const runtime = await createProductionRuntime(
			{
				APP_ORIGIN: "http://localhost:5173",
				AUTO_MIGRATE: "true",
				DATABASE_URL: `file:${join(directory, "data", "app.db")}`,
				MIGRATIONS_DIR: resolve("drizzle"),
				BRAIN_PROVIDER: "codex-subscription",
				CODEX_MODEL: "gpt-5.6-luna",
				CODEX_EFFORT: "low",
				CODEX_HOME: codexHome,
				CODEX_CWD: promptDir,
				PROMPT_RUNTIME_DIR: promptDir,
				CODEX_TOOL_MODE: "envelope",
				CODEX_MAX_CONCURRENT_TURNS: "1",
				MAX_ACTIVE_CONVERSATIONS: "1",
				MAX_CONCURRENT_BRAIN_TURNS: "1",
				STT_PROVIDER: "openrouter",
				TTS_PROVIDER: "openrouter",
				OPENROUTER_API_KEY: "test-placeholder-not-a-secret",
				OPENROUTER_STT_AUDIO_FORMAT: "wav",
				OPENROUTER_STT_LANGUAGE: "ru",
				OPENROUTER_TTS_RESPONSE_FORMAT: "mp3",
				STT_TEXT_ONLY_INPUT_FALLBACK: "false",
				STORE_RAW_AUDIO: "false",
			},
			{ brain, stt, tts },
		);
		try {
			const ready = await runtime.readiness();
			expect(ready.status).toBe("ready");
			expect(ready.checks.map((check) => check.name)).toEqual([
				"database",
				"brain",
				"voice",
				"prompts",
				"notifier",
				"recovery",
				"capacity",
			]);
			const session = runtime.registry.create({
				source: "landing",
				locale: "ru-RU",
				qualificationEnabled: true,
				consent: { voiceProcessing: true, contactProcessing: true },
			});
			expect(session).not.toBeNull();
			const saturated = await runtime.readiness();
			expect(saturated.status).toBe("unready");
			expect(
				saturated.checks.find((check) => check.name === "capacity")?.status,
			).toBe("unready");
		} finally {
			await runtime.dispose();
		}
	});
});
