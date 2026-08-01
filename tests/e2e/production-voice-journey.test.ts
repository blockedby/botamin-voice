import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Keep the integration harness outside the production workspace while using
// the exact Hono/Bun adapter version owned by @botamin/server.
// @ts-expect-error The version-pinned internal adapter path has no export declaration.
import { websocket } from "../../apps/server/node_modules/hono/dist/adapter/bun/index";
import {
	bunRequestBodyHardLimit,
	createServerApp,
} from "../../apps/server/src/app";
import {
	closeDomainDatabase,
	openDomainDatabase,
} from "../../apps/server/src/db";
import { SqliteBookingService } from "../../apps/server/src/domain/booking";
import type { NamedLeadNotifier } from "../../apps/server/src/notifiers/notifier";
import {
	loadOpenRouterVoiceConfig,
	OpenRouterCredentialHealth,
	OpenRouterSttAdapter,
} from "../../apps/server/src/providers/openrouter/stt";
import { OpenRouterTtsAdapter } from "../../apps/server/src/providers/openrouter/tts";
import { createProductionRuntime } from "../../apps/server/src/runtime/runtime";
import type {
	CaptureAdapter,
	CaptureFactoryOptions,
	PlaybackAdapter,
	PlaybackFactoryOptions,
} from "../../apps/web/src/integration/browserVoiceSession";
import { BrowserVoiceSession } from "../../apps/web/src/integration/browserVoiceSession";
import type { WebSocketLike } from "../../apps/web/src/transport/ws";
import type {
	BrainDelta,
	BrainPort,
	BrainTurnInput,
	CreateBookingInput,
} from "../../packages/contracts/src";
import {
	createDeterministicMp3Fixture,
	createDeterministicPcm16Fixture,
	createDeterministicWavFixture,
	createOpenRouterFixture,
	createTestBookingContacts,
} from "../../packages/test-fixtures/src";

const appOrigin = "http://localhost:5173";
const apiKey = "credential-free-fixture-key";
const consent = { voiceProcessing: true, contactProcessing: true } as const;

type TimelineLabel =
	| "audio.commit.client-send"
	| "stt.provider.request"
	| "stt.provider.complete"
	| "transcript.final.client-receipt"
	| "brain.delta.first"
	| "tts.provider.request"
	| "tts.provider.complete"
	| "audio.metadata.client-receipt"
	| "audio.binary.client-receipt"
	| "audio.segment.client-paired"
	| "playback.started"
	| "playback.completed";

interface TimelineEntry {
	label: TimelineLabel;
	at: number;
}

function chatResult(text: string): Record<string, unknown> {
	return {
		id: "chatcmpl-t30-fixture",
		object: "chat.completion",
		created: 1,
		model: "openai/gpt-audio-mini",
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				message: { role: "assistant", content: text },
			},
		],
	};
}

function countSpeaker(
	session: BrowserVoiceSession,
	speaker: "visitor" | "agent",
): number {
	return session
		.getSnapshot()
		.transcript.filter((entry) => entry.speaker === speaker).length;
}

async function waitFor(
	predicate: () => boolean,
	message: string | (() => string),
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(typeof message === "string" ? message : message());
		}
		await Bun.sleep(5);
	}
}

class FixtureCapture implements CaptureAdapter {
	active = false;
	constructor(private readonly options: CaptureFactoryOptions) {}
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
	emit(): void {
		this.options.onFrame(createDeterministicPcm16Fixture());
	}
}

class VerifyingPlayback implements PlaybackAdapter {
	activeGenerationId: string | null = null;
	bufferedSegmentCount = 0;
	readonly received: Uint8Array[] = [];
	readonly staleGenerations = new Set<string>();

	constructor(
		private readonly options: PlaybackFactoryOptions,
		private readonly timeline: TimelineEntry[],
	) {}

	beginGeneration(generationId: string): void {
		if (this.staleGenerations.has(generationId)) return;
		this.activeGenerationId = generationId;
	}

	async enqueue(segment: Parameters<PlaybackAdapter["enqueue"]>[0]) {
		if (
			this.activeGenerationId !== segment.generationId ||
			this.staleGenerations.has(segment.generationId)
		) {
			return false;
		}
		this.bufferedSegmentCount = 1;
		this.received.push(segment.bytes.slice());
		this.timeline.push({
			label: "audio.segment.client-paired",
			at: performance.now(),
		});
		this.timeline.push({ label: "playback.started", at: performance.now() });
		this.options.onStarted(segment);
		// Model real playback long enough for the already-buffered text/audio-done
		// events to arrive before the queue reports idle.
		await Bun.sleep(100);
		if (this.activeGenerationId !== segment.generationId) return false;
		this.bufferedSegmentCount = 0;
		this.activeGenerationId = null;
		this.timeline.push({ label: "playback.completed", at: performance.now() });
		this.options.onIdle(segment.generationId);
		return true;
	}

	bargeIn(): string | null {
		const generationId = this.activeGenerationId;
		if (generationId) this.staleGenerations.add(generationId);
		this.activeGenerationId = null;
		this.bufferedSegmentCount = 0;
		return generationId;
	}

	async dispose(): Promise<void> {
		this.bargeIn();
	}
}

class ObservedSocket implements WebSocketLike {
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly native: WebSocket;

	constructor(
		url: string,
		private readonly timeline: TimelineEntry[],
		private readonly eventCounts: Map<string, number>,
		private readonly stages: string[],
		private readonly errorCodes: string[],
	) {
		const target = new URL(url);
		target.protocol = "ws:";
		this.native = new WebSocket(target, {
			headers: { Origin: appOrigin },
		} as never);
		this.native.onopen = () => this.onopen?.();
		this.native.onclose = () => this.onclose?.();
		this.native.onerror = (event) => this.onerror?.(event);
		this.native.onmessage = (event) => {
			if (typeof event.data !== "string") {
				this.timeline.push({
					label: "audio.binary.client-receipt",
					at: performance.now(),
				});
			}
			if (typeof event.data === "string") {
				try {
					const message = JSON.parse(event.data) as {
						type?: string;
						payload?: { to?: string; code?: string };
					};
					if (message.type) {
						this.eventCounts.set(
							message.type,
							(this.eventCounts.get(message.type) ?? 0) + 1,
						);
						if (message.type === "transcript.final") {
							this.timeline.push({
								label: "transcript.final.client-receipt",
								at: performance.now(),
							});
						}
						if (message.type === "audio.segment") {
							this.timeline.push({
								label: "audio.metadata.client-receipt",
								at: performance.now(),
							});
						}
						if (message.type === "state.changed" && message.payload?.to) {
							this.stages.push(message.payload.to);
						}
						if (message.type === "error" && message.payload?.code) {
							this.errorCodes.push(message.payload.code);
						}
					}
				} catch {
					// The production transport performs authoritative schema validation.
				}
			}
			this.onmessage?.({ data: event.data });
		};
	}

	get readyState(): number {
		return this.native.readyState;
	}
	get binaryType(): BinaryType {
		return this.native.binaryType;
	}
	set binaryType(value: BinaryType) {
		this.native.binaryType = value;
	}
	send(data: string | Uint8Array): void {
		if (typeof data === "string") {
			try {
				if ((JSON.parse(data) as { type?: string }).type === "audio.commit") {
					this.timeline.push({
						label: "audio.commit.client-send",
						at: performance.now(),
					});
				}
			} catch {
				// The production server rejects malformed client JSON.
			}
		}
		this.native.send(data);
	}
	close(code?: number, reason?: string): void {
		this.native.close(code, reason);
	}
}

class ScriptedLuna implements BrainPort {
	readonly inputs: BrainTurnInput[] = [];
	readonly qualificationToolStages: string[] = [];
	bookingInput: CreateBookingInput | null = null;
	interrupts = 0;

	constructor(private readonly timeline: TimelineEntry[]) {}

	async createThread(): Promise<string> {
		return "credential-free-luna-thread";
	}

	async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
		this.inputs.push(input);
		let firstDelta = true;
		const observed = (delta: BrainDelta): BrainDelta => {
			if (firstDelta) {
				firstDelta = false;
				this.timeline.push({
					label: "brain.delta.first",
					at: performance.now(),
				});
			}
			return delta;
		};
		const complete = (nextStage?: BrainTurnInput["stage"]): BrainDelta => ({
			type: "turn.completed",
			turnId: input.turnId,
			generationId: input.generationId,
			...(nextStage ? { nextStage } : {}),
		});
		const speech = (text: string): BrainDelta => ({
			type: "speech.delta",
			turnId: input.turnId,
			generationId: input.generationId,
			text,
		});

		switch (input.stage) {
			case "GREETING":
				yield observed(speech("Короткий тестовый ответ."));
				yield complete("DISCOVERY");
				return;
			case "DISCOVERY":
				yield observed(speech("Обсудим задачу."));
				yield complete("BOOKING_OFFER");
				return;
			case "BOOKING_OFFER":
				yield observed(speech("Соберём минимальные данные."));
				yield complete("COLLECT_BOOKING");
				return;
			case "COLLECT_BOOKING": {
				const args: CreateBookingInput = {
					conversationId: input.conversationId,
					idempotencyKey: "t30-booking-idempotency-key",
					name: "Тестовый лид",
					contacts: createTestBookingContacts(),
					company: "Example LLC",
					meetingSlot:
						input.schedulingContext.candidateMeetingSlots[0].meetingSlot,
					consentConfirmed: true,
				};
				this.bookingInput = args;
				const request: BrainDelta = {
					type: "tool.request",
					turnId: input.turnId,
					generationId: input.generationId,
					tool: {
						name: "create_booking",
						callId: "t30-create-booking-call",
						args,
					},
				};
				yield observed(request);
				// Same call and payload is a deterministic model/provider replay.
				yield request;
				yield complete("BOOKED");
				return;
			}
			case "BOOKED":
				yield observed(
					speech("Дополнительный вопрос только после сохранения."),
				);
				yield complete("POST_BOOKING_QUALIFICATION");
				return;
			case "POST_BOOKING_QUALIFICATION": {
				this.qualificationToolStages.push(input.stage);
				if (!input.booking)
					throw new Error("booking must precede qualification");
				yield observed({
					type: "tool.request",
					turnId: input.turnId,
					generationId: input.generationId,
					tool: {
						name: "append_booking_qualification",
						callId: "t30-qualification-call",
						args: {
							bookingId: input.booking.id,
							idempotencyKey: "t30-qualification-idempotency-key",
							patch: { monthlyLeadVolume: "около 240" },
							completion: "complete",
						},
					},
				});
				yield complete("COMPLETE");
				return;
			}
			default:
				yield observed(complete());
		}
	}

	async interrupt(): Promise<void> {
		this.interrupts += 1;
	}
	async releaseConversation(): Promise<void> {}
	async health() {
		return { status: "healthy" as const };
	}
	async close(): Promise<void> {}
}

class RecordingNotifier implements NamedLeadNotifier {
	readonly kind = "console" as const;
	readonly eventTypes: string[] = [];
	async publish(event: Parameters<NamedLeadNotifier["publish"]>[0]) {
		this.eventTypes.push(event.type);
	}
}

function occurrence(
	entries: TimelineEntry[],
	label: TimelineLabel,
	nth: number,
) {
	return entries.filter((entry) => entry.label === label)[nth - 1]?.at;
}

function createBrowserHarness(
	runtimeOrigin: string,
	timeline: TimelineEntry[],
	conversationIds: string[],
) {
	const captures: FixtureCapture[] = [];
	const sockets: ObservedSocket[] = [];
	const playbacks: VerifyingPlayback[] = [];
	const eventCounts = new Map<string, number>();
	const stages: string[] = [];
	const errorCodes: string[] = [];
	const runtimeFetch = async (input: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.set("origin", appOrigin);
		const response = await fetch(new URL(input, runtimeOrigin), {
			...init,
			headers,
		});
		if (input === "/api/v1/conversations" && response.status === 201) {
			const body = (await response.clone().json()) as {
				conversationId: string;
			};
			conversationIds.push(body.conversationId);
		}
		return response;
	};
	const browser = new BrowserVoiceSession({
		baseUrl: appOrigin,
		fetch: runtimeFetch,
		createSocket: (url) => {
			const target = new URL(url);
			target.host = new URL(runtimeOrigin).host;
			const socket = new ObservedSocket(
				target.toString(),
				timeline,
				eventCounts,
				stages,
				errorCodes,
			);
			sockets.push(socket);
			return socket;
		},
		createCapture: (options) => {
			const capture = new FixtureCapture(options);
			captures.push(capture);
			return capture;
		},
		createPlayback: (options) => {
			const adapter = new VerifyingPlayback(options, timeline);
			playbacks.push(adapter);
			return adapter;
		},
		reconnectScheduler: {
			schedule: (callback) => setTimeout(callback, 0),
			cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
	});
	return {
		browser,
		captures,
		sockets,
		playbacks,
		eventCounts,
		stages,
		errorCodes,
	};
}

async function commitCurrent(
	browser: BrowserVoiceSession,
	captures: FixtureCapture[],
): Promise<void> {
	await waitFor(
		() => captures.at(-1)?.active === true,
		"browser capture was not active",
	);
	captures.at(-1)?.emit();
	expect(await browser.commit()).toBe(true);
}

describe("T30 consolidated credential-free production-component journey", () => {
	test("browser, gateway, OpenRouter adapters, Luna port, SQLite and MP3 pairing preserve all invariants", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-t30-e2e-"));
		const databasePath = join(directory, "data", "app.db");
		const promptDir = join(directory, "brain");
		const codexHome = join(directory, "codex-home");
		await mkdir(promptDir, { recursive: true });
		await mkdir(codexHome, { recursive: true });
		const prompt = join(promptDir, "AGENTS.md");
		await writeFile(prompt, "# deterministic T30 integration prompt\n", {
			mode: 0o444,
		});
		await chmod(prompt, 0o444);

		let releaseStaleTts = (): void => undefined;
		const staleTtsGate = new Promise<void>((resolve) => {
			releaseStaleTts = resolve;
		});
		const timeline: TimelineEntry[] = [];
		const provider = createOpenRouterFixture({
			expectedWav: createDeterministicWavFixture(),
			expectedApiKey: apiKey,
			expectedSttModel: "openai/gpt-audio-mini",
			expectedTts: {
				model: "x-ai/grok-voice-tts-1.0",
				voice: "eve",
				responseFormat: "mp3",
			},
			chatBehaviors: [
				{ jsonBody: chatResult("Первая тестовая реплика") },
				{ status: 503, retryAfter: "0" },
				{ jsonBody: chatResult("Нужна автоматизация обращений") },
				{ jsonBody: chatResult("Да, расскажите о записи") },
				{ jsonBody: chatResult("Контакт подтверждён") },
				{ jsonBody: chatResult("Да, можно") },
				{ jsonBody: chatResult("Дополнительный ответ") },
				{ status: 400 },
			],
			ttsBehaviors: [
				{ waitFor: staleTtsGate },
				{ responseChunkBytes: 97 },
				{},
				{ status: 503 },
				{},
			],
			onRequest: ({ endpoint }) => {
				timeline.push({
					label:
						endpoint === "chat"
							? "stt.provider.request"
							: "tts.provider.request",
					at: performance.now(),
				});
			},
		});
		const providerServer = provider.startServer();
		const runtimeEnv = {
			APP_ORIGIN: appOrigin,
			AUTO_MIGRATE: "true",
			DATABASE_URL: `file:${databasePath}`,
			MIGRATIONS_DIR: resolve("drizzle"),
			BRAIN_PROVIDER: "codex-subscription",
			CODEX_MODEL: "gpt-5.6-luna",
			CODEX_EFFORT: "low",
			CODEX_HOME: codexHome,
			CODEX_CWD: promptDir,
			PROMPT_RUNTIME_DIR: promptDir,
			CODEX_TOOL_MODE: "envelope",
			CODEX_MAX_CONCURRENT_TURNS: "2",
			MAX_ACTIVE_CONVERSATIONS: "2",
			MAX_ACTIVE_CONVERSATIONS_PER_SOURCE: "2",
			MAX_CONCURRENT_BRAIN_TURNS: "2",
			MAX_PENDING_BRAIN_TURNS: "2",
			MAX_CONVERSATION_CREATES_PER_SOURCE: "10",
			STT_PROVIDER: "openrouter",
			TTS_PROVIDER: "openrouter",
			OPENROUTER_API_KEY: apiKey,
			OPENROUTER_BASE_URL: `http://127.0.0.1:${providerServer.port}/api/v1`,
			OPENROUTER_STT_AUDIO_FORMAT: "wav",
			OPENROUTER_STT_LANGUAGE: "ru",
			OPENROUTER_TTS_RESPONSE_FORMAT: "mp3",
			STT_RETRY_BASE_MS: "0",
			STT_MAX_RETRIES: "1",
			TTS_RETRY_BASE_MS: "0",
			TTS_MAX_RETRIES: "0",
			TTS_TEXT_ONLY_FALLBACK: "true",
			STT_TEXT_ONLY_INPUT_FALLBACK: "false",
			STORE_RAW_AUDIO: "false",
		};
		const voiceConfig = loadOpenRouterVoiceConfig(runtimeEnv);
		const credentialHealth = new OpenRouterCredentialHealth();
		const stt = new OpenRouterSttAdapter({
			config: voiceConfig,
			credentialHealth,
			telemetry: (event) => {
				if (event.status === 200) {
					timeline.push({
						label: "stt.provider.complete",
						at: performance.now(),
					});
				}
			},
		});
		const tts = new OpenRouterTtsAdapter({
			config: voiceConfig,
			credentialHealth,
			telemetry: (event) => {
				if (event.status === 200 && event.outcome === "success") {
					timeline.push({
						label: "tts.provider.complete",
						at: performance.now(),
					});
				}
			},
		});
		const brain = new ScriptedLuna(timeline);
		const notifier = new RecordingNotifier();
		const runtime = await createProductionRuntime(runtimeEnv, {
			brain,
			stt,
			tts,
			notifier,
			outboxPollIntervalMs: 5,
			retentionIntervalMs: 60_000,
		});
		const app = createServerApp(runtime);
		const server = Bun.serve({
			port: 0,
			fetch: app.fetch,
			websocket,
			maxRequestBodySize: bunRequestBodyHardLimit(runtime.config),
		});
		const runtimeOrigin = `http://127.0.0.1:${server.port}`;
		const conversationIds: string[] = [];
		const happy = createBrowserHarness(
			runtimeOrigin,
			timeline,
			conversationIds,
		);
		let failed: ReturnType<typeof createBrowserHarness> | undefined;

		try {
			expect((await runtime.readiness()).status).toBe("ready");
			expect(await happy.browser.start(consent)).toBe(true);
			await waitFor(
				() => happy.browser.getSnapshot().state.kind === "listening",
				"browser did not reach listening",
			);

			// Turn 1 starts real adapter TTS, then browser barge-in makes it stale.
			await commitCurrent(happy.browser, happy.captures);
			await waitFor(
				() => provider.counters.tts === 1 && brain.inputs.length === 1,
				"first TTS request did not start",
			);
			expect(countSpeaker(happy.browser, "visitor")).toBe(1);
			happy.browser.interrupt();
			releaseStaleTts();
			await waitFor(
				() => happy.captures.at(-1)?.active === true,
				"capture did not restart after barge-in",
			);
			await Bun.sleep(20);
			expect(happy.playbacks.flatMap((item) => item.received)).toHaveLength(0);

			// Turn 2 retries only STT, then sends one complete canonical MP3.
			await commitCurrent(happy.browser, happy.captures);
			await waitFor(
				() =>
					countSpeaker(happy.browser, "visitor") === 2 &&
					countSpeaker(happy.browser, "agent") === 1 &&
					happy.captures.at(-1)?.active === true,
				() =>
					`retry turn did not finish (state=${happy.browser.getSnapshot().state.kind}, visitor=${countSpeaker(happy.browser, "visitor")}, agent=${countSpeaker(happy.browser, "agent")}, chat=${provider.counters.chat}, tts=${provider.counters.tts}, brain=${brain.inputs.length}, capture=${happy.captures.at(-1)?.active === true}, events=${JSON.stringify(Object.fromEntries(happy.eventCounts))})`,
			);
			expect(provider.counters.chat).toBe(3);
			expect(brain.inputs).toHaveLength(2);

			await commitCurrent(happy.browser, happy.captures);
			await waitFor(
				() =>
					countSpeaker(happy.browser, "visitor") === 3 &&
					countSpeaker(happy.browser, "agent") === 2 &&
					happy.captures.at(-1)?.active === true,
				"booking-offer turn did not finish",
			);

			// Booking turn: one commit/final/brain, duplicate model call replay,
			// one durable booking, and unavailable TTS with retained visible text.
			const commitsBeforeBooking = timeline.filter(
				(entry) => entry.label === "audio.commit.client-send",
			).length;
			const finalsBeforeBooking = countSpeaker(happy.browser, "visitor");
			const brainsBeforeBooking = brain.inputs.length;
			const agentsBeforeBooking = countSpeaker(happy.browser, "agent");
			const errorsBeforeBooking = happy.eventCounts.get("error") ?? 0;
			const audioDoneBeforeBooking =
				happy.eventCounts.get("assistant.audio.done") ?? 0;
			await commitCurrent(happy.browser, happy.captures);
			expect(await happy.browser.commit()).toBe(false);
			await waitFor(
				() =>
					countSpeaker(happy.browser, "visitor") === finalsBeforeBooking + 1 &&
					countSpeaker(happy.browser, "agent") === agentsBeforeBooking + 1 &&
					brain.bookingInput !== null,
				"booking turn did not retain text after TTS failure",
			);
			expect(
				timeline.filter((entry) => entry.label === "audio.commit.client-send")
					.length - commitsBeforeBooking,
			).toBe(1);
			expect(countSpeaker(happy.browser, "visitor") - finalsBeforeBooking).toBe(
				1,
			);
			expect(brain.inputs.length - brainsBeforeBooking).toBe(1);
			expect(happy.eventCounts.get("booking.created")).toBe(1);
			expect((happy.eventCounts.get("error") ?? 0) - errorsBeforeBooking).toBe(
				1,
			);
			expect(happy.errorCodes.at(-1)).toBe("TTS_UNAVAILABLE");
			expect(
				(happy.eventCounts.get("assistant.audio.done") ?? 0) -
					audioDoneBeforeBooking,
			).toBe(0);
			expect(happy.browser.getSnapshot().state).toMatchObject({
				kind: "listening",
				bookingOutcome: "committed",
			});
			expect(happy.captures.at(-1)?.active).toBe(true);

			// Force a real WebSocket reconnect after the durable booking.
			const transcriptsBeforeReconnect =
				happy.browser.getSnapshot().transcript.length;
			const socketsBeforeReconnect = happy.sockets.length;
			happy.sockets.at(-1)?.native.close(4000, "t30 reconnect");
			await waitFor(
				() =>
					happy.sockets.length === socketsBeforeReconnect + 1 &&
					happy.browser.getSnapshot().state.kind === "listening",
				"browser did not resume the booked conversation",
			);
			expect(happy.browser.getSnapshot().transcript).toHaveLength(
				transcriptsBeforeReconnect,
			);

			// Explicit consent enters qualification only after BOOKED.
			await commitCurrent(happy.browser, happy.captures);
			await waitFor(
				() =>
					countSpeaker(happy.browser, "visitor") === 5 &&
					happy.captures.at(-1)?.active === true,
				() =>
					`post-booking consent turn did not finish (state=${happy.browser.getSnapshot().state.kind}, visitor=${countSpeaker(happy.browser, "visitor")}, agent=${countSpeaker(happy.browser, "agent")}, chat=${provider.counters.chat}, tts=${provider.counters.tts}, brain=${brain.inputs.length}, capture=${happy.captures.at(-1)?.active === true}, events=${JSON.stringify(Object.fromEntries(happy.eventCounts))})`,
			);
			await commitCurrent(happy.browser, happy.captures);
			await waitFor(
				() => happy.browser.getSnapshot().state.kind === "complete",
				"qualification did not complete",
			);
			expect(brain.qualificationToolStages).toEqual([
				"POST_BOOKING_QUALIFICATION",
			]);
			expect(countSpeaker(happy.browser, "visitor")).toBe(6);
			expect(brain.inputs).toHaveLength(6);
			expect(provider.counters.chat).toBe(7);
			expect(happy.stages).toEqual(
				expect.arrayContaining([
					"DISCOVERY",
					"BOOKING_OFFER",
					"COLLECT_BOOKING",
					"BOOKED",
					"POST_BOOKING_QUALIFICATION",
					"COMPLETE",
				]),
			);

			await waitFor(
				() => notifier.eventTypes.length === 2,
				"outbox did not deliver booking events",
			);
			const database = openDomainDatabase({ filename: databasePath });
			try {
				const bookingRows = database.$client
					.query<
						{
							id: string;
							conversation_id: string;
							qualification_status: string;
						},
						[]
					>("SELECT id, conversation_id, qualification_status FROM bookings")
					.all();
				expect(bookingRows).toHaveLength(1);
				expect(bookingRows[0]).toMatchObject({
					conversation_id: conversationIds[0],
					qualification_status: "complete",
				});
				const outbox = database.$client
					.query<{ type: string; status: string; attempt_count: number }, []>(
						`SELECT domain_events.type, notification_outbox.status,
						        notification_outbox.attempt_count
						 FROM notification_outbox
						 JOIN domain_events ON domain_events.id = notification_outbox.event_id
						 ORDER BY domain_events.type`,
					)
					.all();
				expect(outbox).toEqual([
					{ type: "booking.created", status: "sent", attempt_count: 1 },
					{ type: "booking.updated", status: "sent", attempt_count: 1 },
				]);
				const replay = await new SqliteBookingService(database).createBooking(
					brain.bookingInput as CreateBookingInput,
				);
				expect(replay).toMatchObject({
					created: false,
					bookingId: bookingRows[0]?.id,
				});
				expect(
					database.$client.query("SELECT id FROM bookings").all(),
				).toHaveLength(1);
			} finally {
				closeDomainDatabase(database);
			}

			// A fresh production session receives a typed STT failure: no final,
			// Luna turn, tool, booking, TTS request, or fabricated browser text.
			const brainRunsBeforeFailure = brain.inputs.length;
			const ttsBeforeFailure = provider.counters.tts;
			failed = createBrowserHarness(runtimeOrigin, timeline, conversationIds);
			expect(await failed.browser.start(consent)).toBe(true);
			await waitFor(
				() => failed?.browser.getSnapshot().state.kind === "listening",
				"failure session did not become ready",
			);
			await commitCurrent(failed.browser, failed.captures);
			await waitFor(
				() => (failed?.eventCounts.get("error") ?? 0) >= 1,
				"STT failure did not reach the safe browser error",
			);
			expect(failed.errorCodes).toContain("STT_UNAVAILABLE");
			expect(countSpeaker(failed.browser, "visitor")).toBe(0);
			expect(countSpeaker(failed.browser, "agent")).toBe(0);
			expect(brain.inputs).toHaveLength(brainRunsBeforeFailure);
			expect(provider.counters.tts).toBe(ttsBeforeFailure);
			const afterFailure = openDomainDatabase({ filename: databasePath });
			try {
				expect(
					afterFailure.$client.query("SELECT id FROM bookings").all(),
				).toHaveLength(1);
				expect(
					afterFailure.$client
						.query(
							"SELECT id FROM domain_events WHERE type = 'booking.created'",
						)
						.all(),
				).toHaveLength(1);
			} finally {
				closeDomainDatabase(afterFailure);
			}
			expect(provider.protocolViolations).toEqual([]);
			expect(provider.counters.invalid).toBe(0);

			const mp3 = createDeterministicMp3Fixture();
			const receivedAudio = happy.playbacks.flatMap((item) => item.received);
			expect(receivedAudio.length).toBeGreaterThanOrEqual(3);
			for (const bytes of receivedAudio) expect(bytes).toEqual(mp3);

			// Separate measured boundaries are all observed on the successful
			// retry turn, without asserting local fixture latency as a release SLO.
			const requireTiming = (label: TimelineLabel, nth: number): number => {
				const value = occurrence(timeline, label, nth);
				expect(value).toBeDefined();
				if (value === undefined) throw new Error("missing timing boundary");
				return value;
			};
			const commitAt = requireTiming("audio.commit.client-send", 2);
			const firstSttRequestAt = requireTiming("stt.provider.request", 2);
			const retrySttRequestAt = requireTiming("stt.provider.request", 3);
			const sttCompleteAt = requireTiming("stt.provider.complete", 2);
			const finalReceiptAt = requireTiming(
				"transcript.final.client-receipt",
				2,
			);
			const brainDeltaAt = requireTiming("brain.delta.first", 2);
			const ttsRequestAt = requireTiming("tts.provider.request", 2);
			const ttsCompleteAt = requireTiming("tts.provider.complete", 1);
			const metadataReceiptAt = requireTiming(
				"audio.metadata.client-receipt",
				1,
			);
			const binaryReceiptAt = requireTiming("audio.binary.client-receipt", 1);
			const pairedAt = requireTiming("audio.segment.client-paired", 1);
			const playbackStartedAt = requireTiming("playback.started", 1);
			const playbackCompletedAt = requireTiming("playback.completed", 1);
			const duration = (start: number, end: number): number => {
				const measured = end - start;
				expect(measured).toBeGreaterThanOrEqual(0);
				return measured;
			};
			duration(commitAt, firstSttRequestAt);
			duration(firstSttRequestAt, retrySttRequestAt);
			duration(retrySttRequestAt, sttCompleteAt);
			// Gateway delivery and Luna consumption race after the provider final;
			// they are separate honest boundaries rather than a fabricated order.
			duration(sttCompleteAt, finalReceiptAt);
			duration(sttCompleteAt, brainDeltaAt);
			duration(brainDeltaAt, ttsRequestAt);
			duration(ttsRequestAt, ttsCompleteAt);
			duration(ttsCompleteAt, metadataReceiptAt);
			duration(metadataReceiptAt, binaryReceiptAt);
			duration(binaryReceiptAt, pairedAt);
			duration(pairedAt, playbackStartedAt);
			expect(
				duration(playbackStartedAt, playbackCompletedAt),
			).toBeGreaterThanOrEqual(80);
		} finally {
			await failed?.browser.dispose();
			await happy.browser.dispose();
			server.stop(true);
			await runtime.dispose();
			provider.stop();
			await rm(directory, { recursive: true, force: true });
		}
	}, 20_000);
});
