import { describe, expect, test } from "bun:test";
import {
	BINARY_AUDIO_FRAME_KIND,
	ClientWsEventSchema,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
	ServerWsEventSchema,
	type BookingService,
	type BookingSnapshot,
	type BrainDelta,
	type BrainPort,
	type BrainTurnInput,
	type CreateBookingInput,
	type CreateBookingResult,
	type SttPort,
	type SttTranscriptionRequest,
	type TtsAudioSegment,
	type TtsPort,
	type TtsSynthesisRequest,
} from "@botamin/contracts";
import {
	ConversationOrchestrator,
	createInitialConversationState,
} from "../orchestrator";
import { GatewaySession, type GatewaySocket } from "./session";

const conversationId = "01J00000000000000000000000";
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

class Brain implements BrainPort {
	runs = 0;
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
	async health() {
		return { status: "healthy" as const };
	}
}

class Tts implements TtsPort {
	readonly requests: TtsSynthesisRequest[] = [];
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
			stopConversation: () => undefined,
		},
		brainModel: "gpt-5.6-luna",
		maxUtteranceMs: 30_000,
		maxAudioBytes: 1_000_000,
		maxFrameBytes: 3_209,
		maxJsonBytes: 8_192,
		maxHistoryEvents: 128,
		maxHistoryBytes: 5_000_000,
		acquireTurn: () => () => undefined,
		now: () => new Date(now),
	});
	if (options.collectBooking) {
		expect(orchestrator.apply({ type: "connected" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_offered" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_accepted" }).ok).toBe(true);
	}
	return { session, stt, brain, tts, bookings, persisted, orchestrator };
}

function hello(token: string | null = null): string {
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
		harness.session.attach(socket);
		await harness.session.receive(socket, hello());
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
		await harness.session.receive(socket, hello());
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

	test("STT failure emits no transcript and never invokes the brain", async () => {
		const stt = new Stt();
		stt.fail = true;
		const harness = createHarness({ stt });
		const socket = new Socket();
		await harness.session.receive(socket, hello());
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
						contacts: [{ channel: "telegram", value: "@alex" }],
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
		await harness.session.receive(socket, hello());
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

	test("requires explicit affirmative transcript evidence before post-booking qualification", async () => {
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
								contacts: [{ channel: "telegram", value: "@alex" }],
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
		await harness.session.receive(socket, hello());
		await sendUtterance(harness.session, socket, true, 0);
		expect(harness.orchestrator.state.stage).toBe("BOOKED");

		stt.text = "Нет, не задавайте.";
		await sendUtterance(harness.session, socket, true, 1);
		expect(harness.orchestrator.state.stage).toBe("BOOKED");

		stt.text = "Да, можно.";
		await sendUtterance(harness.session, socket, true, 2);
		expect(harness.orchestrator.state.stage).toBe("POST_BOOKING_QUALIFICATION");
	});

	test("barge-in aborts in-flight TTS and suppresses stale binary playback", async () => {
		const tts = new BlockingTts();
		const harness = createHarness({ tts });
		const socket = new Socket();
		await harness.session.receive(socket, hello());
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
		await harness.session.receive(socket, hello());
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
		await harness.session.receive(first, hello());
		const ready = first
			.events()
			.find((event) => event.type === "session.ready");
		expect(ready?.type).toBe("session.ready");
		await sendUtterance(harness.session, first);
		harness.session.detach(first);

		const second = new Socket();
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
		await harness.session.receive(attacker, hello("not-the-resume-token"));
		expect(attacker.closes.at(-1)?.code).toBe(1008);
	});

	test("rejects out-of-order or oversized canonical client frames", async () => {
		const harness = createHarness();
		const socket = new Socket();
		await harness.session.receive(socket, hello());
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
