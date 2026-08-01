import { describe, expect, test } from "bun:test";
import {
	type BookingSnapshot,
	type ConversationStage,
	ConversationStageSchema,
} from "@botamin/contracts";
import {
	createTestBookingContacts,
	createTestMeetingSlot,
} from "../../../../packages/test-fixtures/src";
import {
	type ConversationEvent,
	type ConversationState,
	createInitialConversationState,
	TRANSITION_TABLE,
	transition,
} from "./state";

const conversationId = "01J00000000000000000000000";
const booking: BookingSnapshot = {
	id: "01J00000000000000000000001",
	conversationId,
	status: "booked",
	name: "Анна",
	contacts: createTestBookingContacts(),
	company: "Example LLC",
	meetingSlot: createTestMeetingSlot(),
	qualificationStatus: "none",
	createdAt: "2026-07-30T20:22:00.000Z",
	updatedAt: "2026-07-30T20:22:00.000Z",
};

function stateAt(stage: ConversationStage): ConversationState {
	return { ...createInitialConversationState(), stage };
}

function apply(
	state: ConversationState,
	event: ConversationEvent,
): ConversationState {
	const result = transition(state, event);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.message);
	return result.state;
}

describe("conversation transition policy", () => {
	for (const [from, event, to] of TRANSITION_TABLE) {
		test(`${from} + ${event} -> ${to}`, () => {
			const result = transition(stateAt(from), { type: event });
			expect(result).toMatchObject({ ok: true, state: { stage: to } });
		});
	}

	test("the static table contains no ambiguous edge", () => {
		const keys = TRANSITION_TABLE.map(([from, event]) => `${from}:${event}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("the full stage/event matrix is deterministic and returns a typed result", () => {
		const events: ConversationEvent[] = [
			{ type: "start" },
			{ type: "connected" },
			{ type: "discovery_requested" },
			{ type: "value_ready" },
			{ type: "objection_raised" },
			{ type: "objection_resolved" },
			{ type: "booking_offered" },
			{ type: "booking_accepted" },
			{ type: "contact_consent_confirmed" },
			{ type: "booking_committed", booking },
			{ type: "booking_confirmation_delivered" },
			{ type: "qualification_consent_granted" },
			{ type: "qualification_consent_declined" },
			{ type: "qualification_updated", booking },
			{ type: "qualification_completed" },
			{ type: "complete" },
			{ type: "clear_refusal" },
			{ type: "disconnect" },
			{ type: "reconnect" },
			{ type: "provider_failed" },
		];
		let cells = 0;
		for (const stage of ConversationStageSchema.options) {
			for (const event of events) {
				const state = stateAt(stage);
				const first = transition(state, event);
				const second = transition(state, event);
				expect(second).toEqual(first);
				if (first.ok) {
					expect(
						ConversationStageSchema.safeParse(first.state.stage).success,
					).toBe(true);
				} else {
					expect(first.message.length).toBeGreaterThan(0);
				}
				cells += 1;
			}
		}
		expect(cells).toBe(ConversationStageSchema.options.length * events.length);
	});

	test("qualification requires commit, confirmation, feature flag, and consent", () => {
		for (const stage of [
			"IDLE",
			"GREETING",
			"DISCOVERY",
			"VALUE",
			"BOOKING_OFFER",
			"COLLECT_BOOKING",
		] as const) {
			const result = transition(stateAt(stage), {
				type: "qualification_consent_granted",
			});
			expect(result.ok).toBe(false);
		}

		let state = stateAt("COLLECT_BOOKING");
		state = apply(state, { type: "contact_consent_confirmed" });
		state = apply(state, { type: "booking_committed", booking });
		expect(
			transition(state, { type: "qualification_consent_granted" }),
		).toMatchObject({ ok: false, code: "CONFIRMATION_REQUIRED" });
		state = apply(state, { type: "booking_confirmation_delivered" });
		state = apply(state, { type: "qualification_consent_granted" });
		expect(state).toMatchObject({
			stage: "POST_BOOKING_QUALIFICATION",
			booking: { id: booking.id, status: "booked" },
			qualificationConsent: "granted",
		});

		const disabled = {
			...stateAt("BOOKED"),
			booking,
			bookingConfirmationDelivered: true,
			qualificationEnabled: false,
		};
		expect(
			transition(disabled, { type: "qualification_consent_granted" }),
		).toMatchObject({ ok: false, code: "QUALIFICATION_DISABLED" });
	});

	test("qualification refusal is optional, post-booking, and after confirmation only", () => {
		const unconfirmed = { ...stateAt("BOOKED"), booking };
		expect(
			transition(unconfirmed, { type: "qualification_consent_declined" }),
		).toMatchObject({ ok: false, code: "CONFIRMATION_REQUIRED" });
		const confirmed = {
			...unconfirmed,
			bookingConfirmationDelivered: true,
		};
		expect(
			transition(confirmed, { type: "qualification_consent_declined" }),
		).toMatchObject({
			ok: true,
			state: {
				stage: "COMPLETE",
				qualificationConsent: "declined",
				booking: { id: booking.id },
			},
		});
	});

	test("clear refusal ends once and never removes an existing booking", () => {
		const beforeBooking = transition(stateAt("VALUE"), {
			type: "clear_refusal",
		});
		expect(beforeBooking).toMatchObject({
			ok: true,
			state: { stage: "DECLINED", booking: null },
		});

		const booked = {
			...stateAt("POST_BOOKING_QUALIFICATION"),
			booking,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted" as const,
		};
		const afterBooking = transition(booked, { type: "clear_refusal" });
		expect(afterBooking).toMatchObject({
			ok: true,
			state: {
				stage: "COMPLETE",
				booking: { id: booking.id, status: "booked" },
			},
		});
		expect(
			transition(afterBooking.ok ? afterBooking.state : booked, {
				type: "clear_refusal",
			}),
		).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
	});

	test("disconnect and reconnect restore stage and preserve committed booking", () => {
		const active = {
			...stateAt("POST_BOOKING_QUALIFICATION"),
			booking,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted" as const,
		};
		const disconnected = apply(active, { type: "disconnect" });
		expect(disconnected).toMatchObject({
			stage: "DISCONNECTED",
			resumeStage: "POST_BOOKING_QUALIFICATION",
			booking: { id: booking.id },
		});
		const resumed = apply(disconnected, { type: "reconnect" });
		expect(resumed).toMatchObject({
			stage: "POST_BOOKING_QUALIFICATION",
			resumeStage: null,
			booking: { id: booking.id },
		});
	});

	test("qualification patches preserve booking identity and update snapshot", () => {
		const state = {
			...stateAt("POST_BOOKING_QUALIFICATION"),
			booking,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted" as const,
		};
		const updated = {
			...booking,
			qualification: { role: "РОП" },
			qualificationStatus: "partial" as const,
		};
		expect(
			transition(state, { type: "qualification_updated", booking: updated }),
		).toMatchObject({
			ok: true,
			state: { booking: { qualificationStatus: "partial" } },
		});
		expect(
			transition(state, {
				type: "qualification_updated",
				booking: { ...updated, id: "01J00000000000000000000099" },
			}),
		).toMatchObject({ ok: false, code: "BOOKING_MISMATCH" });
	});

	test("provider failure changes status but never compensates a booking", () => {
		expect(
			transition(stateAt("DISCOVERY"), { type: "provider_failed" }),
		).toMatchObject({ ok: true, state: { stage: "ERROR", booking: null } });
		const result = transition(
			{ ...stateAt("BOOKED"), booking },
			{ type: "provider_failed" },
		);
		expect(result).toMatchObject({
			ok: true,
			state: { stage: "ERROR", booking: { id: booking.id } },
		});
	});
});
