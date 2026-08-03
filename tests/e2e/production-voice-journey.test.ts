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
	MeetingSlot,
	TtsPort,
} from "../../packages/contracts/src";
import {
	createDeterministicMp3Fixture,
	createDeterministicPcm16Fixture,
	createDeterministicWavFixture,
	createOpenRouterFixture,
} from "../../packages/test-fixtures/src";

const appOrigin = "http://localhost:5173";
const apiKey = "credential-free-fixture-key";
const consent = { voiceProcessing: true, contactProcessing: true } as const;
const syntheticBooking = {
	name: "Анна-Мария Орлова",
	company: "ООО «Ромашка 24»",
	workEmail: "anna.orlova@example.com",
	telegram: "@fixture",
} as const;
const retryTurnSpeech = "Обсудим задачу.";
const syntheticBookingTurn = [
	`Имя: ${syntheticBooking.name}`,
	`Company — ${syntheticBooking.company}`,
	`Рабочий email: ${syntheticBooking.workEmail}`,
	`Telegram: ${syntheticBooking.telegram}`,
	"Первый вариант.",
].join("\n");

type TimelineLabel =
	| "audio.commit.client-send"
	| "stt.provider.request"
	| "stt.provider.complete"
	| "transcript.final.client-receipt"
	| "brain.delta.first"
	| "tts.provider.request"
	| "tts.provider.complete"
	| "tts.retry-turn.complete"
	| "audio.metadata.client-receipt"
	| "audio.binary.client-receipt"
	| "audio.segment.client-paired"
	| "playback.started"
	| "playback.completed";

interface TimelineEntry {
	label: TimelineLabel;
	at: number;
	generationId?: string;
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

function latestSpeakerText(
	session: BrowserVoiceSession,
	speaker: "visitor" | "agent",
): string | undefined {
	return session
		.getSnapshot()
		.transcript.filter((entry) => entry.speaker === speaker)
		.at(-1)?.text;
}

function moscowSlotText(slot: MeetingSlot): string {
	const local = new Date(new Date(slot.startAt).getTime() + 3 * 60 * 60_000);
	const date = new Intl.DateTimeFormat("ru-RU", {
		day: "2-digit",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(local);
	const time = `${String(local.getUTCHours()).padStart(2, "0")}:${String(
		local.getUTCMinutes(),
	).padStart(2, "0")}`;
	return `${date} в ${time} по Москве`;
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
	private started = false;
	private sealed = false;

	constructor(
		private readonly options: PlaybackFactoryOptions,
		private readonly timeline: TimelineEntry[],
	) {}

	async resume(): Promise<void> {}

	beginGeneration(generationId: string): void {
		if (this.staleGenerations.has(generationId)) return;
		if (this.activeGenerationId !== generationId) {
			this.bufferedSegmentCount = 0;
			this.started = false;
			this.sealed = false;
		}
		this.activeGenerationId = generationId;
	}

	async enqueue(segment: Parameters<PlaybackAdapter["enqueue"]>[0]) {
		if (
			this.activeGenerationId !== segment.generationId ||
			this.staleGenerations.has(segment.generationId) ||
			this.sealed
		) {
			return {
				status: "rejected" as const,
				reason: "stale" as const,
				error: new Error("Audio segment is stale"),
			};
		}
		this.bufferedSegmentCount += 1;
		this.received.push(segment.bytes.slice());
		this.timeline.push({
			label: "audio.segment.client-paired",
			at: performance.now(),
			generationId: segment.generationId,
		});
		if (!this.started) {
			this.started = true;
			this.timeline.push({
				label: "playback.started",
				at: performance.now(),
				generationId: segment.generationId,
			});
			this.options.onStarted(segment);
		}
		return { status: "accepted" as const };
	}

	sealGeneration(generationId: string): boolean {
		if (this.activeGenerationId !== generationId) return false;
		this.sealed = true;
		// The fixture deterministically drives the real queue's seal/end boundary:
		// every scheduled phrase ends in order only after the server seals it.
		this.bufferedSegmentCount = 0;
		this.activeGenerationId = null;
		this.timeline.push({
			label: "playback.completed",
			at: performance.now(),
			generationId,
		});
		this.options.onIdle(generationId);
		return true;
	}

	bargeIn(): string | null {
		const generationId = this.activeGenerationId;
		if (generationId) this.staleGenerations.add(generationId);
		this.activeGenerationId = null;
		this.bufferedSegmentCount = 0;
		this.started = false;
		this.sealed = false;
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
	private readonly pendingAudioGenerations: string[] = [];

	constructor(
		url: string,
		private readonly timeline: TimelineEntry[],
		private readonly eventCounts: Map<string, number>,
		private readonly eventSequences: Map<string, Set<number>>,
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
				const generationId = this.pendingAudioGenerations.shift();
				this.timeline.push({
					label: "audio.binary.client-receipt",
					at: performance.now(),
					...(generationId ? { generationId } : {}),
				});
			}
			if (typeof event.data === "string") {
				try {
					const message = JSON.parse(event.data) as {
						type?: string;
						seq?: number;
						payload?: { to?: string; code?: string; generationId?: string };
					};
					if (message.type) {
						this.eventCounts.set(
							message.type,
							(this.eventCounts.get(message.type) ?? 0) + 1,
						);
						if (message.seq !== undefined) {
							const sequences =
								this.eventSequences.get(message.type) ?? new Set<number>();
							sequences.add(message.seq);
							this.eventSequences.set(message.type, sequences);
						}
						if (message.type === "transcript.final") {
							this.timeline.push({
								label: "transcript.final.client-receipt",
								at: performance.now(),
							});
						}
						if (message.type === "audio.segment") {
							const generationId = message.payload?.generationId;
							if (generationId) {
								this.pendingAudioGenerations.push(generationId);
							}
							this.timeline.push({
								label: "audio.metadata.client-receipt",
								at: performance.now(),
								...(generationId ? { generationId } : {}),
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
				yield observed(speech(retryTurnSpeech));
				yield complete("BOOKING_OFFER");
				return;
			case "BOOKING_OFFER":
				yield observed(speech("Соберём минимальные данные."));
				yield complete("COLLECT_BOOKING");
				return;
			case "COLLECT_BOOKING":
			case "BOOKED":
			case "POST_BOOKING_QUALIFICATION":
				throw new Error(
					"RC4 booking confirmation and qualification must remain server-owned",
				);
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
	const eventSequences = new Map<string, Set<number>>();
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
				eventSequences,
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
		eventSequences,
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
		const ttsAdapter = new OpenRouterTtsAdapter({
			config: voiceConfig,
			credentialHealth,
		});
		const tts: TtsPort = {
			async synthesize(request) {
				const segment = await ttsAdapter.synthesize(request);
				timeline.push({
					label:
						request.text === retryTurnSpeech
							? "tts.retry-turn.complete"
							: "tts.provider.complete",
					at: performance.now(),
					generationId: request.generationId,
				});
				return segment;
			},
			resetSession: (conversationId) => ttsAdapter.resetSession(conversationId),
			health: () => ttsAdapter.health(),
		};
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

			// RC4 accepts the visitor's exact current draft facts and selection, then
			// authors the confirmation itself. The retained text survives unavailable TTS.
			const commitsBeforeBooking = timeline.filter(
				(entry) => entry.label === "audio.commit.client-send",
			).length;
			const finalsBeforeBooking = countSpeaker(happy.browser, "visitor");
			const brainsBeforeBooking = brain.inputs.length;
			const agentsBeforeBooking = countSpeaker(happy.browser, "agent");
			const errorsBeforeBooking = happy.eventCounts.get("error") ?? 0;
			const audioDoneBeforeBooking =
				happy.eventCounts.get("assistant.audio.done") ?? 0;
			const initialDraft = happy.browser.getSnapshot().bookingDraft;
			if (!initialDraft) throw new Error("RC4 booking draft was not projected");
			const selectedCandidate = initialDraft.candidates[0];
			const expectedReadyRevision = initialDraft.revision + 2;
			expect(happy.browser.submitText(syntheticBookingTurn)).toBe(true);
			expect(happy.browser.submitText("duplicate typed turn")).toBe(false);
			await waitFor(
				() =>
					countSpeaker(happy.browser, "visitor") === finalsBeforeBooking + 1 &&
					countSpeaker(happy.browser, "agent") === agentsBeforeBooking + 1 &&
					happy.browser.getSnapshot().bookingDraft?.readiness === "ready" &&
					happy.browser.getSnapshot().bookingDraft?.revision ===
						expectedReadyRevision &&
					happy.captures.at(-1)?.active === true,
				"server draft confirmation did not retain text after TTS failure",
			);
			const readyDraft = happy.browser.getSnapshot().bookingDraft;
			if (!readyDraft?.selectedCandidate)
				throw new Error("ready draft did not retain a current candidate");
			expect(readyDraft).toMatchObject({
				revision: expectedReadyRevision,
				readiness: "ready",
				confirmationStatus: "unconfirmed",
				commitStatus: "uncommitted",
				bookingId: null,
				name: { status: "accepted", value: syntheticBooking.name },
				company: { status: "accepted", value: syntheticBooking.company },
				workEmail: { status: "accepted", value: syntheticBooking.workEmail },
				telegram: { status: "accepted", value: syntheticBooking.telegram },
				selectedCandidate: {
					candidateId: selectedCandidate.candidateId,
					meetingSlot: selectedCandidate.meetingSlot,
				},
			});
			const expectedDraftConfirmation = `Подтвердите, пожалуйста: ${syntheticBooking.name}, компания ${syntheticBooking.company}, почта ${syntheticBooking.workEmail}, Телеграм ${syntheticBooking.telegram}, встреча ${moscowSlotText(selectedCandidate.meetingSlot)}. Всё верно?`;
			expect(latestSpeakerText(happy.browser, "agent")).toBe(
				expectedDraftConfirmation,
			);
			expect(
				timeline.filter((entry) => entry.label === "audio.commit.client-send")
					.length,
			).toBe(commitsBeforeBooking);
			expect(brain.inputs.length).toBe(brainsBeforeBooking);
			expect(happy.eventCounts.get("booking.created")).toBeUndefined();
			expect((happy.eventCounts.get("error") ?? 0) - errorsBeforeBooking).toBe(
				1,
			);
			expect(happy.errorCodes.at(-1)).toBe("TTS_UNAVAILABLE");
			expect(
				(happy.eventCounts.get("assistant.audio.done") ?? 0) -
					audioDoneBeforeBooking,
			).toBe(0);

			// Only the next-turn affirmative confirms that exact revision. The server
			// commits once without Luna and immediately asks the first missing fact.
			const confirmedRevision = readyDraft.revision;
			expect(happy.browser.submitText("Да, подтверждаю")).toBe(true);
			await waitFor(
				() =>
					happy.eventCounts.get("booking.created") === 1 &&
					happy.browser.getSnapshot().bookingDraft?.commitStatus ===
						"committed" &&
					happy.browser.getSnapshot().internalMeeting !== null &&
					happy.captures.at(-1)?.active === true,
				() =>
					`exact-revision affirmative did not commit the RC4 draft (state=${happy.browser.getSnapshot().state.kind}, stage=${happy.browser.getSnapshot().conversationStage}, draft=${JSON.stringify(happy.browser.getSnapshot().bookingDraft)}, meeting=${JSON.stringify(happy.browser.getSnapshot().internalMeeting)}, capture=${happy.captures.at(-1)?.active === true}, playback=${JSON.stringify(happy.playbacks.map((item) => ({ active: item.activeGenerationId, buffered: item.bufferedSegmentCount })))}, provider=${JSON.stringify(provider.counters)}, brain=${brain.inputs.length}, errors=${JSON.stringify(happy.errorCodes)}, events=${JSON.stringify(Object.fromEntries(happy.eventCounts))}, transcript=${JSON.stringify(happy.browser.getSnapshot().transcript)})`,
			);
			const committedSnapshot = happy.browser.getSnapshot();
			const committedDraft = committedSnapshot.bookingDraft;
			const internalMeeting = committedSnapshot.internalMeeting;
			if (!committedDraft || !internalMeeting)
				throw new Error("committed RC4 projections were missing");
			expect(committedDraft).toMatchObject({
				revision: confirmedRevision + 3,
				confirmationStatus: "confirmed",
				commitStatus: "committed",
				bookingId: internalMeeting.bookingId,
			});
			expect(internalMeeting).toMatchObject({
				status: "scheduled",
				kind: "internal_virtual",
				name: syntheticBooking.name,
				company: syntheticBooking.company,
				contacts: [
					{ channel: "email", value: syntheticBooking.workEmail },
					{ channel: "telegram", value: syntheticBooking.telegram },
				],
				meetingSlot: selectedCandidate.meetingSlot,
				qualificationStatus: "none",
				qualificationFields: {
					monthlyLeadVolume: null,
					salesManagerCount: null,
				},
				externalCalendarEventCreated: false,
				externalInviteSent: false,
			});
			const expectedBookingConfirmation = `Внутренняя виртуальная встреча создана на ${moscowSlotText(selectedCandidate.meetingSlot)} для ${syntheticBooking.name}, компания ${syntheticBooking.company}. Контакты: почта ${syntheticBooking.workEmail}, Телеграм ${syntheticBooking.telegram}. Внешнее календарное событие и приглашение не создавались. Сколько входящих лидов приходит за месяц?`;
			expect(latestSpeakerText(happy.browser, "agent")).toBe(
				expectedBookingConfirmation,
			);
			expect(brain.inputs.length).toBe(brainsBeforeBooking);
			expect(countSpeaker(happy.browser, "visitor")).toBe(5);
			expect(countSpeaker(happy.browser, "agent")).toBe(4);

			// Force a real WebSocket reconnect after the durable booking.
			const transcriptsBeforeReconnect = committedSnapshot.transcript.length;
			const socketsBeforeReconnect = happy.sockets.length;
			happy.sockets.at(-1)?.native.close(4000, "t30 reconnect");
			await waitFor(
				() =>
					happy.sockets.length === socketsBeforeReconnect + 1 &&
					happy.browser.getSnapshot().conversationStage ===
						"POST_BOOKING_QUALIFICATION" &&
					happy.captures.at(-1)?.active === true,
				"browser did not resume the booked conversation",
			);
			expect(happy.browser.getSnapshot().transcript).toHaveLength(
				transcriptsBeforeReconnect,
			);
			expect(happy.browser.getSnapshot().internalMeeting?.bookingId).toBe(
				internalMeeting.bookingId,
			);

			// Qualification starts directly and asks only the missing field each turn.
			expect(happy.browser.submitText("240 лидов в месяц")).toBe(true);
			await waitFor(
				() =>
					happy.browser.getSnapshot().internalMeeting?.qualificationStatus ===
						"partial" &&
					latestSpeakerText(happy.browser, "agent") ===
						"Сколько менеджеров по продажам работает в вашей команде?" &&
					happy.captures.at(-1)?.active === true,
				"monthly lead answer did not advance to the only missing question",
			);
			expect(
				happy.browser.getSnapshot().internalMeeting?.qualificationFields,
			).toEqual({
				monthlyLeadVolume: "240 в месяц",
				salesManagerCount: null,
			});
			expect(happy.browser.submitText("8 менеджеров по продажам")).toBe(true);
			await waitFor(
				() =>
					happy.browser.getSnapshot().state.kind === "complete" &&
					happy.browser.getSnapshot().internalMeeting?.qualificationStatus ===
						"complete",
				"qualification did not complete",
			);
			expect(
				happy.browser.getSnapshot().internalMeeting?.qualificationFields,
			).toEqual({
				monthlyLeadVolume: "240 в месяц",
				salesManagerCount: 8,
			});
			// The reconnect re-delivers the buffered event once, but its server
			// sequence proves there was exactly one booking.created event.
			expect(happy.eventCounts.get("booking.created")).toBe(2);
			expect(happy.eventSequences.get("booking.created")?.size).toBe(1);
			expect(happy.eventCounts.get("booking.updated")).toBe(2);
			expect(happy.eventSequences.get("booking.updated")?.size).toBe(2);
			expect(countSpeaker(happy.browser, "visitor")).toBe(7);
			expect(brain.inputs).toHaveLength(3);
			expect(provider.counters.chat).toBe(4);
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
				() => notifier.eventTypes.length === 3,
				"outbox did not deliver booking events",
			);
			expect(notifier.eventTypes).toEqual([
				"booking.created",
				"booking.updated",
				"booking.updated",
			]);
			const completedDraft = happy.browser.getSnapshot().bookingDraft;
			if (!completedDraft)
				throw new Error("completed RC4 draft projection was missing");
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
				const persistedDraft = database.$client
					.query<
						{
							revision: number;
							confirmation_status: string;
							commit_status: string;
							booking_id: string;
						},
						[string]
					>(
						`SELECT revision,
						        json_extract(draft_json, '$.confirmationStatus') AS confirmation_status,
						        json_extract(draft_json, '$.commitStatus') AS commit_status,
						        json_extract(draft_json, '$.bookingId') AS booking_id
						 FROM conversation_contexts
						 WHERE conversation_id = ?`,
					)
					.get(conversationIds[0] as string);
				expect(persistedDraft).toEqual({
					revision: completedDraft.revision,
					confirmation_status: "confirmed",
					commit_status: "committed",
					booking_id: internalMeeting.bookingId,
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
					{ type: "booking.updated", status: "sent", attempt_count: 1 },
				]);
				const replayInput: CreateBookingInput = {
					conversationId: conversationIds[0] as string,
					idempotencyKey: `booking-draft-${conversationIds[0]}`,
					name: syntheticBooking.name,
					company: syntheticBooking.company,
					contacts: [
						{ channel: "email", value: syntheticBooking.workEmail },
						{ channel: "telegram", value: syntheticBooking.telegram },
					],
					meetingSlot: selectedCandidate.meetingSlot,
					consentConfirmed: true,
				};
				const replay = await new SqliteBookingService(database).createBooking(
					replayInput,
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

			// A fresh production session receives a typed STT provider failure: no
			// final, Luna turn, tool, booking, TTS request, or fabricated browser text.
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
			expect(provider.counters).toMatchObject({
				chat: 5,
				invalid: 0,
				statuses: { "400": 1, "503": 2 },
			});
			expect(provider.counters.total).toBe(
				provider.counters.chat + provider.counters.tts,
			);
			expect(provider.counters.statuses["200"]).toBe(
				provider.counters.total - 3,
			);

			const mp3 = createDeterministicMp3Fixture();
			const receivedAudio = happy.playbacks.flatMap((item) => item.received);
			expect(receivedAudio.length).toBeGreaterThan(0);
			// One response became stale after barge-in. The nonretryable degradation
			// may also have one already-prefetched phrase, but no wider work fan-out.
			const ttsWithoutPlayback = provider.counters.tts - receivedAudio.length;
			expect(ttsWithoutPlayback).toBeGreaterThanOrEqual(2);
			expect(ttsWithoutPlayback).toBeLessThanOrEqual(3);
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
			const retryTtsCompletion = timeline.find(
				(entry) => entry.label === "tts.retry-turn.complete",
			);
			expect(retryTtsCompletion?.generationId).toBeDefined();
			if (!retryTtsCompletion?.generationId) {
				throw new Error("missing retry-turn TTS correlation");
			}
			const retryGenerationId = retryTtsCompletion.generationId;
			const requireGenerationTiming = (label: TimelineLabel): number => {
				const value = timeline.find(
					(entry) =>
						entry.label === label && entry.generationId === retryGenerationId,
				)?.at;
				expect(value).toBeDefined();
				if (value === undefined) throw new Error("missing correlated boundary");
				return value;
			};
			const ttsCompleteAt = retryTtsCompletion.at;
			const metadataReceiptAt = requireGenerationTiming(
				"audio.metadata.client-receipt",
			);
			const binaryReceiptAt = requireGenerationTiming(
				"audio.binary.client-receipt",
			);
			const pairedAt = requireGenerationTiming("audio.segment.client-paired");
			const playbackStartedAt = requireGenerationTiming("playback.started");
			const playbackCompletedAt = requireGenerationTiming("playback.completed");
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
			duration(playbackStartedAt, playbackCompletedAt);
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
