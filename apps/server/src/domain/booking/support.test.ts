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
		for (const [text, preference] of [
			["Лучше утром", "morning"],
			["утро", "morning"],
			["Давайте с утра", "morning"],
			["Удобно днём", "daytime"],
			["день", "daytime"],
			["Во второй половине дня", "second_half"],
			["вторая половина дня", "second_half"],
			["Можно только вечером", "evening"],
			["вечер", "evening"],
			["сегодня в одиннадцать часов вечера", "evening"],
			["Давайте в десять часов утра", "morning"],
			["Подойдёт два часа дня", "daytime"],
		] as const) {
			expect(parseMeetingTimePreference(text)).toEqual({
				kind: "selected",
				preference,
			});
		}
		for (const text of [
			"Мне неудобно вечером",
			"Вечером не могу",
			"Не вечером",
		]) {
			expect(parseMeetingTimePreference(text)).toEqual({
				kind: "rejected",
				preference: "evening",
			});
		}
		for (const text of [
			"Добрый вечер",
			"Добрый день",
			"Сегодня удобно созвониться",
			"Не только вечером",
			"Не уверен, что вечером будет удобно?",
			"Вечером не всегда удобно",
			"Мне не очень удобно вечером",
		]) {
			expect(parseMeetingTimePreference(text)).toEqual({ kind: "no_mention" });
		}
		expect(() =>
			generateCandidateMeetingSlots(thursday, [], "night" as never),
		).toThrow();
		expect(() =>
			generateCandidateMeetingSlots(thursday, [], "evening", ["evening"]),
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

	test("keeps one morning and one evening after partial contextual collisions", () => {
		const anchors = generateCandidateMeetingSlots(thursday);
		const moved = generateCandidateMeetingSlots(
			thursday,
			anchors.map((slot) => slot.startAt),
		);
		expect(moved[0].startAt.slice(0, 10)).toBe("2025-01-10");
		expect(localTimes(moved)).toEqual(["09:20", "16:20"]);
	});

	test("rolls to a later weekday when all contextual bands are occupied", () => {
		const occupied = [
			...Array.from({ length: 9 }, (_, index) => 9 * 60 + index * 20),
			...Array.from({ length: 4 }, (_, index) => 16 * 60 + index * 20),
		].map((minute) => {
			const hour = Math.floor(minute / 60);
			const minuteOfHour = minute % 60;
			return new Date(
				Date.UTC(2025, 0, 10, hour - 3, minuteOfHour),
			).toISOString();
		});
		const rolled = generateCandidateMeetingSlots(thursday, occupied);
		expect(rolled.map((slot) => slot.startAt)).toEqual([
			"2025-01-13T06:00:00.000Z",
			"2025-01-13T13:00:00.000Z",
		]);
		expect(localTimes(rolled)).toEqual(["09:00", "16:00"]);
	});

	test("a bare evening rejection proposes morning and daytime only", () => {
		const slots = generateCandidateMeetingSlots(thursday, [], "none", [
			"evening",
		]);
		expect(localTimes(slots)).toEqual(["09:00", "14:00"]);
		expect(localTimes(slots).every((time) => time < "16:00")).toBe(true);
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
		expect(parseMeetingTimePreference("Подойдёт в 23:00")).toEqual({
			kind: "selected",
			preference: "evening",
		});
		const slots = generateCandidateMeetingSlots(thursday, [], "evening");
		expect(localTimes(slots)).toEqual(["16:00", "17:00"]);
		expect(slots.every((slot) => slot.timeZone === "Europe/Moscow")).toBe(true);
		expect(slots.every((slot) => slot.durationMinutes === 20)).toBe(true);
	});
});
