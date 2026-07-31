import { describe, expect, test } from "bun:test";
import type { CreateBookingInput } from "@botamin/contracts";
import { FakeBookingService } from "../../../../packages/test-fixtures/src";
import { allowedActions, authorizeTool, BookingToolExecutor } from "./policy";
import {
	type ConversationState,
	createInitialConversationState,
} from "./state";

const conversationId = "01J00000000000000000000000";
const input: CreateBookingInput = {
	conversationId,
	idempotencyKey: "booking-policy-0001",
	name: "Анна",
	contacts: [{ channel: "email", value: "anna@example.com" }],
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
			authorizeTool(collectionState(false), conversationId, request),
		).toMatchObject({ ok: false, code: "ACTION_NOT_ALLOWED_IN_STATE" });
		expect(
			authorizeTool(collectionState(true), conversationId, request),
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
			authorizeTool(collectionState(), conversationId, mismatch),
		).toMatchObject({ ok: false, code: "ACTION_NOT_ALLOWED_IN_STATE" });

		const beforeBooking = authorizeTool(collectionState(), conversationId, {
			name: "append_booking_qualification",
			callId: "call-qualification-1",
			args: {
				bookingId: "01J00000000000000000000001",
				idempotencyKey: "qualification-0001",
				patch: { role: "РОП" },
				completion: "partial",
			},
		});
		expect(beforeBooking).toMatchObject({
			ok: false,
			code: "ACTION_NOT_ALLOWED_IN_STATE",
		});
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

	test("executor deduplicates identical callId and rejects changed replay", async () => {
		const service = new FakeBookingService();
		const executor = new BookingToolExecutor(service);
		const first = await executor.execute(
			collectionState(),
			conversationId,
			request,
		);
		const replay = await executor.execute(
			collectionState(),
			conversationId,
			request,
		);
		const conflict = await executor.execute(collectionState(), conversationId, {
			...request,
			args: { ...request.args, name: "Другое имя" },
		});

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
