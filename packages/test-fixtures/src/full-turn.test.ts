import { describe, expect, test } from "bun:test";
import {
	BookingToolExecutionSchema,
	type BrainDelta,
	type BrainTurnInput,
	type CreateBookingInput,
	EntityIdSchema,
	type SttSessionInput,
	type TtsInput,
} from "@botamin/contracts";
import {
	FakeBookingService,
	FakeBrain,
	FakeNotifier,
	FakeStt,
	FakeTts,
} from "./fakes";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000003";
const generationId = "01J00000000000000000000004";

const bookingInput: CreateBookingInput = {
	conversationId,
	idempotencyKey: "booking-turn-0001",
	name: "Александр",
	contacts: [{ channel: "telegram", value: "@alex" }],
	preferredTimeText: "завтра после 15:00",
	consentConfirmed: true,
};

const brainScript: BrainDelta[] = [
	{
		type: "tool.request",
		turnId,
		generationId,
		tool: {
			name: "create_booking",
			callId: "call-booking-1",
			args: bookingInput,
		},
	},
	{
		type: "speech.delta",
		turnId,
		generationId,
		text: "Внутренняя бронь создана.",
	},
	{ type: "turn.completed", turnId, generationId },
];

describe("fake full turn", () => {
	test("runs STT → brain → committed booking → TTS without credentials", async () => {
		const timeline: string[] = [];
		const notifier = new FakeNotifier();
		const bookings = new FakeBookingService({ notifier });
		const stt = new FakeStt([
			{ type: "transcript.partial", text: "Давайте" },
			{
				type: "transcript.final",
				turnId,
				text: "Давайте созвонимся завтра",
			},
		]);
		const brain = new FakeBrain(brainScript);
		const tts = new FakeTts();
		const controller = new AbortController();
		const sttInput: SttSessionInput = {
			conversationId,
			encoding: "pcm16le",
			sampleRate: 16_000,
			channels: 1,
			language: "ru",
		};

		const sttSession = await stt.connect(sttInput, controller.signal);
		await sttSession.sendAudio(new Uint8Array([0, 0, 1, 0]));
		await sttSession.commit();

		let userText = "";
		for await (const event of sttSession.events()) {
			timeline.push(event.type);
			if (event.type === "transcript.final") userText = event.text;
		}

		const turn: BrainTurnInput = {
			conversationId,
			turnId,
			generationId,
			userText,
			stage: "COLLECT_BOOKING",
			knownFacts: { useCases: [], painPoints: [], objections: [] },
			booking: null,
			allowedActions: ["create_booking"],
			promptVersion: "a".repeat(64),
		};
		const speech: string[] = [];

		for await (const delta of brain.runTurn(turn, controller.signal)) {
			timeline.push(`brain.${delta.type}`);
			if (delta.type === "tool.request") {
				expect(delta.tool.name).toBe("create_booking");
				if (delta.tool.name === "create_booking") {
					BookingToolExecutionSchema.parse({
						type: "create_booking",
						stage: turn.stage,
						sessionConversationId: conversationId,
						currentBooking: null,
						input: delta.tool.args,
					});
					await bookings.createBooking(delta.tool.args);
					timeline.push(bookings.domainEvents.at(-1)?.type ?? "missing-event");
				}
			}
			if (delta.type === "speech.delta") speech.push(delta.text);
		}

		const ttsInput: TtsInput = {
			conversationId,
			generationId,
			text: speech.join(""),
			language: "ru",
			outputEncoding: "pcm16le",
			outputSampleRate: 24_000,
		};
		for await (const event of tts.synthesize(ttsInput, controller.signal)) {
			timeline.push(`tts.${event.type}`);
		}

		const committedBooking =
			await bookings.findByConversationId(conversationId);
		if (!committedBooking) throw new Error("Expected a committed booking");

		const replayInput = {
			...bookingInput,
			idempotencyKey: "booking-turn-0002",
		};
		BookingToolExecutionSchema.parse({
			type: "create_booking",
			stage: "COLLECT_BOOKING",
			sessionConversationId: conversationId,
			currentBooking: committedBooking,
			input: replayInput,
		});
		const replay = await bookings.createBooking(replayInput);
		expect(replay).toMatchObject({
			created: false,
			bookingId: committedBooking.id,
		});

		const qualificationInput = {
			bookingId: committedBooking.id,
			idempotencyKey: "qualification-0001",
			patch: { role: "Head of Sales" },
			completion: "partial" as const,
		};
		BookingToolExecutionSchema.parse({
			type: "append_booking_qualification",
			stage: "BOOKED",
			sessionConversationId: conversationId,
			currentBooking: committedBooking,
			input: qualificationInput,
		});
		await bookings.appendQualification(qualificationInput);
		timeline.push(bookings.domainEvents.at(-1)?.type ?? "missing-event");

		const saved = await bookings.findByConversationId(conversationId);

		expect(saved).toMatchObject({
			id: committedBooking.id,
			status: "booked",
			qualificationStatus: "partial",
		});
		expect(notifier.events.map((event) => event.type)).toEqual([
			"booking.created",
			"booking.updated",
		]);
		expect(timeline.indexOf("booking.created")).toBeLessThan(
			timeline.indexOf("tts.audio.chunk"),
		);
		expect(timeline.indexOf("booking.created")).toBeLessThan(
			timeline.indexOf("booking.updated"),
		);
	});

	test("keeps a committed booking when notification fails", async () => {
		const notifier = new FakeNotifier();
		notifier.failPublishing = true;
		const bookings = new FakeBookingService({ notifier });

		const created = await bookings.createBooking(bookingInput);
		const saved = await bookings.findByConversationId(conversationId);

		expect(created.created).toBe(true);
		expect(saved?.status).toBe("booked");
		expect(bookings.notificationErrors).toHaveLength(1);
	});

	test("generates deterministic distinct default IDs across conversations and events", async () => {
		const secondConversationId = "01J00000000000000000000020";
		const bookings = new FakeBookingService();
		const first = await bookings.createBooking(bookingInput);
		const second = await bookings.createBooking({
			...bookingInput,
			conversationId: secondConversationId,
		});
		await bookings.appendQualification({
			bookingId: first.bookingId,
			idempotencyKey: "qualification-skip-first",
			patch: {},
			completion: "skipped",
		});
		await bookings.appendQualification({
			bookingId: second.bookingId,
			idempotencyKey: "qualification-second",
			patch: { role: "Head of Sales" },
			completion: "complete",
		});

		const eventIds = bookings.domainEvents.map((event) => event.eventId);
		expect(first.bookingId).not.toBe(second.bookingId);
		expect(new Set(eventIds).size).toBe(4);
		expect(new Set([first.bookingId, second.bookingId, ...eventIds]).size).toBe(
			6,
		);
		for (const id of [first.bookingId, second.bookingId, ...eventIds]) {
			expect(EntityIdSchema.safeParse(id).success).toBe(true);
		}

		const secondInstance = new FakeBookingService();
		const repeatedFirst = await secondInstance.createBooking(bookingInput);
		expect(repeatedFirst.bookingId).toBe(first.bookingId);
	});

	test("emits configurable sample-aligned PCM16LE fixture audio", async () => {
		const fixture = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
		const tts = new FakeTts({ pcm16le: fixture });
		fixture.fill(0);
		const input: TtsInput = {
			conversationId,
			generationId,
			text: "Этот текст не кодируется как аудио",
			language: "ru",
			outputEncoding: "pcm16le",
			outputSampleRate: 24_000,
		};
		const events = [];
		for await (const event of tts.synthesize(
			input,
			new AbortController().signal,
		)) {
			events.push(event);
		}
		const chunk = events[0];
		if (chunk?.type !== "audio.chunk") {
			throw new Error("Expected an audio fixture chunk");
		}

		expect(chunk.audio).toEqual(new Uint8Array([0x34, 0x12, 0xcc, 0xed]));
		expect(chunk.audio.byteLength % 2).toBe(0);
		expect(events.at(-1)?.type).toBe("audio.done");
		expect(() => new FakeTts({ pcm16le: new Uint8Array([0x00]) })).toThrow(
			"whole samples",
		);
	});

	test("stops TTS after explicit cancellation or signal abort", async () => {
		const input: TtsInput = {
			conversationId,
			generationId,
			text: "Отмена",
			language: "ru",
			outputEncoding: "pcm16le",
			outputSampleRate: 24_000,
		};
		const cancelledTts = new FakeTts();
		const cancelledStream = cancelledTts
			.synthesize(input, new AbortController().signal)
			[Symbol.asyncIterator]();
		expect((await cancelledStream.next()).value?.type).toBe("audio.chunk");
		await cancelledTts.cancel(generationId);
		expect((await cancelledStream.next()).done).toBe(true);

		const controller = new AbortController();
		const abortedTts = new FakeTts();
		const abortedStream = abortedTts
			.synthesize(input, controller.signal)
			[Symbol.asyncIterator]();
		expect((await abortedStream.next()).value?.type).toBe("audio.chunk");
		controller.abort();
		expect((await abortedStream.next()).done).toBe(true);

		const preCancelledTts = new FakeTts();
		await preCancelledTts.cancel(generationId);
		const preCancelledStream = preCancelledTts
			.synthesize(input, new AbortController().signal)
			[Symbol.asyncIterator]();
		expect((await preCancelledStream.next()).done).toBe(true);
	});
});
