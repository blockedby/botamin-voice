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
import { createProductionRuntime } from "./runtime";

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
