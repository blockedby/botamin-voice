import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	BrainDelta,
	BrainPort,
	BrainTurnInput,
	SttPort,
	TtsPort,
} from "@botamin/contracts";
import { websocket } from "hono/bun";
import type {
	CaptureAdapter,
	CaptureFactoryOptions,
	PlaybackAdapter,
} from "../../../web/src/integration/browserVoiceSession";
import { BrowserVoiceSession } from "../../../web/src/integration/browserVoiceSession";
import type { WebSocketLike } from "../../../web/src/transport/ws";
import { bunRequestBodyHardLimit, createServerApp } from "../app";
import { createProductionRuntime } from "./runtime";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const consent = {
	voiceProcessing: true,
	contactProcessing: true,
} as const;
const conversationRequest = {
	source: "landing",
	locale: "ru-RU",
	qualificationEnabled: true,
	consent,
} as const;
const safeFallback =
	"Сейчас не получается продолжить разговор. Данные ещё не были сохранены.";

class BrowserCapture implements CaptureAdapter {
	active = false;
	constructor(readonly options: CaptureFactoryOptions) {}
	async prepare(): Promise<void> {}
	configureLimits(): void {}
	async start(): Promise<void> {
		this.active = true;
	}
	async finish() {
		this.active = false;
		return { bytes: 3_200, durationMs: 100, limitedBy: null } as const;
	}
	async stop(): Promise<void> {
		this.active = false;
	}
	setMuted(): void {}
	setAccepting(): void {}
	get isActive(): boolean {
		return this.active;
	}
	emit(frame: Uint8Array): void {
		this.options.onFrame(frame);
	}
}

const playback: PlaybackAdapter = {
	resume: async () => undefined,
	beginGeneration: () => undefined,
	enqueue: async () => ({ status: "accepted" }),
	sealGeneration: () => true,
	requestReaction: () => false,
	cancelReaction: () => undefined,
	bargeIn: () => null,
	dispose: async () => undefined,
	activeGenerationId: null,
	bufferedSegmentCount: 0,
};

async function waitFor(
	predicate: () => boolean,
	message: string,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(10);
	}
}

describe("browser-to-production-runtime terminal ERROR cleanup", () => {
	test("maxActive=1 preserves fallback then stops and reclaims providers/capacity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-browser-runtime-"));
		directories.push(directory);
		const promptDir = join(directory, "brain");
		const codexHome = join(directory, "codex-home");
		await mkdir(promptDir, { recursive: true });
		await mkdir(codexHome, { recursive: true });
		const agents = join(promptDir, "AGENTS.md");
		await writeFile(agents, "# deterministic browser/runtime prompt\n", {
			mode: 0o444,
		});
		await chmod(agents, 0o444);

		const brainReleased: string[] = [];
		const brainInputs: BrainTurnInput[] = [];
		const brain: BrainPort & { close(): Promise<void> } = {
			createThread: async () => "fake-thread",
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				brainInputs.push(input);
				yield {
					type: "error",
					turnId: input.turnId,
					generationId: input.generationId,
					error: {
						code: "BRAIN_PROTOCOL_ERROR",
						message: "private fake brain failure",
						retryable: true,
					},
				};
			},
			interrupt: async () => undefined,
			releaseConversation: async (id) => {
				brainReleased.push(id);
			},
			health: async () => ({ status: "healthy" }),
			close: async () => undefined,
		};
		const sttConversations: string[] = [];
		const stt: SttPort = {
			transcribe: async (request) => {
				sttConversations.push(request.conversationId);
				return {
					conversationId: request.conversationId,
					turnId: request.turnId,
					text: "Сегодня воскресенье, предложи встречу на сегодня",
					final: true,
				};
			},
			health: async () => "ready",
		};
		const ttsReset: string[] = [];
		const tts: TtsPort & { readonly outputContentType: "audio/mpeg" } = {
			outputContentType: "audio/mpeg",
			synthesize: async () => {
				throw new Error("terminal brain fallback must not call TTS");
			},
			resetSession: (id) => {
				ttsReset.push(id);
			},
			health: async () => "ready",
		};
		const appOrigin = "http://localhost:5173";
		const runtime = await createProductionRuntime(
			{
				APP_ORIGIN: appOrigin,
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
				MAX_ACTIVE_CONVERSATIONS_PER_SOURCE: "1",
				MAX_CONCURRENT_BRAIN_TURNS: "1",
				MAX_PENDING_BRAIN_TURNS: "1",
				STT_PROVIDER: "openrouter",
				TTS_PROVIDER: "openrouter",
				OPENROUTER_API_KEY: "test-placeholder-not-a-secret",
				OPENROUTER_STT_AUDIO_FORMAT: "wav",
				OPENROUTER_STT_LANGUAGE: "ru",
				OPENROUTER_TTS_RESPONSE_FORMAT: "mp3",
				STT_TEXT_ONLY_INPUT_FALLBACK: "false",
				STORE_RAW_AUDIO: "false",
			},
			{
				brain,
				stt,
				tts,
				now: () => new Date("2099-01-08T09:00:00.000Z"),
			},
		);
		const app = createServerApp(runtime);
		const server = Bun.serve({
			port: 0,
			fetch: app.fetch,
			websocket,
			maxRequestBodySize: bunRequestBodyHardLimit(runtime.config),
		});
		const runtimeOrigin = `http://127.0.0.1:${server.port}`;
		const captures: BrowserCapture[] = [];
		const stopRequests: string[] = [];
		const runtimeFetch = async (input: string, init?: RequestInit) => {
			if (input.endsWith("/stop")) stopRequests.push(input);
			const headers = new Headers(init?.headers);
			headers.set("origin", appOrigin);
			return fetch(new URL(input, runtimeOrigin), { ...init, headers });
		};
		const browser = new BrowserVoiceSession({
			baseUrl: appOrigin,
			fetch: runtimeFetch,
			createSocket: (url) => {
				const target = new URL(url);
				target.protocol = "ws:";
				target.host = `127.0.0.1:${server.port}`;
				return new WebSocket(target, {
					headers: { Origin: appOrigin },
				} as never) as unknown as WebSocketLike;
			},
			createCapture: (options) => {
				const capture = new BrowserCapture(options);
				captures.push(capture);
				return capture;
			},
			createPlayback: () => playback,
		});

		try {
			expect(await browser.start(consent)).toBe(true);
			await waitFor(
				() => browser.getSnapshot().state.kind === "listening",
				"browser did not become ready",
			);

			const saturated = await runtimeFetch("/api/v1/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(conversationRequest),
			});
			expect(saturated.status).toBe(503);

			captures[0]?.emit(new Uint8Array(3_200));
			expect(await browser.commit()).toBe(true);
			await waitFor(
				() => browser.getSnapshot().transcript.at(-1)?.text === safeFallback,
				"safe fallback was not retained",
			);
			await waitFor(
				() => brainReleased.length === 1 && ttsReset.length === 1,
				"provider session cleanup was not called",
			);

			const failedConversationId = sttConversations[0];
			expect(failedConversationId).toBeDefined();
			if (!failedConversationId)
				throw new Error("missing failed conversation id");
			await waitFor(
				() => runtime.registry.get(failedConversationId) === null,
				"terminal session remained in the registry",
			);
			expect(stopRequests).toContain(
				`/api/v1/conversations/${failedConversationId}/stop`,
			);
			expect(browser.getSnapshot().state).toEqual({ kind: "error" });
			expect(
				browser
					.getSnapshot()
					.transcript.some(
						(entry) => entry.speaker === "agent" && entry.text === safeFallback,
					),
			).toBe(true);
			expect(brainReleased).toEqual([failedConversationId]);
			expect(ttsReset).toEqual([failedConversationId]);
			expect(brainInputs).toHaveLength(1);
			expect(brainInputs[0]).toMatchObject({
				userText: "Сегодня воскресенье, предложи встречу на сегодня",
				schedulingContext: {
					currentInstant: "2099-01-08T09:00:00.000Z",
					moscowLocalDate: "2099-01-08",
					moscowWeekday: "четверг",
					timeOfDayPreference: "none",
				},
			});
			expect(
				brainInputs[0]?.schedulingContext.candidateMeetingSlots.map(
					(candidate) => candidate.meetingSlot.startAt,
				),
			).toEqual(["2099-01-09T06:00:00.000Z", "2099-01-09T13:00:00.000Z"]);

			const replacement = await runtimeFetch("/api/v1/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(conversationRequest),
			});
			expect(replacement.status).toBe(201);
			const replacementBody = (await replacement.json()) as {
				conversationId: string;
			};
			await runtimeFetch(
				`/api/v1/conversations/${replacementBody.conversationId}/stop`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ reason: "client_error" }),
				},
			);
		} finally {
			await browser.dispose();
			server.stop(true);
			await runtime.dispose();
		}
	});
});
