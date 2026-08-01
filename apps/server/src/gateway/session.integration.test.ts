import { describe, expect, test } from "bun:test";
import {
	BINARY_AUDIO_FRAME_KIND,
	type BookingService,
	type BookingSnapshot,
	type BrainDelta,
	type BrainPort,
	type BrainTurnInput,
	ClientWsEventSchema,
	type CreateBookingInput,
	type CreateBookingResult,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
	ServerWsEventSchema,
	type SttPort,
	type SttTranscriptionRequest,
	type TtsAudioSegment,
	type TtsPort,
	type TtsSynthesisRequest,
} from "@botamin/contracts";
import {
	createTestBookingContacts,
	createTestMeetingSlot,
} from "../../../../packages/test-fixtures/src";
import {
	ConversationOrchestrator,
	createInitialConversationState,
} from "../orchestrator";
import {
	GatewaySession,
	type GatewaySessionOptions,
	type GatewaySocket,
	type SessionPersistence,
} from "./session";

const conversationId = "01J00000000000000000000000";
const initialClientToken = "initial-client-token-00000000000000000000";
const now = "2026-07-30T20:22:00.000Z";

class Socket implements GatewaySocket {
	readonly sent: Array<string | Uint8Array> = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	send(data: string | Uint8Array): void {
		this.sent.push(typeof data === "string" ? data : data.slice());
	}
	close(code?: number, reason?: string): void {
		this.closes.push({
			...(code === undefined ? {} : { code }),
			...(reason === undefined ? {} : { reason }),
		});
	}
	events() {
		return this.sent
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => ServerWsEventSchema.parse(JSON.parse(entry)));
	}
}

class Stt implements SttPort {
	readonly requests: SttTranscriptionRequest[] = [];
	fail = false;
	text = "Финальная реплика";
	async transcribe(request: SttTranscriptionRequest) {
		this.requests.push({ ...request, audio: request.audio.slice() });
		if (this.fail) throw new Error("fake stt failure");
		return {
			conversationId: request.conversationId,
			turnId: request.turnId,
			text: this.text,
			final: true as const,
		};
	}
	async health() {
		return "ready" as const;
	}
}

class BlockingStt extends Stt {
	readonly started: Promise<void>;
	#markStarted: () => void = () => undefined;
	#release: () => void = () => undefined;
	readonly gate: Promise<void>;

	constructor() {
		super();
		this.started = new Promise<void>((resolve) => {
			this.#markStarted = resolve;
		});
		this.gate = new Promise<void>((resolve) => {
			this.#release = resolve;
		});
	}

	release(): void {
		this.#release();
	}

	override async transcribe(request: SttTranscriptionRequest) {
		this.requests.push({ ...request, audio: request.audio.slice() });
		this.#markStarted();
		await this.gate;
		return {
			conversationId: request.conversationId,
			turnId: request.turnId,
			text: this.text,
			final: true as const,
		};
	}
}

class Brain implements BrainPort {
	runs = 0;
	readonly released: string[] = [];
	constructor(
		readonly script: (input: BrainTurnInput) => BrainDelta[] = (input) => [
			{
				type: "speech.delta",
				turnId: input.turnId,
				generationId: input.generationId,
				text: "Короткий ответ.",
			},
			{
				type: "turn.completed",
				turnId: input.turnId,
				generationId: input.generationId,
			},
		],
	) {}
	async createThread() {
		return "thread-fake";
	}
	async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
		this.runs += 1;
		for (const delta of this.script(input)) yield delta;
	}
	async interrupt() {}
	async releaseConversation(id: string) {
		this.released.push(id);
	}
	async health() {
		return { status: "healthy" as const };
	}
}

class Tts implements TtsPort {
	readonly requests: TtsSynthesisRequest[] = [];
	readonly reset: string[] = [];
	fail = false;
	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.requests.push(request);
		if (this.fail) throw new Error("fake tts failure");
		return {
			generationId: request.generationId,
			segmentId: request.segmentId,
			contentType: "audio/mpeg" as const,
			bytes: validMp3(),
			final: true as const,
		};
	}
	resetSession(id: string): void {
		this.reset.push(id);
	}
	async health() {
		return "ready" as const;
	}
}

class BlockingTts implements TtsPort {
	readonly requests: TtsSynthesisRequest[] = [];
	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.requests.push(request);
		return new Promise<TtsAudioSegment>((_resolve, reject) => {
			const abort = () => reject(new DOMException("aborted", "AbortError"));
			if (request.signal.aborted) abort();
			else request.signal.addEventListener("abort", abort, { once: true });
		});
	}
	async health() {
		return "ready" as const;
	}
}

class FirstBlockingTts implements TtsPort {
	readonly requests: TtsSynthesisRequest[] = [];
	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.requests.push(request);
		if (this.requests.length > 1) {
			return {
				generationId: request.generationId,
				segmentId: request.segmentId,
				contentType: "audio/mpeg",
				bytes: validMp3(),
				final: true,
			};
		}
		return new Promise<TtsAudioSegment>((_resolve, reject) => {
			const abort = () => reject(new DOMException("aborted", "AbortError"));
			if (request.signal.aborted) abort();
			else request.signal.addEventListener("abort", abort, { once: true });
		});
	}
	async health() {
		return "ready" as const;
	}
}

class Bookings implements BookingService {
	createCalls = 0;
	snapshot: BookingSnapshot | null = null;
	async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
		this.createCalls += 1;
		if (!this.snapshot) {
			this.snapshot = {
				id: "01J00000000000000000000010",
				conversationId: input.conversationId,
				status: "booked",
				name: input.name,
				contacts: input.contacts,
				company: input.company,
				meetingSlot: input.meetingSlot,
				qualification: {},
				qualificationStatus: "none",
				createdAt: now,
				updatedAt: now,
			};
		}
		return {
			ok: true,
			created: this.createCalls === 1,
			bookingId: this.snapshot.id,
			status: "booked",
			createdAt: this.snapshot.createdAt,
		};
	}
	async appendQualification(): Promise<never> {
		throw new Error("not used");
	}
	async findByConversationId() {
		return this.snapshot;
	}
}

function validMp3(): Uint8Array<ArrayBuffer> {
	// MPEG-1 Layer III, 128 kbps, 44.1 kHz: one complete 417-byte frame.
	const bytes = new Uint8Array(new ArrayBuffer(417));
	bytes.set([0xff, 0xfb, 0x90, 0x64]);
	return bytes;
}

function createHarness(
	options: {
		stt?: Stt;
		brain?: Brain;
		tts?: TtsPort | null;
		bookings?: Bookings;
		collectBooking?: boolean;
		persistence?: Partial<SessionPersistence>;
		acquireTurn?: GatewaySessionOptions["acquireTurn"];
		clientHelloTimeoutMs?: number;
		stopDrainMs?: number;
	} = {},
) {
	const stt = options.stt ?? new Stt();
	const brain = options.brain ?? new Brain();
	const tts = options.tts === undefined ? new Tts() : options.tts;
	const bookings = options.bookings ?? new Bookings();
	const persisted: unknown[] = [];
	const initialState = {
		...createInitialConversationState(),
		contactConsentConfirmed: true,
	};
	const orchestrator = new ConversationOrchestrator({
		conversationId,
		promptVersion: "a".repeat(64),
		stt,
		brain,
		bookings,
		tts,
		initialState,
	});
	const session = new GatewaySession({
		conversationId,
		expiresAt: new Date("2030-01-01T00:00:00.000Z"),
		orchestrator,
		bookings,
		persistence: {
			appendTurn: (input) => persisted.push(input),
			setConversationActive: () => undefined,
			updateConversationStage: () => undefined,
			failConversation: () => undefined,
			stopConversation: () => undefined,
			...options.persistence,
		},
		brainModel: "gpt-5.6-luna",
		maxUtteranceMs: 30_000,
		maxAudioBytes: 1_000_000,
		maxFrameBytes: 3_209,
		maxJsonBytes: 8_192,
		maxHistoryEvents: 128,
		maxHistoryBytes: 5_000_000,
		...(options.clientHelloTimeoutMs === undefined
			? {}
			: { clientHelloTimeoutMs: options.clientHelloTimeoutMs }),
		...(options.stopDrainMs === undefined
			? {}
			: { stopDrainMs: options.stopDrainMs }),
		acquireTurn:
			options.acquireTurn ??
			(async () => ({ ok: true, release: () => undefined })),
		tokenFactory: () => initialClientToken,
		now: () => new Date(now),
	});
	if (options.collectBooking) {
		expect(orchestrator.apply({ type: "connected" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_offered" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_accepted" }).ok).toBe(true);
	}
	return { session, stt, brain, tts, bookings, persisted, orchestrator };
}

function hello(token: string | null = initialClientToken): string {
	return JSON.stringify(
		ClientWsEventSchema.parse({
			v: 1,
			type: "client.hello",
			conversationId,
			at: now,
			payload: {
				resumeToken: token,
				audio: {
					encoding: "pcm16le",
					sampleRate: 16_000,
					channels: 1,
					chunkMs: 100,
				},
			},
		}),
	);
}

function clientEvent(type: "audio.commit", payload: object = {}): string {
	return JSON.stringify({
		v: 1,
		type,
		conversationId,
		at: now,
		payload,
	});
}

async function connect(
	session: GatewaySession,
	socket: Socket,
	token: string | null = initialClientToken,
): Promise<void> {
	session.attach(socket);
	await session.receive(socket, hello(token));
}

async function sendUtterance(
	session: GatewaySession,
	socket: Socket,
	waitForCompletion = true,
	sequence = 0,
): Promise<void> {
	await session.receive(
		socket,
		encodeBinaryAudioFrame({
			kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
			sequence,
			payload: new Uint8Array([1, 2, 3, 4]),
		}),
	);
	await session.receive(socket, clientEvent("audio.commit"));
	if (waitForCompletion) await session.drain();
}

describe("gateway fake full WebSocket path", () => {
	test("binds hello, sends exact WAV to STT, one final transcript, text and atomic MP3", async () => {
		const harness = createHarness();
		const socket = new Socket();
		await connect(harness.session, socket);
		await harness.session.receive(
			socket,
			JSON.stringify({
				v: 1,
				type: "client.ping",
				conversationId,
				at: now,
				payload: { sentAt: now },
			}),
		);
		expect(socket.events().some((event) => event.type === "server.pong")).toBe(
			true,
		);
		await sendUtterance(harness.session, socket);

		expect(harness.stt.requests).toHaveLength(1);
		const wav = harness.stt.requests[0]?.audio;
		expect(wav?.byteLength).toBe(48);
		expect(new TextDecoder().decode(wav?.subarray(0, 4))).toBe("RIFF");
		expect(wav?.subarray(44)).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(harness.brain.runs).toBe(1);
		expect((harness.tts as Tts).requests).toHaveLength(1);

		const events = socket.events();
		expect(
			events.filter((event) => event.type === "transcript.final"),
		).toHaveLength(1);
		expect(events.some((event) => event.type === "assistant.text.done")).toBe(
			true,
		);
		const metadata = events.find((event) => event.type === "audio.segment");
		expect(metadata?.type).toBe("audio.segment");
		const raw = socket.sent.find(
			(entry): entry is Uint8Array => entry instanceof Uint8Array,
		);
		expect(raw).toBeDefined();
		if (!raw) throw new Error("Expected one server binary frame");
		const decoded = decodeBinaryAudioFrame(raw);
		expect(decoded.kind).toBe(BINARY_AUDIO_FRAME_KIND.serverMp3Segment);
		if (metadata?.type === "audio.segment") {
			expect(decoded.sequence).toBe(metadata.payload.sequence);
			expect(decoded.payload.byteLength).toBe(metadata.payload.byteLength);
		}

		await harness.session.receive(socket, clientEvent("audio.commit"));
		expect(harness.stt.requests).toHaveLength(1);
		expect(harness.persisted).toHaveLength(1);
	});

	test("applies only a server-validated safe-envelope stage proposal", async () => {
		const brain = new Brain((input) => [
			{
				type: "speech.delta",
				turnId: input.turnId,
				generationId: input.generationId,
				text: "Расскажите о задаче.",
			},
			{
				type: "turn.completed",
				turnId: input.turnId,
				generationId: input.generationId,
				nextStage: "DISCOVERY",
			},
		]);
		const harness = createHarness({ brain, tts: null });
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket);
		expect(harness.orchestrator.state.stage).toBe("DISCOVERY");
		expect(
			socket
				.events()
				.some(
					(event) =>
						event.type === "state.changed" &&
						event.payload.from === "GREETING" &&
						event.payload.to === "DISCOVERY",
				),
		).toBe(true);
	});

	test("clear pre-booking refusal becomes DECLINED without brain or booking effects", async () => {
		const stt = new Stt();
		stt.text = "Нет, спасибо, мне не интересно.";
		const harness = createHarness({ stt, tts: null });
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket);
		expect(harness.orchestrator.state.stage).toBe("DECLINED");
		expect(harness.brain.runs).toBe(0);
		expect(harness.bookings.createCalls).toBe(0);
		expect(
			socket
				.events()
				.filter(
					(event) =>
						event.type === "state.changed" && event.payload.to === "DECLINED",
				),
		).toHaveLength(1);
	});

	test("STT failure emits no transcript and never invokes the brain", async () => {
		const stt = new Stt();
		stt.fail = true;
		const harness = createHarness({ stt });
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket);
		expect(harness.brain.runs).toBe(0);
		expect(
			socket.events().some((event) => event.type === "transcript.final"),
		).toBe(false);
		expect(
			socket
				.events()
				.some(
					(event) =>
						event.type === "error" && event.payload.code === "STT_UNAVAILABLE",
				),
		).toBe(true);
	});

	test("brain provider failure emits and persists one terminal ERROR with safe fallback", async () => {
		const failed: string[] = [];
		const brain = new Brain((input) => [
			{
				type: "error",
				turnId: input.turnId,
				generationId: input.generationId,
				error: {
					code: "BRAIN_PROTOCOL_ERROR",
					message: "private provider detail",
					retryable: true,
				},
			},
		]);
		const harness = createHarness({
			brain,
			tts: null,
			persistence: {
				failConversation: (_id, code) => failed.push(code),
			},
		});
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket);
		expect(harness.orchestrator.state.stage).toBe("ERROR");
		expect(failed).toEqual(["BRAIN_PROTOCOL_ERROR"]);
		expect(
			socket
				.events()
				.filter(
					(event) =>
						event.type === "state.changed" && event.payload.to === "ERROR",
				),
		).toHaveLength(1);
		const done = socket
			.events()
			.find((event) => event.type === "assistant.text.done");
		expect(
			done?.type === "assistant.text.done" ? done.payload.fullText : "",
		).toContain("Данные ещё не были сохранены");
		expect(JSON.stringify(socket.events())).not.toContain(
			"private provider detail",
		);
		await harness.session.stop("disconnected");
		expect(failed).toHaveLength(1);
	});

	test("TTS failure preserves assistant text and a booking committed exactly once", async () => {
		const tts = new Tts();
		tts.fail = true;
		const brain = new Brain((input) => [
			{
				type: "tool.request",
				turnId: input.turnId,
				generationId: input.generationId,
				tool: {
					name: "create_booking",
					callId: "booking-call-0001",
					args: {
						conversationId,
						idempotencyKey: "booking-idempotency-0001",
						name: "Александр",
						contacts: createTestBookingContacts(),
						company: "Example LLC",
						meetingSlot: createTestMeetingSlot(),
						consentConfirmed: true,
					},
				},
			},
			{
				type: "turn.completed",
				turnId: input.turnId,
				generationId: input.generationId,
				nextStage: "POST_BOOKING_QUALIFICATION",
			},
		]);
		const harness = createHarness({ brain, tts, collectBooking: true });
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket);
		const events = socket.events();
		expect(harness.bookings.createCalls).toBe(1);
		expect(
			events.filter((event) => event.type === "booking.created"),
		).toHaveLength(1);
		expect(events.some((event) => event.type === "assistant.text.done")).toBe(
			true,
		);
		expect(
			events.some(
				(event) =>
					event.type === "error" && event.payload.code === "TTS_UNAVAILABLE",
			),
		).toBe(true);
		expect(events.some((event) => event.type === "audio.segment")).toBe(false);
		// The action envelope cannot grant qualification consent in the same turn.
		expect(harness.orchestrator.state.stage).toBe("BOOKED");
	});

	test("requires explicit consent, ignores ambiguity, then completes an explicit qualification decline", async () => {
		const stt = new Stt();
		let scriptedTurn = 0;
		const brain = new Brain((input) => {
			scriptedTurn += 1;
			if (scriptedTurn === 1) {
				return [
					{
						type: "tool.request",
						turnId: input.turnId,
						generationId: input.generationId,
						tool: {
							name: "create_booking",
							callId: "booking-consent-call-0001",
							args: {
								conversationId,
								idempotencyKey: "booking-consent-key-0001",
								name: "Александр",
								contacts: createTestBookingContacts(),
								company: "Example LLC",
								meetingSlot: createTestMeetingSlot(),
								consentConfirmed: true,
							},
						},
					},
					{
						type: "turn.completed",
						turnId: input.turnId,
						generationId: input.generationId,
						nextStage: "BOOKED",
					},
				];
			}
			return [
				{
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Поняла.",
				},
				{
					type: "turn.completed",
					turnId: input.turnId,
					generationId: input.generationId,
					nextStage: "POST_BOOKING_QUALIFICATION",
				},
			];
		});
		const harness = createHarness({
			stt,
			brain,
			tts: null,
			collectBooking: true,
		});
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket, true, 0);
		expect(harness.orchestrator.state.stage).toBe("BOOKED");

		stt.text = "Не уверен, что сейчас удобно.";
		await sendUtterance(harness.session, socket, true, 1);
		expect(harness.orchestrator.state.stage).toBe("BOOKED");

		stt.text = "Да, можно.";
		await sendUtterance(harness.session, socket, true, 2);
		expect(harness.orchestrator.state.stage).toBe("POST_BOOKING_QUALIFICATION");

		stt.text = "Не хочу отвечать на дополнительные вопросы.";
		await sendUtterance(harness.session, socket, true, 3);
		expect(harness.orchestrator.state.stage).toBe("COMPLETE");
		expect(harness.orchestrator.state.booking?.id).toBe(
			harness.bookings.snapshot?.id,
		);
		expect(harness.bookings.createCalls).toBe(1);
	});

	test("barge-in aborts in-flight TTS and suppresses stale binary playback", async () => {
		const tts = new BlockingTts();
		const harness = createHarness({ tts });
		const socket = new Socket();
		await connect(harness.session, socket);
		const processing = sendUtterance(harness.session, socket, false);
		for (
			let attempt = 0;
			attempt < 20 && tts.requests.length === 0;
			attempt += 1
		) {
			await Bun.sleep(1);
		}
		const generationId = tts.requests[0]?.generationId;
		expect(generationId).toBeDefined();
		await harness.session.receive(
			socket,
			JSON.stringify({
				v: 1,
				type: "playback.interrupted",
				conversationId,
				at: now,
				payload: { generationId, reason: "barge_in" },
			}),
		);
		await processing;
		await harness.session.drain();
		expect(
			socket
				.events()
				.some(
					(event) =>
						event.type === "assistant.interrupted" &&
						event.payload.generationId === generationId,
				),
		).toBe(true);
		expect(socket.sent.some((entry) => entry instanceof Uint8Array)).toBe(
			false,
		);
	});

	test("serializes inbound frames while allowing a newer commit to interrupt and persist independently", async () => {
		const tts = new FirstBlockingTts();
		const harness = createHarness({ tts });
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket, false);
		for (
			let attempt = 0;
			attempt < 20 && tts.requests.length === 0;
			attempt += 1
		) {
			await Bun.sleep(1);
		}
		await harness.session.receive(
			socket,
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
				sequence: 1,
				payload: new Uint8Array([5, 6, 7, 8]),
			}),
		);
		await harness.session.receive(socket, clientEvent("audio.commit"));
		await harness.session.drain();
		expect(harness.stt.requests).toHaveLength(2);
		expect(harness.brain.runs).toBe(2);
		expect(harness.persisted).toHaveLength(2);
		expect(
			new Set(harness.persisted.map((turn) => (turn as { id: string }).id))
				.size,
		).toBe(2);
	});

	test("reconnect validates the opaque token and replays bounded event history", async () => {
		const harness = createHarness({ tts: null });
		const first = new Socket();
		await connect(harness.session, first);
		const ready = first
			.events()
			.find((event) => event.type === "session.ready");
		expect(ready?.type).toBe("session.ready");
		await sendUtterance(harness.session, first);
		harness.session.detach(first);

		const second = new Socket();
		harness.session.attach(second);
		await harness.session.receive(
			second,
			hello(ready?.type === "session.ready" ? ready.payload.resumeToken : null),
		);
		expect(second.closes).toHaveLength(0);
		expect(
			second.events().some((event) => event.type === "transcript.final"),
		).toBe(true);
		expect(second.events().at(-1)?.type).toBe("session.ready");

		const attacker = new Socket();
		harness.session.attach(attacker);
		await harness.session.receive(attacker, hello("not-the-resume-token"));
		expect(attacker.closes.at(-1)?.code).toBe(1008);
	});

	test("serializes one pending socket, validates token before replacement, and enforces hello deadline", async () => {
		const harness = createHarness({ tts: null, clientHelloTimeoutMs: 5 });
		const first = new Socket();
		await connect(harness.session, first);
		const ready = first
			.events()
			.find((event) => event.type === "session.ready");
		if (ready?.type !== "session.ready")
			throw new Error("Expected ready token");

		const invalid = new Socket();
		harness.session.attach(invalid);
		await harness.session.receive(invalid, hello("invalid-resume-token"));
		expect(invalid.closes.at(-1)?.code).toBe(1008);
		expect(first.closes).toHaveLength(0);

		const resumed = new Socket();
		harness.session.attach(resumed);
		await harness.session.receive(resumed, hello(ready.payload.resumeToken));
		expect(first.closes.at(-1)?.reason).toBe("session resumed elsewhere");
		expect(resumed.closes).toHaveLength(0);

		const silent = new Socket();
		harness.session.attach(silent);
		await Bun.sleep(10);
		expect(silent.closes.at(-1)).toMatchObject({
			code: 1008,
			reason: "client hello timeout",
		});
		expect(resumed.closes).toHaveLength(0);
		await harness.session.stop("disconnected");
	});

	test("stop aborts active STT, emits nothing late, and releases brain/TTS session state", async () => {
		const stt = new BlockingStt();
		const harness = createHarness({ stt, stopDrainMs: 10 });
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket, false);
		await stt.started;
		const beforeStop = socket.events().length;
		await harness.session.stop("disconnected");
		expect(stt.requests[0]?.signal.aborted).toBe(true);
		expect(harness.brain.runs).toBe(0);
		expect(harness.persisted).toHaveLength(0);
		expect(harness.brain.released).toEqual([conversationId]);
		expect((harness.tts as Tts).reset).toEqual([conversationId]);
		stt.release();
		await harness.session.drain();
		expect(socket.events()).toHaveLength(beforeStop);
		expect(harness.brain.runs).toBe(0);
		expect(harness.bookings.createCalls).toBe(0);
	});

	test("retains committed WAV while queued and stop cancels a queued turn", async () => {
		let admit: ((result: { ok: true; release(): void }) => void) | undefined;
		const waiting = createHarness({
			acquireTurn: async ({ signal }) =>
				new Promise((resolve) => {
					admit = resolve;
					signal.addEventListener(
						"abort",
						() => resolve({ ok: false, reason: "cancelled" }),
						{ once: true },
					);
				}),
		});
		const socket = new Socket();
		await connect(waiting.session, socket);
		await sendUtterance(waiting.session, socket, false);
		await Bun.sleep(0);
		expect(waiting.stt.requests).toHaveLength(0);
		admit?.({ ok: true, release: () => undefined });
		await waiting.session.drain();
		expect(waiting.stt.requests).toHaveLength(1);
		expect(waiting.stt.requests[0]?.audio.subarray(44)).toEqual(
			new Uint8Array([1, 2, 3, 4]),
		);

		const cancelled = createHarness({
			acquireTurn: async ({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener(
						"abort",
						() => resolve({ ok: false, reason: "cancelled" }),
						{ once: true },
					);
				}),
		});
		const cancelledSocket = new Socket();
		await connect(cancelled.session, cancelledSocket);
		await sendUtterance(cancelled.session, cancelledSocket, false);
		await Bun.sleep(0);
		await cancelled.session.stop("disconnected");
		expect(cancelled.stt.requests).toHaveLength(0);
	});

	test("queue overflow emits only a safe capacity error and never starts STT", async () => {
		const harness = createHarness({
			acquireTurn: async () => ({ ok: false, reason: "overflow" }),
		});
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket);
		expect(harness.stt.requests).toHaveLength(0);
		expect(
			socket
				.events()
				.filter(
					(event) =>
						event.type === "error" &&
						event.payload.code === "CAPACITY_EXCEEDED",
				),
		).toHaveLength(1);
	});

	test("releases the global permit even when turn persistence throws, then accepts the next turn", async () => {
		let activePermits = 0;
		let releases = 0;
		let appendCalls = 0;
		const stored: unknown[] = [];
		const harness = createHarness({
			acquireTurn: async () => {
				if (activePermits >= 1) return { ok: false, reason: "overflow" };
				activePermits += 1;
				return {
					ok: true,
					release: () => {
						activePermits -= 1;
						releases += 1;
					},
				};
			},
			persistence: {
				appendTurn: (input) => {
					appendCalls += 1;
					if (appendCalls === 1) throw new Error("private sqlite failure");
					stored.push(input);
				},
			},
		});
		const socket = new Socket();
		await connect(harness.session, socket);
		await sendUtterance(harness.session, socket, true, 0);
		expect(activePermits).toBe(0);
		expect(
			socket
				.events()
				.some(
					(event) =>
						event.type === "error" && event.payload.code === "DB_UNAVAILABLE",
				),
		).toBe(true);
		await sendUtterance(harness.session, socket, true, 1);
		expect(activePermits).toBe(0);
		expect(releases).toBe(2);
		expect(appendCalls).toBe(2);
		expect(stored).toHaveLength(1);
		expect(harness.brain.runs).toBe(2);
	});

	test("rejects out-of-order or oversized canonical client frames", async () => {
		const harness = createHarness();
		const socket = new Socket();
		await connect(harness.session, socket);
		await harness.session.receive(
			socket,
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
				sequence: 1,
				payload: new Uint8Array([0, 0]),
			}),
		);
		expect(socket.closes.at(-1)?.code).toBe(1008);
		expect(harness.stt.requests).toHaveLength(0);
		expect(harness.orchestrator.state.stage).toBe("DISCONNECTED");
	});
});
