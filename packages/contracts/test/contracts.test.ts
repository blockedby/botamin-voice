import { describe, expect, test } from "bun:test";
import type { ServerWsEvent, TtsSynthesisRequest } from "../src";
import * as ContractExports from "../src";
import {
	AppendQualificationInputSchema,
	AtomicServerAudioSegmentFrameSchema,
	AudioClientConfigSchema,
	AudioSegmentEventSchema,
	BINARY_AUDIO_FRAME_KIND,
	BinaryAudioFrameMetadataSchema,
	BookingDomainEventSchema,
	BookingSnapshotSchema,
	BookingToolExecutionSchema,
	ClientWsEventSchema,
	CreateBookingInputSchema,
	CreateConversationRequestSchema,
	EntityIdSchema,
	QualificationPatchSchema,
	ServerWsEventSchema,
	TtsAudioSegmentSchema,
	TtsHealthSchema,
	TtsSynthesisRequestDataSchema,
} from "../src";

const conversationId = "01J00000000000000000000000";
const bookingId = "01J00000000000000000000001";
const eventId = "01J00000000000000000000002";
const foreignConversationId = "01J00000000000000000000009";
const at = "2026-07-30T20:22:00.000Z";
const bookingSnapshot = {
	id: bookingId,
	conversationId,
	status: "booked",
	name: "Александр",
	contacts: [{ channel: "telegram", value: "@alex" }],
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

	test("validates a minimal booking and rejects missing consent", () => {
		const input = {
			conversationId,
			idempotencyKey: "turn-booking-0001",
			name: "Александр",
			contacts: [{ channel: "telegram", value: "@alex" }],
			consentConfirmed: true,
		};

		expect(CreateBookingInputSchema.safeParse(input).success).toBe(true);
		expect(
			CreateBookingInputSchema.safeParse({ ...input, consentConfirmed: false })
				.success,
		).toBe(false);
	});

	test("allows an empty reusable patch only for skipped qualification input", () => {
		expect(QualificationPatchSchema.safeParse({}).success).toBe(true);
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
				contacts: [{ channel: "telegram", value: "@alex" }],
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

	test("validates complete non-empty MP3 TTS segments", () => {
		const segment = {
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			providerGenerationId: "provider-generation:opaque",
			contentType: "audio/mpeg",
			bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
			final: true,
		};
		expect(TtsAudioSegmentSchema.safeParse(segment).success).toBe(true);
		for (const invalid of [
			{ ...segment, generationId: "generation" },
			{ ...segment, segmentId: "segment" },
			{ ...segment, providerGenerationId: "" },
			{ ...segment, bytes: new Uint8Array() },
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

	test("pairs audio.segment metadata with one atomic binary MP3 payload", () => {
		const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
		const metadata = {
			generationId: "01J00000000000000000000004",
			segmentId: "01J00000000000000000000005",
			sequence: 0,
			contentType: "audio/mpeg",
			byteLength: bytes.byteLength,
			final: true,
		};
		expect(
			AtomicServerAudioSegmentFrameSchema.safeParse({ metadata, bytes })
				.success,
		).toBe(true);
		for (const invalidBytes of [new Uint8Array(), bytes.slice(0, 3)]) {
			expect(
				AtomicServerAudioSegmentFrameSchema.safeParse({
					metadata,
					bytes: invalidBytes,
				}).success,
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
				contacts: [{ channel: "telegram", value: "@alex" }],
				status: "booked",
				qualificationStatus: "none",
			},
		});

		expect(event.data.conversationId).toBe(conversationId);
	});
});
