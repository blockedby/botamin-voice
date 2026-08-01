import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	AtomicServerAudioSegmentFrameSchema,
	BINARY_AUDIO_FRAME_KIND,
	BookingToolExecutionSchema,
	type BrainDelta,
	type BrainTurnInput,
	type CreateBookingInput,
	decodeBinaryAudioFrame,
	EntityIdSchema,
	encodeBinaryAudioFrame,
	MpegAudioBytesSchema,
	type SttTranscriptionRequest,
	type TtsSynthesisRequest,
} from "@botamin/contracts";
import { createTestBookingContacts, createTestMeetingSlot } from "./booking";
import {
	FakeBookingService,
	FakeBrain,
	FakeNotifier,
	FakeStt,
	FakeTts,
} from "./fakes";
import {
	createDeterministicMp3Fixture,
	createMalformedMp3Fixture,
} from "./mp3";
import {
	createDeterministicWavFixture,
	DETERMINISTIC_WAV_FIXTURE_PROPERTIES,
	encodeMonoPcm16Wav,
	MONO_PCM16_16_KHZ_WAV_PROPERTIES,
	parseMonoPcm16Wav,
} from "./wav";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000003";
const generationId = "01J00000000000000000000004";

const bookingInput: CreateBookingInput = {
	conversationId,
	idempotencyKey: "booking-turn-0001",
	name: "Александр",
	contacts: createTestBookingContacts(),
	company: "Example LLC",
	meetingSlot: createTestMeetingSlot(),
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
		const stt = new FakeStt({ text: "Давайте созвонимся завтра" });
		const brain = new FakeBrain(brainScript);
		const tts = new FakeTts();
		const controller = new AbortController();
		const sttInput: SttTranscriptionRequest = {
			conversationId,
			turnId,
			audio: createDeterministicWavFixture(),
			contentType: "audio/wav",
			language: "ru",
			signal: controller.signal,
		};

		const transcription = await stt.transcribe(sttInput);
		timeline.push("transcript.final");
		expect(transcription).toEqual({
			conversationId,
			turnId,
			text: "Давайте созвонимся завтра",
			final: true,
		});
		expect(stt.inputs).toEqual([sttInput]);
		expect(
			timeline.filter((entry) => entry === "transcript.final"),
		).toHaveLength(1);
		const userText = transcription.text;

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

	test("returns the known-valid deterministic MP3 as one atomic segment", async () => {
		const fixture = createDeterministicMp3Fixture();
		const malformed = createMalformedMp3Fixture();
		expect(fixture.byteLength).toBe(789);
		expect(fixture.slice(0, 4)).toEqual(
			new Uint8Array([0x49, 0x44, 0x33, 0x04]),
		);
		expect(malformed).not.toEqual(fixture);
		expect(MpegAudioBytesSchema.safeParse(fixture).success).toBe(true);
		expect(MpegAudioBytesSchema.safeParse(malformed).success).toBe(false);

		const customFixture = fixture.slice();
		const expectedBytes = customFixture.slice();
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
		expect(segment.bytes).toEqual(expectedBytes);
		expect(tts.inputs).toEqual([input]);
		expect(() => new FakeTts({ mp3: malformed })).toThrow(
			"structurally valid MP3",
		);
	});

	test("returns a deterministic strict mono PCM16 16 kHz WAV fixture", () => {
		const fixture = createDeterministicWavFixture();
		expect(Object.isFrozen(MONO_PCM16_16_KHZ_WAV_PROPERTIES)).toBe(true);
		expect(Object.isFrozen(DETERMINISTIC_WAV_FIXTURE_PROPERTIES)).toBe(true);
		expect(DETERMINISTIC_WAV_FIXTURE_PROPERTIES).toEqual({
			durationMs: 100,
			sampleCount: 1_600,
			dataByteLength: 3_200,
			byteLength: 3_244,
		});
		expect(fixture.byteLength).toBe(
			DETERMINISTIC_WAV_FIXTURE_PROPERTIES.byteLength,
		);
		expect(fixture.slice(0, 12)).toEqual(
			new Uint8Array([
				0x52, 0x49, 0x46, 0x46, 0xa4, 0x0c, 0, 0, 0x57, 0x41, 0x56, 0x45,
			]),
		);

		const parsed = parseMonoPcm16Wav(fixture);
		expect(parsed).toMatchObject({
			...MONO_PCM16_16_KHZ_WAV_PROPERTIES,
			sampleCount: DETERMINISTIC_WAV_FIXTURE_PROPERTIES.sampleCount,
			dataByteLength: DETERMINISTIC_WAV_FIXTURE_PROPERTIES.dataByteLength,
		});
		const sampleView = new DataView(
			parsed.pcm16.buffer,
			parsed.pcm16.byteOffset,
			parsed.pcm16.byteLength,
		);
		expect(sampleView.getInt16(0, true)).toBe(1_000);
		expect(sampleView.getInt16(800 * 2, true)).toBe(-1_000);
		expect(sampleView.getInt16(400 * 2, true)).toBe(0);

		const secondFixture = createDeterministicWavFixture();
		expect(secondFixture).toEqual(fixture);
		secondFixture.fill(0);
		expect(createDeterministicWavFixture()).toEqual(fixture);
	});

	test("strictly rejects malformed PCM and non-canonical WAV fixtures", () => {
		expect(() => encodeMonoPcm16Wav(new Uint8Array())).toThrow("non-empty");
		expect(() => encodeMonoPcm16Wav(new Uint8Array([0]))).toThrow(
			"whole non-empty 16-bit samples",
		);

		const fixture = createDeterministicWavFixture();
		for (const mutate of [
			(bytes: Uint8Array) => {
				bytes[0] = 0;
			},
			(bytes: Uint8Array) => {
				new DataView(bytes.buffer).setUint32(4, 0, true);
			},
			(bytes: Uint8Array) => {
				new DataView(bytes.buffer).setUint32(24, 8_000, true);
			},
			(bytes: Uint8Array) => {
				new DataView(bytes.buffer).setUint32(40, 2, true);
			},
		]) {
			const malformed = fixture.slice();
			mutate(malformed);
			expect(() => parseMonoPcm16Wav(malformed)).toThrow();
		}
	});

	test("preserves every MP3 byte across server encode and browser decode", () => {
		const mp3 = createDeterministicMp3Fixture();
		const metadata = {
			generationId,
			segmentId: "01J00000000000000000000005",
			sequence: 42,
			contentType: "audio/mpeg" as const,
			byteLength: mp3.byteLength,
			final: true as const,
		};
		const rawFrame = encodeBinaryAudioFrame({
			kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
			sequence: metadata.sequence,
			payload: mp3,
		});

		expect(
			AtomicServerAudioSegmentFrameSchema.safeParse({ metadata, rawFrame })
				.success,
		).toBe(true);
		const decoded = decodeBinaryAudioFrame(rawFrame);
		expect(decoded.kind).toBe(BINARY_AUDIO_FRAME_KIND.serverMp3Segment);
		expect(decoded.sequence).toBe(metadata.sequence);
		expect(decoded.payload.byteLength).toBe(metadata.byteLength);
		expect(decoded.payload).toEqual(mp3);
	});

	test("ffprobe accepts the deterministic MP3 fixture when available", () => {
		const result = spawnSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"stream=codec_name,codec_type,sample_rate,channels",
				"-of",
				"json",
				"-i",
				"pipe:0",
			],
			{ input: createDeterministicMp3Fixture(), encoding: "utf8" },
		);
		if (
			(result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
		) {
			console.warn("ffprobe unavailable; skipping external MP3 decode check");
			return;
		}

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const probe = JSON.parse(result.stdout) as {
			streams?: Array<Record<string, unknown>>;
		};
		expect(probe.streams?.[0]).toMatchObject({
			codec_name: "mp3",
			codec_type: "audio",
			sample_rate: "24000",
			channels: 1,
		});
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

	test("enforces atomic STT abort, stale-turn, and health hooks", async () => {
		const createRequest = (signal: AbortSignal): SttTranscriptionRequest => ({
			conversationId,
			turnId,
			audio: createDeterministicWavFixture(),
			contentType: "audio/wav",
			language: "ru",
			signal,
		});
		const preAborted = new AbortController();
		preAborted.abort();
		await expect(
			new FakeStt().transcribe(createRequest(preAborted.signal)),
		).rejects.toHaveProperty("name", "AbortError");

		const during = new AbortController();
		await expect(
			new FakeStt({ beforeResolve: () => during.abort() }).transcribe(
				createRequest(during.signal),
			),
		).rejects.toHaveProperty("name", "AbortError");

		const stale = new FakeStt();
		stale.markTurnObsolete(turnId);
		await expect(
			stale.transcribe(createRequest(new AbortController().signal)),
		).rejects.toHaveProperty("name", "AbortError");
		await expect(
			new FakeStt({ isTurnCurrent: () => false }).transcribe(
				createRequest(new AbortController().signal),
			),
		).rejects.toHaveProperty("name", "AbortError");
		expect(await new FakeStt({ health: "degraded" }).health()).toBe("degraded");
		expect(() => new FakeStt({ text: "" })).toThrow("non-empty");
	});
});
