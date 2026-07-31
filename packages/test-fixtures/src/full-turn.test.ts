import { describe, expect, test } from "bun:test";
import {
	BookingToolExecutionSchema,
	type BrainDelta,
	type BrainTurnInput,
	type CreateBookingInput,
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
const bookingId = "01J00000000000000000000011";

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
		const qualificationInput = {
			bookingId,
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

		const replay = await bookings.createBooking({
			...bookingInput,
			idempotencyKey: "booking-turn-0002",
		});
		const saved = await bookings.findByConversationId(conversationId);

		expect(replay).toMatchObject({ created: false, bookingId });
		expect(saved).toMatchObject({
			id: bookingId,
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

	test("scopes create idempotency keys by conversation", async () => {
		const ids = ["01J00000000000000000000021", "01J00000000000000000000022"];
		const bookings = new FakeBookingService({
			bookingId: () => ids.shift() ?? bookingId,
		});
		const first = await bookings.createBooking(bookingInput);
		const second = await bookings.createBooking({
			...bookingInput,
			conversationId: "01J00000000000000000000020",
		});

		expect(first.bookingId).not.toBe(second.bookingId);
	});
});
