import { describe, expect, test } from "bun:test";
import type {
	ServerWsEvent,
	SttPort,
	SttTranscriptionRequest,
	TtsSynthesisRequest,
} from "../src";
import * as ContractExports from "../src";
import {
	AppendQualificationInputSchema,
	AtomicServerAudioSegmentFrameSchema,
	AudioClientConfigSchema,
	AudioSegmentEventSchema,
	BINARY_AUDIO_FRAME_BYTE_ORDER,
	BINARY_AUDIO_FRAME_HEADER_BYTES,
	BINARY_AUDIO_FRAME_KIND,
	BINARY_AUDIO_FRAME_PAYLOAD_OFFSET,
	BinaryAudioFrameMetadataSchema,
	BookingDomainEventSchema,
	BookingSnapshotSchema,
	BookingToolExecutionSchema,
	ClientWsEventSchema,
	CreateBookingInputSchema,
	CreateConversationRequestSchema,
	decodeBinaryAudioFrame,
	EntityIdSchema,
	encodeBinaryAudioFrame,
	isCompleteMp3File,
	MeetingSlotSchema,
	MpegAudioBytesSchema,
	QualificationPatchSchema,
	ServerWsEventSchema,
	STT_CONTRACT_MAX_AUDIO_BYTES,
	SttHealthSchema,
	SttTranscriptionRequestDataSchema,
	SttTranscriptionResultSchema,
	TtsAudioSegmentSchema,
	TtsHealthSchema,
	TtsSynthesisRequestDataSchema,
} from "../src";

const conversationId = "01J00000000000000000000000";
const bookingId = "01J00000000000000000000001";
const eventId = "01J00000000000000000000002";
const foreignConversationId = "01J00000000000000000000009";
const at = "2026-07-30T20:22:00.000Z";
const meetingSlot = {
	startAt: "2026-08-03T06:00:00.000Z",
	endAt: "2026-08-03T06:20:00.000Z",
	timeZone: "Europe/Moscow",
	durationMinutes: 20,
} as const;
function createStructurallyValidMp3Frame(): Uint8Array {
	const bytes = new Uint8Array(96);
	bytes.set([0xff, 0xf3, 0x44, 0xc4]);
	return bytes;
}

const bookingSnapshot = {
	id: bookingId,
	conversationId,
	status: "booked",
	name: "Александр",
	contacts: [
		{ channel: "email", value: "alex@example.com" },
		{ channel: "telegram", value: "@alex" },
	],
	company: "Example LLC",
	meetingSlot,
	qualificationStatus: "none",
	createdAt: at,
	updatedAt: at,
};

describe("shared contracts", () => {
	test("accepts only opaque ULID or UUIDv7 entity identifiers", () => {
		expect(EntityIdSchema.safeParse(conversationId).success).toBe(true);
		expect(EntityIdSchema.safeParse("alex@example.com").success).toBe(false);
	});

	test("requires conversation consent at the REST boundary", () => {
		const request = {
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consent: { voiceProcessing: true, contactProcessing: true },
		};

		expect(CreateConversationRequestSchema.safeParse(request).success).toBe(
			true,
		);
		expect(
			CreateConversationRequestSchema.safeParse({
				...request,
				consent: { ...request.consent, voiceProcessing: false },
			}).success,
		).toBe(false);
	});

	test("requires complete lead data, consent, and one structured meeting slot", () => {
		const input = {
			conversationId,
			idempotencyKey: "turn-booking-0001",
			name: "Александр",
			contacts: [
				{ channel: "email", value: "alex@example.com" },
				{ channel: "telegram", value: "@alex" },
			],
			company: "Example LLC",
			meetingSlot,
			consentConfirmed: true,
		};

		expect(CreateBookingInputSchema.safeParse(input).success).toBe(true);
		for (const invalid of [
			{ ...input, consentConfirmed: false },
			{ ...input, company: undefined },
			{ ...input, meetingSlot: undefined },
			{ ...input, contacts: [{ channel: "email", value: "alex@example.com" }] },
			{ ...input, contacts: [{ channel: "telegram", value: "@alex" }] },
			{
				...input,
				contacts: [
					{ channel: "email", value: "not-an-email" },
					{ channel: "phone", value: "+79991234567" },
				],
			},
		]) {
			expect(CreateBookingInputSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("validates canonical 20-minute Moscow weekday slots on the business grid", () => {
		expect(MeetingSlotSchema.safeParse(meetingSlot).success).toBe(true);
		expect(
			MeetingSlotSchema.safeParse({
				...meetingSlot,
				startAt: "2026-08-03T14:00:00.000Z",
				endAt: "2026-08-03T14:20:00.000Z",
			}).success,
		).toBe(true);
		for (const invalid of [
			{
				...meetingSlot,
				startAt: "2026-08-01T06:00:00.000Z",
				endAt: "2026-08-01T06:20:00.000Z",
			},
			{
				...meetingSlot,
				startAt: "2026-08-03T05:40:00.000Z",
				endAt: "2026-08-03T06:00:00.000Z",
			},
			{
				...meetingSlot,
				startAt: "2026-08-03T14:20:00.000Z",
				endAt: "2026-08-03T14:40:00.000Z",
			},
			{ ...meetingSlot, endAt: "2026-08-03T06:30:00.000Z" },
			{ ...meetingSlot, startAt: "2026-08-03T06:00:00Z" },
		]) {
			expect(MeetingSlotSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("allows an empty reusable patch only for skipped qualification input", () => {
		expect(QualificationPatchSchema.safeParse({}).success).toBe(true);
		expect(
			QualificationPatchSchema.safeParse({ salesManagerCount: 25 }).success,
		).toBe(true);
		for (const salesManagerCount of [-1, 1.5, 10_001, "25"]) {
			expect(
				QualificationPatchSchema.safeParse({ salesManagerCount }).success,
			).toBe(false);
		}
		for (const completion of ["partial", "complete"] as const) {
			expect(
				AppendQualificationInputSchema.safeParse({
					bookingId,
					idempotencyKey: `qualification-${completion}`,
					patch: {},
					completion,
				}).success,
			).toBe(false);
		}
		expect(
			AppendQualificationInputSchema.safeParse({
				bookingId,
				idempotencyKey: "qualification-skipped",
				patch: {},
				completion: "skipped",
			}).success,
		).toBe(true);
		expect(
			AppendQualificationInputSchema.safeParse({
				bookingId,
				idempotencyKey: "qualification-partial",
				patch: { role: "Head of Sales" },
			}).success,
		).toBe(true);
	});

	test("keeps empty qualification snapshots and skipped events valid", () => {
		expect(
			BookingSnapshotSchema.safeParse({
				...bookingSnapshot,
				qualification: {},
				qualificationStatus: "skipped",
			}).success,
		).toBe(true);
		expect(
			BookingDomainEventSchema.safeParse({
				v: 1,
				type: "booking.updated",
				eventId,
				occurredAt: at,
				data: {
					bookingId,
					conversationId,
					qualificationStatus: "skipped",
					qualification: {},
				},
			}).success,
		).toBe(true);
	});

	test("allows create replay policy only for a booking in the session", () => {
		const command = {
			type: "create_booking",
			stage: "COLLECT_BOOKING",
			sessionConversationId: conversationId,
			currentBooking: bookingSnapshot,
			input: {
				conversationId,
				idempotencyKey: "turn-booking-replay",
				name: "Александр",
				contacts: bookingSnapshot.contacts,
				company: bookingSnapshot.company,
				meetingSlot,
				consentConfirmed: true,
			},
		};

		expect(
			BookingToolExecutionSchema.safeParse({
				...command,
				currentBooking: null,
			}).success,
		).toBe(true);
		expect(BookingToolExecutionSchema.safeParse(command).success).toBe(true);
		expect(
			BookingToolExecutionSchema.safeParse({
				...command,
				currentBooking: {
					...bookingSnapshot,
					conversationId: foreignConversationId,
				},
			}).success,
		).toBe(false);
	});

	test("requires a committed session booking before qualification", () => {
		const command = {
			type: "append_booking_qualification",
			stage: "COLLECT_BOOKING",
			sessionConversationId: conversationId,
			currentBooking: null,
			input: {
				bookingId,
				idempotencyKey: "qualification-0001",
				patch: { role: "Head of Sales" },
			},
		};

		expect(BookingToolExecutionSchema.safeParse(command).success).toBe(false);
	});

	test("discriminates client and server WebSocket events", () => {
		const hello = ClientWsEventSchema.parse({
			v: 1,
			type: "client.hello",
			conversationId,
			at,
			payload: {
				resumeToken: null,
				audio: {
					encoding: "pcm16le",
					sampleRate: 16_000,
					channels: 1,
					chunkMs: 100,
				},
			},
		});
		const created = ServerWsEventSchema.parse({
			v: 1,
			type: "booking.created",
			conversationId,
			seq: 4,
			at,
			payload: {
				bookingId,
				status: "booked",
				qualificationStatus: "none",
				createdAt: at,
			},
		});

		expect(hello.type).toBe("client.hello");
		expect(created.type).toBe("booking.created");
	});

	test("freezes atomic STT request data and its TypeScript-only AbortSignal boundary", async () => {
		const data = {
			conversationId,
			turnId: "01J00000000000000000000003",
			audio: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
			contentType: "audio/wav" as const,
			language: "ru",
		};
		const request = {
			...data,
			signal: new AbortController().signal,
		} satisfies SttTranscriptionRequest;

		expect(SttTranscriptionRequestDataSchema.safeParse(data).success).toBe(
			true,
		);
		// A live AbortSignal is deliberately rejected by the strict data schema.
		expect(SttTranscriptionRequestDataSchema.safeParse(request).success).toBe(
			false,
		);
		for (const invalid of [
			{ ...data, conversationId: "not-an-id" },
			{ ...data, turnId: "not-an-id" },
			{ ...data, audio: new Uint8Array() },
			{
				...data,
				audio: new Uint8Array(STT_CONTRACT_MAX_AUDIO_BYTES + 1),
			},
			{ ...data, audio: "RIFF" },
			{ ...data, contentType: "audio/pcm" },
			{ ...data, language: "" },
			{ ...data, language: "   " },
			{ ...data, provider: "openrouter" },
		]) {
			expect(SttTranscriptionRequestDataSchema.safeParse(invalid).success).toBe(
				false,
			);
		}

		const atomicStt: SttPort = {
			async transcribe(input) {
				return {
					conversationId: input.conversationId,
					turnId: input.turnId,
					text: "Финальный текст",
					final: true,
				};
			},
			async health() {
				return "ready";
			},
		};
		const result = await atomicStt.transcribe(request);
		expect(result).toEqual({
			conversationId,
			turnId: data.turnId,
			text: "Финальный текст",
			final: true,
		});
		type SttHasConnect = "connect" extends keyof SttPort ? true : false;
		const sttHasConnect: SttHasConnect = false;
		expect(sttHasConnect).toBe(false);
		expect("connect" in atomicStt).toBe(false);
	});

	test("validates exactly one provider-neutral final STT result shape", () => {
		const result = {
			conversationId,
			turnId: "01J00000000000000000000003",
			text: "Давайте созвонимся завтра",
			final: true,
		};
		expect(SttTranscriptionResultSchema.safeParse(result).success).toBe(true);
		for (const invalid of [
			{ ...result, conversationId: "not-an-id" },
			{ ...result, turnId: "not-an-id" },
			{ ...result, text: "" },
			{ ...result, text: "   " },
			{ ...result, final: false },
			{ ...result, type: "transcript.final" },
			[result],
		]) {
			expect(SttTranscriptionResultSchema.safeParse(invalid).success).toBe(
				false,
			);
		}
		expect(SttHealthSchema.options).toEqual([
			"ready",
			"degraded",
			"unavailable",
		]);
	});

	test("keeps audio.commit and one final transcript without a partial event", () => {
		const commit = {
			v: 1,
			type: "audio.commit",
			conversationId,
			at,
			payload: {},
		};
		const finalTranscript = {
			v: 1,
			type: "transcript.final",
			conversationId,
			seq: 2,
			at,
			payload: {
				turnId: "01J00000000000000000000003",
				text: "Финальный текст",
			},
		};
		expect(ClientWsEventSchema.safeParse(commit).success).toBe(true);
		expect(ServerWsEventSchema.safeParse(finalTranscript).success).toBe(true);
		expect(
			ServerWsEventSchema.safeParse({
				...finalTranscript,
				type: ["transcript", "partial"].join("."),
				payload: { text: "Фальшивый partial" },
			}).success,
		).toBe(false);
		type ServerHasPartial =
			`transcript.${"partial"}` extends ServerWsEvent["type"] ? true : false;
		const serverHasPartial: ServerHasPartial = false;
		expect(serverHasPartial).toBe(false);
		for (const retiredExport of [
			"SttSessionInputSchema",
			"SttEventSchema",
			"TranscriptPartialEventSchema",
		]) {
			expect(retiredExport in ContractExports).toBe(false);
		}
	});

	test("keeps AbortSignal at the TypeScript-only TTS request boundary", () => {
		const data = {
			conversationId,
			turnId: "01J00000000000000000000003",
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			text: "Готово.",
		};
		const request = {
			...data,
			signal: new AbortController().signal,
		} satisfies TtsSynthesisRequest;

		expect(TtsSynthesisRequestDataSchema.safeParse(data).success).toBe(true);
		// A live AbortSignal is deliberately rejected by the strict data schema.
		expect(TtsSynthesisRequestDataSchema.safeParse(request).success).toBe(
			false,
		);
		for (const invalid of [
			{ ...data, conversationId: "not-an-id" },
			{ ...data, turnId: "not-an-id" },
			{ ...data, generationId: "not-an-id" },
			{ ...data, segmentId: "not-an-id" },
			{ ...data, text: "" },
		]) {
			expect(TtsSynthesisRequestDataSchema.safeParse(invalid).success).toBe(
				false,
			);
		}
	});

	test("shares strict whole-file MP3 validation across provider and transport boundaries", () => {
		const complete = createStructurallyValidMp3Frame();
		expect(isCompleteMp3File(complete)).toBe(true);
		expect(MpegAudioBytesSchema.safeParse(complete).success).toBe(true);
		for (const invalid of [
			new Uint8Array([0xff]),
			new TextEncoder().encode("not-an-mp3"),
			Uint8Array.from([0, ...complete]),
			Uint8Array.from([...complete, 0]),
			complete.slice(0, -1),
		]) {
			expect(isCompleteMp3File(invalid)).toBe(false);
			expect(MpegAudioBytesSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("validates complete non-empty MP3 TTS segments", () => {
		const segment = {
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			providerGenerationId: "provider-generation:opaque",
			contentType: "audio/mpeg",
			bytes: createStructurallyValidMp3Frame(),
			final: true,
		};
		expect(TtsAudioSegmentSchema.safeParse(segment).success).toBe(true);
		for (const invalid of [
			{ ...segment, generationId: "generation" },
			{ ...segment, segmentId: "segment" },
			{ ...segment, providerGenerationId: "" },
			{ ...segment, bytes: new Uint8Array() },
			{ ...segment, bytes: new TextEncoder().encode("not-mp3") },
			{ ...segment, bytes: "mp3" },
			{ ...segment, contentType: "audio/wav" },
			{ ...segment, final: false },
			{ ...segment, encoding: "pcm16le" },
		]) {
			expect(TtsAudioSegmentSchema.safeParse(invalid).success).toBe(false);
		}
		expect(TtsHealthSchema.options).toEqual([
			"ready",
			"degraded",
			"unavailable",
		]);
	});

	test("freezes MP3 output client configuration and rejects PCM output", () => {
		const config = {
			inputSampleRate: 16_000,
			inputEncoding: "pcm16le",
			chunkMs: 100,
			outputContentType: "audio/mpeg",
			outputMode: "complete-phrase-segments",
		};
		expect(AudioClientConfigSchema.safeParse(config).success).toBe(true);
		for (const invalid of [
			{ ...config, outputContentType: "audio/wav" },
			{ ...config, outputMode: "streaming-chunks" },
			{ ...config, inputSampleRate: 24_000 },
			{ ...config, outputSampleRate: 24_000 },
		]) {
			expect(AudioClientConfigSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("validates exhaustive audio.segment metadata boundaries", () => {
		const metadata = {
			v: 1,
			conversationId,
			seq: 7,
			at,
			type: "audio.segment",
			payload: {
				generationId: "01J00000000000000000000004",
				segmentId: "01J00000000000000000000005",
				sequence: 0,
				contentType: "audio/mpeg",
				byteLength: 4,
				final: true,
			},
		};
		expect(AudioSegmentEventSchema.safeParse(metadata).success).toBe(true);
		for (const payload of [
			{ ...metadata.payload, generationId: "generation" },
			{ ...metadata.payload, segmentId: "segment" },
			{ ...metadata.payload, sequence: -1 },
			{ ...metadata.payload, sequence: 0.5 },
			{ ...metadata.payload, sequence: Number.MAX_SAFE_INTEGER + 1 },
			{ ...metadata.payload, contentType: "audio/wav" },
			{ ...metadata.payload, byteLength: 0 },
			{ ...metadata.payload, final: false },
			{ ...metadata.payload, audioSeq: 0 },
			{ ...metadata.payload, encoding: "pcm16le" },
		]) {
			expect(
				AudioSegmentEventSchema.safeParse({ ...metadata, payload }).success,
			).toBe(false);
		}

		const serverProduced: ServerWsEvent = ServerWsEventSchema.parse(metadata);
		if (serverProduced.type !== "audio.segment") {
			throw new Error("Expected audio.segment in the shared server union");
		}
		const browserConsumed: Extract<ServerWsEvent, { type: "audio.segment" }> =
			serverProduced;
		expect(browserConsumed.payload.segmentId).toBe(metadata.payload.segmentId);
	});

	test("round-trips the canonical A2 server frame through the A1 decoder", () => {
		const mp3 = createStructurallyValidMp3Frame();
		const sequence = 0x01_02_03_04_05;
		const rawFrame = encodeBinaryAudioFrame({
			kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
			sequence,
			payload: mp3,
		});
		const metadata = {
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			sequence,
			contentType: "audio/mpeg",
			byteLength: mp3.byteLength,
			final: true,
		};

		expect(BINARY_AUDIO_FRAME_HEADER_BYTES).toBe(9);
		expect(BINARY_AUDIO_FRAME_PAYLOAD_OFFSET).toBe(9);
		expect(BINARY_AUDIO_FRAME_BYTE_ORDER).toBe("big-endian");
		expect(rawFrame.slice(0, 9)).toEqual(
			new Uint8Array([0x02, 0, 0, 0, 1, 2, 3, 4, 5]),
		);
		expect(rawFrame.byteLength).toBe(9 + metadata.byteLength);
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

	test("rejects raw server frame kind, sequence, size, and shape mismatches", () => {
		const mp3 = createStructurallyValidMp3Frame();
		const metadata = {
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			sequence: 7,
			contentType: "audio/mpeg",
			byteLength: mp3.byteLength,
			final: true,
		};
		const encode = (kind: 1 | 2, sequence: number, payload = mp3) =>
			encodeBinaryAudioFrame({ kind, sequence, payload });

		for (const invalid of [
			{
				metadata,
				rawFrame: encode(BINARY_AUDIO_FRAME_KIND.clientPcm16, 7),
			},
			{
				metadata,
				rawFrame: encode(BINARY_AUDIO_FRAME_KIND.serverMp3Segment, 8),
			},
			{
				metadata: { ...metadata, byteLength: metadata.byteLength + 1 },
				rawFrame: encode(BINARY_AUDIO_FRAME_KIND.serverMp3Segment, 7),
			},
			{
				metadata,
				rawFrame: encode(
					BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
					7,
					mp3.slice(0, -1),
				),
			},
			{ metadata, bytes: mp3 },
		]) {
			expect(
				AtomicServerAudioSegmentFrameSchema.safeParse(invalid).success,
			).toBe(false);
		}
	});

	test("keeps PCM16 microphone framing but removes PCM server output", () => {
		const clientMetadata = {
			direction: "client",
			streamSeq: 0,
			encoding: "pcm16le",
			sampleRate: 16_000,
		};
		const serverMetadata = {
			direction: "server",
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			sequence: 0,
			contentType: "audio/mpeg",
			byteLength: 4,
			final: true,
		};
		expect(
			BinaryAudioFrameMetadataSchema.safeParse(clientMetadata).success,
		).toBe(true);
		expect(
			BinaryAudioFrameMetadataSchema.safeParse(serverMetadata).success,
		).toBe(true);
		expect(BINARY_AUDIO_FRAME_KIND).toEqual({
			clientPcm16: 0x01,
			serverMp3Segment: 0x02,
		});
		expect(() =>
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
				sequence: Number.MAX_SAFE_INTEGER + 1,
				payload: new Uint8Array([0, 0]),
			}),
		).toThrow("safe integer");
		expect(
			BinaryAudioFrameMetadataSchema.safeParse({
				...clientMetadata,
				streamSeq: Number.MAX_SAFE_INTEGER + 1,
			}).success,
		).toBe(false);
		expect(
			BinaryAudioFrameMetadataSchema.safeParse({
				direction: "server",
				generationId: serverMetadata.generationId,
				audioSeq: 0,
				encoding: "pcm16le",
				sampleRate: 24_000,
			}).success,
		).toBe(false);
		expect(
			ServerWsEventSchema.safeParse({
				v: 1,
				conversationId,
				seq: 7,
				at,
				type: "assistant.audio.chunk",
				payload: {
					generationId: serverMetadata.generationId,
					audioSeq: 0,
					byteLength: 4,
					encoding: "pcm16le",
					sampleRate: 24_000,
				},
			}).success,
		).toBe(false);
		expect("TtsInputSchema" in ContractExports).toBe(false);
		expect("TtsEventSchema" in ContractExports).toBe(false);
		expect("AssistantAudioChunkEventSchema" in ContractExports).toBe(false);
	});

	test("validates notifier domain events", () => {
		const event = BookingDomainEventSchema.parse({
			v: 1,
			type: "booking.created",
			eventId,
			occurredAt: at,
			data: {
				bookingId,
				conversationId,
				name: "Александр",
				contacts: bookingSnapshot.contacts,
				company: bookingSnapshot.company,
				meetingSlot,
				status: "booked",
				qualificationStatus: "none",
			},
		});

		expect(event.data.conversationId).toBe(conversationId);
	});
});
