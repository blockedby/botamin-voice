import { describe, expect, test } from "bun:test";
import type { BookingSnapshot } from "@botamin/contracts";
import {
	createTestBookingContacts,
	createTestMeetingSlot,
} from "../../../../packages/test-fixtures/src";
import { classifyConservativeNegativeIntent } from "./orchestrator";
import { createInitialConversationState } from "./state";

const booking: BookingSnapshot = {
	id: "01J00000000000000000000001",
	conversationId: "01J00000000000000000000000",
	status: "booked",
	name: "Анна",
	contacts: createTestBookingContacts(),
	company: "Example LLC",
	meetingSlot: createTestMeetingSlot(),
	qualificationStatus: "none",
	createdAt: "2026-07-30T20:22:00.000Z",
	updatedAt: "2026-07-30T20:22:00.000Z",
};

describe("conservative negative intent", () => {
	test("recognizes bounded, unambiguous pre-booking refusals", () => {
		const state = {
			...createInitialConversationState(),
			stage: "VALUE" as const,
		};
		for (const refusal of [
			"Нет, спасибо, мне не интересно.",
			"Нет, я не заинтересован",
			"Это не актуально, до свидания.",
			"Я не заинтересована.",
			"Нас это не интересует.",
			"Давайте закончим разговор.",
		]) {
			expect(classifyConservativeNegativeIntent(refusal, state)).toBe(
				"pre_booking_refusal",
			);
		}
	});

	test("does not treat objections, questions, or contextual negation as refusal", () => {
		const state = {
			...createInitialConversationState(),
			stage: "VALUE" as const,
		};
		for (const ambiguous of [
			"Не сейчас",
			"Не уверен, что сейчас удобно",
			"Не подходит по цене",
			"Мне не интересно?",
			"Это не актуально?",
			"Нет времени сегодня, но расскажите подробнее",
			"Нет, у нас нет CRM, расскажите об интеграции",
			"Я не заинтересован в скидке, расскажите о продукте",
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
