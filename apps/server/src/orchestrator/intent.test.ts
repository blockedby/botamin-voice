import { describe, expect, test } from "bun:test";
import type { BookingSnapshot } from "@botamin/contracts";
import { classifyConservativeNegativeIntent } from "./orchestrator";
import { createInitialConversationState } from "./state";

const booking: BookingSnapshot = {
	id: "01J00000000000000000000001",
	conversationId: "01J00000000000000000000000",
	status: "booked",
	name: "Анна",
	contacts: [{ channel: "telegram", value: "@anna" }],
	qualificationStatus: "none",
	createdAt: "2026-07-30T20:22:00.000Z",
	updatedAt: "2026-07-30T20:22:00.000Z",
};

describe("conservative negative intent", () => {
	test("recognizes only clear pre-booking refusal", () => {
		const state = {
			...createInitialConversationState(),
			stage: "VALUE" as const,
		};
		expect(
			classifyConservativeNegativeIntent(
				"Нет, спасибо, мне не интересно.",
				state,
			),
		).toBe("pre_booking_refusal");
		for (const ambiguous of [
			"Не уверен, что сейчас удобно",
			"Нет времени сегодня, но расскажите подробнее",
			"Может быть позже",
		]) {
			expect(classifyConservativeNegativeIntent(ambiguous, state)).toBeNull();
		}
	});

	test("treats direct answer to the optional post-booking question as decline", () => {
		const booked = {
			...createInitialConversationState(),
			stage: "BOOKED" as const,
			booking,
			bookingConfirmationDelivered: true,
		};
		expect(
			classifyConservativeNegativeIntent("Нет, не задавайте.", booked),
		).toBe("qualification_decline");
		expect(
			classifyConservativeNegativeIntent(
				"Не уверен, что сейчас удобно.",
				booked,
			),
		).toBeNull();
	});

	test("requires an explicit qualification stop after consent", () => {
		const qualification = {
			...createInitialConversationState(),
			stage: "POST_BOOKING_QUALIFICATION" as const,
			booking,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted" as const,
		};
		expect(
			classifyConservativeNegativeIntent(
				"Не хочу отвечать на дополнительные вопросы",
				qualification,
			),
		).toBe("qualification_decline");
		expect(
			classifyConservativeNegativeIntent("Нет, CRM пока нет", qualification),
		).toBeNull();
	});
});
