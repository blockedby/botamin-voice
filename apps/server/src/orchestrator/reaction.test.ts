import { describe, expect, test } from "bun:test";
import type { LocalReactionClipId } from "@botamin/contracts";
import {
	hasPrivateOrExactReactionContent,
	selectLocalReaction,
} from "./reaction";

const turnId = "01J00000000000000000000003";
const generationId = "01J00000000000000000000004";

function supported(...clipIds: LocalReactionClipId[]) {
	return new Set<LocalReactionClipId>(clipIds);
}

describe("server-owned local reaction selection", () => {
	test("is deterministic and intersects stage trigger policy with client support", () => {
		const input = {
			turnId,
			generationId,
			stage: "OBJECTION" as const,
			userText: "Это звучит сложно",
			assistantText: "Разберём этот вопрос спокойно.",
			supportedClipIds: supported(
				"neutral-good",
				"objection-examine",
				"objection-more-detail",
			),
		};
		const first = selectLocalReaction(input);
		expect(first).toMatch(/^objection-/);
		expect(selectLocalReaction(input)).toBe(first);
		expect(
			selectLocalReaction({
				...input,
				supportedClipIds: supported("neutral-good"),
			}),
		).toBeNull();
	});

	test("uses fixed clarification IDs rather than visitor wording", () => {
		const clipId = selectLocalReaction({
			turnId,
			generationId,
			stage: "DISCOVERY",
			userText: "Не понял, поясните этот момент",
			assistantText: "Сформулирую проще.",
			supportedClipIds: supported(
				"clarification-one-point",
				"clarification-one-detail",
				"clarification-meaning",
			),
		});
		expect(clipId).toMatch(/^clarification-/);
		expect(clipId).not.toContain("понял");
	});

	test("fails closed for terminal, booking/contact, date, and exact factual output", () => {
		const base = {
			turnId,
			generationId,
			stage: "DISCOVERY" as const,
			userText: "Расскажите подробнее",
			assistantText: "Покажу общий подход.",
			supportedClipIds: supported("neutral-good"),
		};
		expect(selectLocalReaction(base)).toBe("neutral-good");
		for (const stage of [
			"COLLECT_BOOKING",
			"BOOKED",
			"POST_BOOKING_QUALIFICATION",
			"COMPLETE",
			"DECLINED",
			"DISCONNECTED",
			"ERROR",
		] as const) {
			expect(selectLocalReaction({ ...base, stage })).toBeNull();
		}
		for (const text of [
			"Моя почта visitor@example.com",
			"Позвоните +7 999 123-45-67",
			"Встреча 12 августа в 10:30",
			"Стоимость составляет 25 000 ₽",
			"Точный срок — 4 дня",
		]) {
			expect(hasPrivateOrExactReactionContent(text)).toBe(true);
			expect(selectLocalReaction({ ...base, userText: text })).toBeNull();
			expect(selectLocalReaction({ ...base, assistantText: text })).toBeNull();
		}
	});
});
