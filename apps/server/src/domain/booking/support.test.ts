import { describe, expect, test } from "bun:test";
import type { MeetingSlot } from "@botamin/contracts";
import {
	generateCandidateMeetingSlots,
	parseMeetingTimePreference,
} from "./support";

const thursday = new Date("2025-01-09T09:00:00.000Z");
const friday = new Date("2025-01-10T09:00:00.000Z");

function localTimes(slots: readonly Pick<MeetingSlot, "startAt">[]): string[] {
	return slots.map((slot) =>
		new Date(new Date(slot.startAt).getTime() + 3 * 60 * 60_000)
			.toISOString()
			.slice(11, 16),
	);
}

describe("server-owned contextual Moscow slots", () => {
	test("uses one morning and one evening default after Thursday or Friday", () => {
		expect(localTimes(generateCandidateMeetingSlots(thursday))).toEqual([
			"09:00",
			"16:00",
		]);
		expect(localTimes(generateCandidateMeetingSlots(friday))).toEqual([
			"09:00",
			"16:00",
		]);
		expect(generateCandidateMeetingSlots(thursday)[0].startAt).toBe(
			"2025-01-10T06:00:00.000Z",
		);
		expect(generateCandidateMeetingSlots(friday)[0].startAt).toBe(
			"2025-01-13T06:00:00.000Z",
		);
	});

	test("parses bounded Russian typed and spoken preference variants", () => {
		expect(parseMeetingTimePreference("Лучше утром")).toBe("morning");
		expect(parseMeetingTimePreference("утро")).toBe("morning");
		expect(parseMeetingTimePreference("Давайте с утра")).toBe("morning");
		expect(parseMeetingTimePreference("Удобно днём")).toBe("daytime");
		expect(parseMeetingTimePreference("день")).toBe("daytime");
		expect(parseMeetingTimePreference("Во второй половине дня")).toBe(
			"second_half",
		);
		expect(parseMeetingTimePreference("вторая половина дня")).toBe(
			"second_half",
		);
		expect(parseMeetingTimePreference("Можно только вечером")).toBe("evening");
		expect(parseMeetingTimePreference("вечер")).toBe("evening");
		expect(
			parseMeetingTimePreference(
				"Нет, я бы хотел сегодня в одиннадцать часов вечера",
			),
		).toBe("evening");
		expect(parseMeetingTimePreference("Давайте в десять часов утра")).toBe(
			"morning",
		);
		expect(parseMeetingTimePreference("Подойдёт два часа дня")).toBe("daytime");
		expect(parseMeetingTimePreference("Добрый вечер")).toBeNull();
		expect(parseMeetingTimePreference("Добрый день")).toBeNull();
		expect(parseMeetingTimePreference("Сегодня удобно созвониться")).toBeNull();
		expect(parseMeetingTimePreference("Не вечером")).toBeNull();
		expect(() =>
			generateCandidateMeetingSlots(thursday, [], "night" as never),
		).toThrow();
	});

	test("selects anchor pairs roughly one hour apart in each requested band", () => {
		expect(
			localTimes(generateCandidateMeetingSlots(thursday, [], "morning")),
		).toEqual(["09:00", "10:00"]);
		expect(
			localTimes(generateCandidateMeetingSlots(thursday, [], "daytime")),
		).toEqual(["14:00", "15:00"]);
		expect(
			localTimes(generateCandidateMeetingSlots(thursday, [], "second_half")),
		).toEqual(["14:00", "15:00"]);
		expect(
			localTimes(generateCandidateMeetingSlots(thursday, [], "evening")),
		).toEqual(["16:00", "17:00"]);
	});

	test("moves occupied anchors to the nearest conflict-free pair in-band", () => {
		const anchors = generateCandidateMeetingSlots(thursday, [], "morning");
		const moved = generateCandidateMeetingSlots(
			thursday,
			anchors.map((slot) => slot.startAt),
			"morning",
		);
		expect(localTimes(moved)).toEqual(["09:20", "10:20"]);
		expect(new Set(moved.map((slot) => slot.startAt)).size).toBe(2);
	});

	test("uses broader policy fallback only after an evening band is occupied", () => {
		const eveningBand = ["16:00", "16:20", "16:40", "17:00"].map((time) => {
			const [hour, minute] = time.split(":").map(Number);
			return new Date(
				Date.UTC(2025, 0, 10, (hour as number) - 3, minute),
			).toISOString();
		});
		const fallback = generateCandidateMeetingSlots(
			thursday,
			eveningBand,
			"evening",
		);
		expect(fallback).toHaveLength(2);
		expect(localTimes(fallback).every((time) => time < "16:00")).toBe(true);
	});

	test("maps an exact 23:00 request to policy-safe evening alternatives", () => {
		expect(parseMeetingTimePreference("Подойдёт в 23:00")).toBe("evening");
		const slots = generateCandidateMeetingSlots(thursday, [], "evening");
		expect(localTimes(slots)).toEqual(["16:00", "17:00"]);
		expect(slots.every((slot) => slot.timeZone === "Europe/Moscow")).toBe(true);
		expect(slots.every((slot) => slot.durationMinutes === 20)).toBe(true);
	});
});
