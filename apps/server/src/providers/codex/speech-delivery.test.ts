import { describe, expect, test } from "bun:test";
import type { BrainTurnInput } from "@botamin/contracts";
import { modelSpeechForDelivery } from "./brain";

const firstLabel = "04 августа 2026 года, вторник, 09:00–09:20 по Москве";
const secondLabel = "04 августа 2026 года, вторник, 16:00–16:20 по Москве";

function input(stage: BrainTurnInput["stage"]): BrainTurnInput {
	return {
		conversationId: "01J00000000000000000000000",
		turnId: "01J00000000000000000000001",
		generationId: "01J00000000000000000000002",
		userText: "Тестовая реплика",
		stage,
		knownFacts: { useCases: [], painPoints: [], objections: [] },
		booking: null,
		schedulingContext: {
			currentInstant: "2026-08-03T09:00:00.000Z",
			moscowLocalDate: "2026-08-03",
			moscowWeekday: "понедельник",
			timeOfDayPreference: "none",
			rejectedTimeOfDayPreferences: [],
			concreteRequestInterpretation: { kind: "none" },
			candidateMeetingSlots: [
				{
					meetingSlot: {
						startAt: "2026-08-04T06:00:00.000Z",
						endAt: "2026-08-04T06:20:00.000Z",
						timeZone: "Europe/Moscow",
						durationMinutes: 20,
					},
					displayLabel: firstLabel,
				},
				{
					meetingSlot: {
						startAt: "2026-08-04T13:00:00.000Z",
						endAt: "2026-08-04T13:20:00.000Z",
						timeZone: "Europe/Moscow",
						durationMinutes: 20,
					},
					displayLabel: secondLabel,
				},
			],
		},
		allowedActions: [],
		promptVersion: "a".repeat(64),
	};
}

describe("server-owned model speech delivery shape", () => {
	test("replaces a verbose greeting with the canonical industry question", () => {
		expect(
			modelSpeechForDelivery(
				input("GREETING"),
				"DISCOVERY",
				"Очень длинное модельное вступление. Ещё одна ненужная фраза. Как устроены ваши продажи?",
			),
		).toBe("Я голосовой AI-консультант Botamin. Чем занимается ваша компания?");
	});

	test("authors the canonical hook and exact two slots for the compound funnel", () => {
		const delivered = modelSpeechForDelivery(
			input("DISCOVERY"),
			"COLLECT_BOOKING",
			"Непроверенный длинный ответ модели.",
		);
		expect(delivered).toContain("По брифу Botamin");
		expect(delivered).toContain("10–15 миллионов рублей в месяц");
		expect(delivered).toContain(firstLabel);
		expect(delivered).toContain(secondLabel);
		expect(delivered).toEndWith("Какой вариант выбрать?");
		expect(delivered).not.toContain("Непроверенный");
	});

	test("keeps at most one short final question from verbose ordinary speech", () => {
		const delivered = modelSpeechForDelivery(
			input("VALUE"),
			"VALUE",
			"Сначала модель долго пересказывает весь ответ посетителя и добавляет ненужные подробности без новой пользы. Затем продолжает ещё одной длинной мыслью. Какой результат для вас сейчас важнее?",
		);
		expect(delivered).toBe("Какой результат для вас сейчас важнее?");
	});

	test("does not rewrite protected booking collection speech", () => {
		const speech = "Точный серверно разрешённый текст остаётся без изменений.";
		expect(
			modelSpeechForDelivery(
				input("COLLECT_BOOKING"),
				"COLLECT_BOOKING",
				speech,
			),
		).toBe(speech);
	});
});
