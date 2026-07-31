import { describe, expect, test } from "bun:test";
import {
	AppendQualificationInputSchema,
	BookingDomainEventSchema,
	BookingToolExecutionSchema,
	ClientWsEventSchema,
	CreateBookingInputSchema,
	CreateConversationRequestSchema,
	EntityIdSchema,
	QualificationPatchSchema,
	ServerWsEventSchema,
} from "../src";

const conversationId = "01J00000000000000000000000";
const bookingId = "01J00000000000000000000001";
const eventId = "01J00000000000000000000002";
const at = "2026-07-30T20:22:00.000Z";

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

	test("rejects empty qualification patches", () => {
		expect(QualificationPatchSchema.safeParse({}).success).toBe(false);
		expect(
			AppendQualificationInputSchema.safeParse({
				bookingId,
				idempotencyKey: "qualification-0001",
				patch: { role: "Head of Sales" },
			}).success,
		).toBe(true);
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
