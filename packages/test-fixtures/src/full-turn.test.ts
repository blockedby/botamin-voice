import { describe, expect, test } from "bun:test";
import {
	BookingToolExecutionSchema,
	type BrainDelta,
	type BrainTurnInput,
	type CreateBookingInput,
	EntityIdSchema,
	type SttSessionInput,
	type TtsSynthesisRequest,
} from "@botamin/contracts";
import {
	createDeterministicMp3Fixture,
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

		const ttsInput: TtsSynthesisRequest = {
			conversationId,
			turnId,
			generationId,
			segmentId: "01J00000000000000000000005",
			text: speech.join(""),
			signal: controller.signal,
		};
		const segment = await tts.synthesize(ttsInput);
		timeline.push("tts.audio.segment");
		expect(segment.contentType).toBe("audio/mpeg");
		expect(segment.final).toBe(true);

		const committedBooking =
			await bookings.findByConversationId(conversationId);
		if (!committedBooking) throw new Error("Expected a committed booking");

		BookingToolExecutionSchema.parse({
			type: "create_booking",
			stage: "COLLECT_BOOKING",
			sessionConversationId: conversationId,
			currentBooking: committedBooking,
			input: bookingInput,
		});
		const exactReplay = await bookings.createBooking(bookingInput);
		expect(exactReplay).toMatchObject({
			created: false,
			bookingId: committedBooking.id,
		});

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
			timeline.indexOf("tts.audio.segment"),
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

	test("returns deterministic valid-ish MP3 bytes as one atomic segment", async () => {
		const fixture = createDeterministicMp3Fixture();
		expect(fixture.byteLength).toBe(417);
		expect(fixture.slice(0, 4)).toEqual(
			new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
		);

		const customFixture = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
		const tts = new FakeTts({
			mp3: customFixture,
			providerGenerationId: "provider-generation:opaque",
		});
		customFixture.fill(0);
		const input: TtsSynthesisRequest = {
			conversationId,
			turnId,
			generationId,
			segmentId: "01J00000000000000000000005",
			text: "Этот текст не кодируется как аудио",
			signal: new AbortController().signal,
		};
		const segment = await tts.synthesize(input);
		expect(segment).toMatchObject({
			generationId,
			segmentId: input.segmentId,
			providerGenerationId: "provider-generation:opaque",
			contentType: "audio/mpeg",
			final: true,
		});
		expect(segment.bytes).toEqual(new Uint8Array([0xff, 0xfb, 0x90, 0x64]));
		expect(tts.inputs).toEqual([input]);
		expect(() => new FakeTts({ mp3: new Uint8Array() })).toThrow("non-empty");
	});

	test("enforces abort and server-owned current-generation hooks", async () => {
		const createRequest = (signal: AbortSignal): TtsSynthesisRequest => ({
			conversationId,
			turnId,
			generationId,
			segmentId: "01J00000000000000000000005",
			text: "Отмена",
			signal,
		});

		const preAborted = new AbortController();
		preAborted.abort();
		await expect(
			new FakeTts().synthesize(createRequest(preAborted.signal)),
		).rejects.toHaveProperty("name", "AbortError");

		const abortedDuringSynthesis = new AbortController();
		const delayedTts = new FakeTts({
			beforeResolve: () => abortedDuringSynthesis.abort(),
		});
		await expect(
			delayedTts.synthesize(createRequest(abortedDuringSynthesis.signal)),
		).rejects.toHaveProperty("name", "AbortError");

		const staleTts = new FakeTts();
		staleTts.markGenerationObsolete(generationId);
		await expect(
			staleTts.synthesize(createRequest(new AbortController().signal)),
		).rejects.toHaveProperty("name", "AbortError");

		const guardedTts = new FakeTts({ isGenerationCurrent: () => false });
		await expect(
			guardedTts.synthesize(createRequest(new AbortController().signal)),
		).rejects.toHaveProperty("name", "AbortError");
		expect(await new FakeTts({ health: "degraded" }).health()).toBe("degraded");
	});
});
