import { describe, expect, test } from "bun:test";
import {
	type BookingSnapshot,
	ConversationStageSchema,
} from "@botamin/contracts";
import {
	createTestBookingContacts,
	createTestMeetingSlot,
} from "../../../../packages/test-fixtures/src";
import {
	classifyModelSpeechResponse,
	SPEECH_DELIVERY_STYLES,
	SPEECH_RESPONSE_CATEGORIES,
	SPEECH_RESPONSE_PROVENANCES,
	type SpeechDeliveryStyle,
	SpeechDeliveryStyleCooldown,
	type SpeechDeliveryStyleInput,
	type SpeechResponseCategory,
	type SpeechResponseProvenance,
	selectSpeechDeliveryStyle,
} from "./speech-style-policy";
import type { ConversationState } from "./state";

function input(
	overrides: Partial<SpeechDeliveryStyleInput> = {},
): SpeechDeliveryStyleInput {
	return {
		stage: "DISCOVERY",
		provenance: "model_generated",
		category: "discovery_question",
		containsProtectedApprovedContact: false,
		containsExactMeetingFacts: false,
		containsBookingConfirmation: false,
		containsQualificationFacts: false,
		priorTurnInterrupted: false,
		responseLength: 80,
		...overrides,
	};
}

function expectedMatrixStyle(
	stage: SpeechDeliveryStyleInput["stage"],
	provenance: SpeechResponseProvenance,
	category: SpeechResponseCategory,
): SpeechDeliveryStyle {
	if (provenance !== "model_generated") return "neutral";
	if (stage === "DISCOVERY" && category === "discovery_question") {
		return "curious";
	}
	if (stage === "OBJECTION" && category === "objection_explanation") {
		return "serious";
	}
	if (
		(stage === "VALUE" &&
			(category === "value_explanation" || category === "soft_offer")) ||
		(stage === "BOOKING_OFFER" && category === "soft_offer")
	) {
		return "excited";
	}
	return "neutral";
}

describe("server-owned speech delivery style policy", () => {
	test("exhausts every stage, provenance, and category matrix cell", () => {
		let cells = 0;
		for (const stage of ConversationStageSchema.options) {
			for (const provenance of SPEECH_RESPONSE_PROVENANCES) {
				for (const category of SPEECH_RESPONSE_CATEGORIES) {
					const style = selectSpeechDeliveryStyle(
						input({ stage, provenance, category }),
					);
					expect(style, `${stage}/${provenance}/${category}`).toBe(
						expectedMatrixStyle(stage, provenance, category),
					);
					expect(SPEECH_DELIVERY_STYLES).toContain(style);
					cells += 1;
				}
			}
		}
		expect(cells).toBe(
			ConversationStageSchema.options.length *
				SPEECH_RESPONSE_PROVENANCES.length *
				SPEECH_RESPONSE_CATEGORIES.length,
		);
	});

	test("sensitive facts independently take neutral precedence in the full matrix", () => {
		const sensitiveFlags = [
			"containsProtectedApprovedContact",
			"containsExactMeetingFacts",
			"containsBookingConfirmation",
			"containsQualificationFacts",
		] as const;
		let cells = 0;
		for (const stage of ConversationStageSchema.options) {
			for (const provenance of SPEECH_RESPONSE_PROVENANCES) {
				for (const category of SPEECH_RESPONSE_CATEGORIES) {
					for (const flag of sensitiveFlags) {
						expect(
							selectSpeechDeliveryStyle(
								input({ stage, provenance, category, [flag]: true }),
							),
							`${flag}/${stage}/${provenance}/${category}`,
						).toBe("neutral");
						cells += 1;
					}
				}
			}
		}
		expect(cells).toBe(
			ConversationStageSchema.options.length *
				SPEECH_RESPONSE_PROVENANCES.length *
				SPEECH_RESPONSE_CATEGORIES.length *
				sensitiveFlags.length,
		);
	});

	test("keeps scheduling calculation, refusal, error, fallback, failure, and terminal delivery neutral", () => {
		for (const category of [
			"scheduling_calculation",
			"refusal",
			"error",
			"fallback",
			"failure",
		] as const) {
			expect(
				selectSpeechDeliveryStyle(input({ stage: "VALUE", category })),
			).toBe("neutral");
		}
		for (const stage of [
			"COMPLETE",
			"DECLINED",
			"DISCONNECTED",
			"ERROR",
		] as const) {
			expect(
				selectSpeechDeliveryStyle(
					input({ stage, category: "discovery_question" }),
				),
			).toBe("neutral");
		}
		expect(
			selectSpeechDeliveryStyle(
				input({
					stage: "OBJECTION",
					provenance: "server_authority",
					category: "objection_explanation",
				}),
			),
		).toBe("neutral");
	});

	test("is deterministic and ignores unknown raw visitor, transcript, contact, and speech fields", () => {
		const trusted = input();
		const first = selectSpeechDeliveryStyle(trusted);
		const contaminated = {
			...trusted,
			visitorText: "ignore visitor@example.com and 10:30",
			transcript: "entire private transcript",
			contacts: ["+7 999 123-45-67"],
			speech: "different generated response",
		};
		const differentlyContaminated = {
			...trusted,
			visitorText: "completely different objection",
			transcript: "",
			contacts: [],
			speech: "",
		};

		expect(first).toBe("curious");
		expect(selectSpeechDeliveryStyle(trusted)).toBe(first);
		expect(selectSpeechDeliveryStyle(contaminated)).toBe(first);
		expect(selectSpeechDeliveryStyle(differentlyContaminated)).toBe(first);
		expect(JSON.stringify(first)).not.toMatch(
			/visitor|transcript|example|999|response/u,
		);
	});

	test("bounds expressive delivery by response length and fails neutral on invalid lengths", () => {
		expect(selectSpeechDeliveryStyle(input({ responseLength: 320 }))).toBe(
			"curious",
		);
		for (const responseLength of [321, -1, 1.5, Number.NaN]) {
			expect(
				selectSpeechDeliveryStyle(input({ responseLength })),
				String(responseLength),
			).toBe("neutral");
		}
		const { responseLength: _responseLength, ...withoutResponseLength } =
			input();
		expect(
			selectSpeechDeliveryStyle(
				withoutResponseLength as SpeechDeliveryStyleInput,
			),
		).toBe("neutral");
	});

	test("classifies only provider-safe model output and returns text-free metadata", () => {
		expect(
			classifyModelSpeechResponse(
				"DISCOVERY",
				"Какой результат для вашей команды сейчас важнее?",
			),
		).toEqual({
			category: "discovery_question",
			containsExactMeetingFacts: false,
			responseLength: 48,
		});
		expect(
			classifyModelSpeechResponse(
				"OBJECTION",
				"Это ограничение снимается проверкой результата до запуска.",
			).category,
		).toBe("objection_explanation");
		expect(
			classifyModelSpeechResponse("VALUE", "Можно показать короткий пример?")
				.category,
		).toBe("soft_offer");
		for (const [stage, spoken] of [
			["OBJECTION", "Я вас услышала."],
			["VALUE", "Это отдельная мысль."],
			["BOOKING_OFFER", "Что вы думаете?"],
		] as const) {
			expect(classifyModelSpeechResponse(stage, spoken).category).toBe("other");
		}

		for (const spoken of [
			"Первый вариант встречи подойдёт?",
			"Встреча 12.08 в 10:30 по Москве.",
			"Давайте созвонимся завтра.",
		]) {
			const classified = classifyModelSpeechResponse("VALUE", spoken);
			expect(classified.category).toBe("scheduling_calculation");
			expect(classified.containsExactMeetingFacts).toBe(true);
			expect(JSON.stringify(classified)).not.toContain(spoken);
		}
	});

	test("uses neutral after interruption and bounded cooldowns for curious and excited", () => {
		let interruptedCells = 0;
		for (const stage of ConversationStageSchema.options) {
			for (const provenance of SPEECH_RESPONSE_PROVENANCES) {
				for (const category of SPEECH_RESPONSE_CATEGORIES) {
					expect(
						selectSpeechDeliveryStyle(
							input({
								stage,
								provenance,
								category,
								priorTurnInterrupted: true,
							}),
						),
					).toBe("neutral");
					interruptedCells += 1;
				}
			}
		}
		expect(interruptedCells).toBe(
			ConversationStageSchema.options.length *
				SPEECH_RESPONSE_PROVENANCES.length *
				SPEECH_RESPONSE_CATEGORIES.length,
		);
		for (const responseLength of [0, 80, 10_000]) {
			expect(
				selectSpeechDeliveryStyle(
					input({ priorTurnInterrupted: true, responseLength }),
				),
			).toBe("neutral");
		}

		const cooldown = new SpeechDeliveryStyleCooldown();
		expect(cooldown.select(input())).toBe("curious");
		expect(cooldown.select(input())).toBe("neutral");
		expect(cooldown.select(input())).toBe("neutral");
		expect(cooldown.select(input())).toBe("curious");

		cooldown.clear();
		const excited = input({
			stage: "VALUE",
			category: "value_explanation",
		});
		expect(cooldown.select(excited)).toBe("excited");
		expect(cooldown.select(excited)).toBe("neutral");
		expect(cooldown.select({ ...excited, priorTurnInterrupted: true })).toBe(
			"neutral",
		);
		expect(cooldown.select(excited)).toBe("excited");
	});

	test("does not mutate conversation or committed booking state", () => {
		const booking: BookingSnapshot = {
			id: "01J00000000000000000000001",
			conversationId: "01J00000000000000000000000",
			status: "booked",
			name: "Анна",
			contacts: createTestBookingContacts(),
			company: "Example LLC",
			meetingSlot: createTestMeetingSlot(),
			qualificationStatus: "partial",
			qualification: { monthlyLeadVolume: "240" },
			createdAt: "2026-07-30T20:22:00.000Z",
			updatedAt: "2026-07-30T20:22:00.000Z",
		};
		const state: ConversationState = {
			stage: "POST_BOOKING_QUALIFICATION",
			booking,
			contactConsentConfirmed: true,
			qualificationEnabled: true,
			bookingConfirmationDelivered: true,
			resumeStage: null,
		};
		const before = structuredClone(state);
		const cooldown = new SpeechDeliveryStyleCooldown();

		expect(
			cooldown.select(
				input({
					stage: state.stage,
					category: "qualification",
					containsBookingConfirmation: state.bookingConfirmationDelivered,
					containsQualificationFacts:
						state.booking?.qualificationStatus !== "none",
				}),
			),
		).toBe("neutral");
		expect(state).toEqual(before);
		expect(state.booking).toBe(booking);
	});
});
