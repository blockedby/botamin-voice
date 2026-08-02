import { describe, expect, test } from "bun:test";
import type { CreateBookingInput } from "@botamin/contracts";
import {
	createTestBookingContacts,
	createTestMeetingSlot,
	FakeBookingService,
} from "../../../../packages/test-fixtures/src";
import { allowedActions, authorizeTool, BookingToolExecutor } from "./policy";
import {
	type ConversationState,
	createInitialConversationState,
} from "./state";

const conversationId = "01J00000000000000000000000";
const candidateMeetingSlots = [
	createTestMeetingSlot(),
	createTestMeetingSlot(1),
] as const;
const input: CreateBookingInput = {
	conversationId,
	idempotencyKey: "booking-policy-0001",
	name: "Анна",
	contacts: createTestBookingContacts(),
	company: "Example LLC",
	meetingSlot: createTestMeetingSlot(),
	consentConfirmed: true,
};
const request = {
	name: "create_booking" as const,
	callId: "call-create-1",
	args: input,
};

function collectionState(consent = true): ConversationState {
	return {
		...createInitialConversationState(),
		stage: "COLLECT_BOOKING",
		contactConsentConfirmed: consent,
	};
}

describe("allowed action and tool authorization policy", () => {
	test("create_booking needs collection stage and server-side consent", () => {
		expect(allowedActions(collectionState(false))).toEqual([]);
		expect(allowedActions(collectionState(true))).toEqual(["create_booking"]);
		expect(
			authorizeTool(
				collectionState(false),
				conversationId,
				candidateMeetingSlots,
				request,
			),
		).toMatchObject({ ok: false, code: "ACTION_NOT_ALLOWED_IN_STATE" });
		expect(
			authorizeTool(
				collectionState(true),
				conversationId,
				candidateMeetingSlots,
				request,
			),
		).toMatchObject({ ok: true });
	});

	test("model-provided conversation and booking IDs never override session state", () => {
		const mismatch = {
			...request,
			args: {
				...input,
				conversationId: "01J00000000000000000000099",
			},
		};
		expect(
			authorizeTool(
				collectionState(),
				conversationId,
				candidateMeetingSlots,
				mismatch,
			),
		).toMatchObject({ ok: false, code: "ACTION_NOT_ALLOWED_IN_STATE" });

		const beforeBooking = authorizeTool(
			collectionState(),
			conversationId,
			candidateMeetingSlots,
			{
				name: "append_booking_qualification",
				callId: "call-qualification-1",
				args: {
					bookingId: "01J00000000000000000000001",
					idempotencyKey: "qualification-0001",
					patch: { salesManagerCount: 8 },
					completion: "partial",
				},
			},
		);
		expect(beforeBooking).toMatchObject({
			ok: false,
			code: "ACTION_NOT_ALLOWED_IN_STATE",
		});
	});

	test("rejects a structurally valid meeting slot not supplied for the active turn", () => {
		const nonCandidate = {
			...request,
			args: {
				...request.args,
				meetingSlot: {
					startAt: "2099-01-06T06:00:00.000Z",
					endAt: "2099-01-06T06:20:00.000Z",
					timeZone: "Europe/Moscow" as const,
					durationMinutes: 20 as const,
				},
			},
		};

		expect(
			authorizeTool(
				collectionState(),
				conversationId,
				candidateMeetingSlots,
				nonCandidate,
			),
		).toMatchObject({ ok: false, code: "BOOKING_VALIDATION_FAILED" });
	});

	test("rejects stale and out-of-policy slots after contextual candidates change", () => {
		const eveningCandidates = [
			{
				startAt: "2099-01-05T13:00:00.000Z",
				endAt: "2099-01-05T13:20:00.000Z",
				timeZone: "Europe/Moscow" as const,
				durationMinutes: 20 as const,
			},
			{
				startAt: "2099-01-05T14:00:00.000Z",
				endAt: "2099-01-05T14:20:00.000Z",
				timeZone: "Europe/Moscow" as const,
				durationMinutes: 20 as const,
			},
		] as const;
		expect(
			authorizeTool(
				collectionState(),
				conversationId,
				eveningCandidates,
				request,
			),
		).toMatchObject({ ok: false, code: "BOOKING_VALIDATION_FAILED" });
		expect(
			authorizeTool(collectionState(), conversationId, eveningCandidates, {
				...request,
				args: {
					...request.args,
					meetingSlot: {
						startAt: "2099-01-05T20:00:00.000Z",
						endAt: "2099-01-05T20:20:00.000Z",
						timeZone: "Europe/Moscow",
						durationMinutes: 20,
					},
				},
			}),
		).toMatchObject({ ok: false, code: "BOOKING_VALIDATION_FAILED" });
	});

	test("qualification is allowed only after confirmation and explicit consent", async () => {
		const service = new FakeBookingService();
		const created = await service.createBooking(input);
		const booking = await service.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const base: ConversationState = {
			...createInitialConversationState(),
			stage: "BOOKED",
			booking,
			contactConsentConfirmed: true,
			bookingConfirmationDelivered: true,
		};
		expect(allowedActions(base)).toEqual([]);
		expect(
			allowedActions({
				...base,
				stage: "POST_BOOKING_QUALIFICATION",
				qualificationConsent: "granted",
			}),
		).toEqual(["append_booking_qualification"]);
		expect(created.status).toBe("booked");
	});

	test("server boundary rejects legacy role-only and CRM-only qualification patches", async () => {
		const service = new FakeBookingService();
		await service.createBooking(input);
		const booking = await service.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const state: ConversationState = {
			...createInitialConversationState(),
			stage: "POST_BOOKING_QUALIFICATION",
			booking,
			contactConsentConfirmed: true,
			bookingConfirmationDelivered: true,
			qualificationEnabled: true,
			qualificationConsent: "granted",
		};
		const executor = new BookingToolExecutor(service);
		for (const [field, value] of [
			["role", "РОП"],
			["crm", "amoCRM"],
		] as const) {
			const request = {
				name: "append_booking_qualification",
				callId: `legacy-${field}`,
				args: {
					bookingId: booking.id,
					idempotencyKey: `legacy-${field}-0001`,
					patch: { [field]: value },
					completion: "partial",
				},
			};
			expect(
				authorizeTool(state, conversationId, candidateMeetingSlots, request),
			).toMatchObject({ ok: false, code: "BOOKING_VALIDATION_FAILED" });
			expect(
				await executor.execute(
					state,
					conversationId,
					candidateMeetingSlots,
					request,
				),
			).toMatchObject({ ok: false, code: "BOOKING_VALIDATION_FAILED" });
		}
		expect(service.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
		]);
		expect(await service.findByConversationId(conversationId)).toMatchObject({
			qualificationStatus: "none",
		});
	});

	test("executor replays a qualification call without a duplicate durable update", async () => {
		const service = new FakeBookingService();
		await service.createBooking(input);
		const booking = await service.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const state: ConversationState = {
			...createInitialConversationState(),
			stage: "POST_BOOKING_QUALIFICATION",
			booking,
			contactConsentConfirmed: true,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted",
		};
		const executor = new BookingToolExecutor(service);
		const qualificationRequest = {
			name: "append_booking_qualification" as const,
			callId: "qualification-replay-call",
			args: {
				bookingId: booking.id,
				idempotencyKey: "qualification-replay-key",
				patch: { monthlyLeadVolume: "около 240" },
				completion: "complete" as const,
			},
		};

		const first = await executor.execute(
			state,
			conversationId,
			candidateMeetingSlots,
			qualificationRequest,
		);
		const replay = await executor.execute(
			state,
			conversationId,
			candidateMeetingSlots,
			qualificationRequest,
		);
		expect(first).toMatchObject({
			ok: true,
			value: {
				replayedCall: false,
				result: { qualificationStatus: "partial" },
			},
		});
		expect(replay).toMatchObject({
			ok: true,
			value: {
				replayedCall: true,
				result: { qualificationStatus: "partial" },
			},
		});
		expect(service.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
			"booking.updated",
		]);
	});

	test("executor deduplicates identical callId and rejects changed replay", async () => {
		const service = new FakeBookingService();
		const executor = new BookingToolExecutor(service);
		const first = await executor.execute(
			collectionState(),
			conversationId,
			candidateMeetingSlots,
			request,
		);
		const replay = await executor.execute(
			collectionState(),
			conversationId,
			candidateMeetingSlots,
			request,
		);
		const conflict = await executor.execute(
			collectionState(),
			conversationId,
			candidateMeetingSlots,
			{
				...request,
				args: { ...request.args, name: "Другое имя" },
			},
		);

		expect(first).toMatchObject({
			ok: true,
			value: { replayedCall: false },
		});
		expect(replay).toMatchObject({
			ok: true,
			value: { replayedCall: true },
		});
		expect(conflict).toMatchObject({
			ok: false,
			code: "IDEMPOTENCY_CONFLICT",
		});
		expect(service.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
		]);
	});
});
