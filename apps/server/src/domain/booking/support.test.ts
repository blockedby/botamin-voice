import { describe, expect, test } from "bun:test";
import type { MeetingSlot } from "@botamin/contracts";
import {
	generateCandidateMeetingSlots,
	generateMeetingSlotProposal,
	parseConcreteMeetingRequest,
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

	test("rolls to the next weekday when the requested evening band is occupied", () => {
		const eveningBand = ["16:00", "16:20", "16:40", "17:00"].map((time) => {
			const [hour, minute] = time.split(":").map(Number);
			return new Date(
				Date.UTC(2025, 0, 10, (hour as number) - 3, minute),
			).toISOString();
		});
		const rolled = generateCandidateMeetingSlots(
			thursday,
			eveningBand,
			"evening",
		);
		expect(localTimes(rolled)).toEqual(["16:00", "17:00"]);
		expect(rolled[0].startAt).toBe("2025-01-13T13:00:00.000Z");
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

describe("concrete Moscow date/time requests", () => {
	const now = new Date("2026-08-02T05:00:00.000Z");

	function moscowStartAt(date: string, time: string): string {
		const [year, month, day] = date.split("-").map(Number);
		const [hour, minute] = time.split(":").map(Number);
		return new Date(
			Date.UTC(
				year as number,
				(month as number) - 1,
				day,
				(hour as number) - 3,
				minute,
			),
		).toISOString();
	}

	test("parses supported absolute, relative, and explicit-year forms", () => {
		for (const text of [
			"4 августа в 11",
			"4 августа в 11:00",
			"4 августа 2026 года в 11:00",
			"послезавтра в 11:00",
		]) {
			expect(parseConcreteMeetingRequest(text, now)).toEqual({
				kind: "valid",
				requestedMoscowDate: "2026-08-04",
				minuteOfDay: 11 * 60,
				startAt: "2026-08-04T08:00:00.000Z",
			});
		}
		expect(parseConcreteMeetingRequest("завтра в 09:20", now)).toEqual({
			kind: "valid",
			requestedMoscowDate: "2026-08-03",
			minuteOfDay: 9 * 60 + 20,
			startAt: "2026-08-03T06:20:00.000Z",
		});
	});

	test("includes 4 August at 11:00 and pairs the nearest same-date start", () => {
		const proposal = generateMeetingSlotProposal(now, "4 августа в 11");
		expect(proposal.slots.map((slot) => slot.startAt)).toEqual([
			"2026-08-04T07:40:00.000Z",
			"2026-08-04T08:00:00.000Z",
		]);
		expect(proposal.requestedDateSatisfied).toBe(true);
		expect(proposal.requestedExactTimeIncluded).toBe(true);
		expect(new Set(proposal.slots.map((slot) => slot.startAt)).size).toBe(2);
	});

	test("rejects Moscow today rather than rolling an omitted year", () => {
		for (const text of ["2 августа в 11", "сегодня в 11:00"]) {
			expect(parseConcreteMeetingRequest(text, now)).toMatchObject({
				kind: "invalid_or_ambiguous",
				reason: "same_day",
				requestedMoscowDate: "2026-08-02",
			});
		}
	});

	test("rejects weekends, past years, policy-invalid times, and long input", () => {
		for (const [text, reason] of [
			["8 августа в 11", "weekend"],
			["4 августа 2025 в 11", "past"],
			["4 августа в 08:40", "outside_hours"],
			["4 августа в 17:20", "outside_hours"],
			["4 августа в 11:10", "off_grid"],
			["4 августа в 25:00", "invalid_time"],
		] as const) {
			expect(parseConcreteMeetingRequest(text, now)).toMatchObject({
				kind: "invalid_or_ambiguous",
				reason,
			});
		}
		expect(parseConcreteMeetingRequest("x".repeat(501), now)).toEqual({
			kind: "invalid_or_ambiguous",
			reason: "too_long",
		});
	});

	test("resolves omitted years forward and validates leap/calendar dates", () => {
		expect(parseConcreteMeetingRequest("4 января в 11", now)).toMatchObject({
			kind: "valid",
			requestedMoscowDate: "2027-01-04",
		});
		for (const text of [
			"29 февраля в 11",
			"29 февраля 2027 в 11",
			"31 апреля 2027 в 11",
		]) {
			expect(parseConcreteMeetingRequest(text, now)).toEqual({
				kind: "invalid_or_ambiguous",
				reason: "invalid_date",
			});
		}
		expect(
			parseConcreteMeetingRequest("29 февраля 2028 в 11", now),
		).toMatchObject({
			kind: "valid",
			requestedMoscowDate: "2028-02-29",
		});
	});

	test("accepts the 20-minute grid and rejects off-grid starts", () => {
		expect(parseConcreteMeetingRequest("4 августа в 11:20", now)).toMatchObject(
			{
				kind: "valid",
				minuteOfDay: 11 * 60 + 20,
			},
		);
		expect(parseConcreteMeetingRequest("4 августа в 11:10", now)).toMatchObject(
			{
				kind: "invalid_or_ambiguous",
				reason: "off_grid",
				minuteOfDay: 11 * 60 + 10,
			},
		);
	});

	test("keeps the date but marks an occupied exact start as not included", () => {
		const proposal = generateMeetingSlotProposal(now, "4 августа в 11", [
			moscowStartAt("2026-08-04", "11:00"),
		]);
		expect(proposal.slots.map((slot) => slot.startAt)).toEqual([
			moscowStartAt("2026-08-04", "10:40"),
			moscowStartAt("2026-08-04", "11:20"),
		]);
		expect(proposal.requestedDateSatisfied).toBe(true);
		expect(proposal.requestedExactTimeIncluded).toBe(false);
	});

	test("marks the date unsatisfied and rolls a fully occupied date", () => {
		const occupied = Array.from({ length: 25 }, (_, index) => {
			const minute = 9 * 60 + index * 20;
			const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
			return moscowStartAt("2026-08-04", time);
		});
		const proposal = generateMeetingSlotProposal(
			now,
			"4 августа в 11",
			occupied,
		);
		expect(proposal.slots.map((slot) => slot.startAt)).toEqual([
			moscowStartAt("2026-08-05", "10:40"),
			moscowStartAt("2026-08-05", "11:00"),
		]);
		expect(proposal.requestedDateSatisfied).toBe(false);
		expect(proposal.requestedExactTimeIncluded).toBe(false);
	});

	test("ignores unrelated numbers and rejects conflicting dates or times", () => {
		expect(
			parseConcreteMeetingRequest(
				"У нас 42 сотрудника в 3 офисах, давайте встречу 4 августа в 11:00",
				now,
			),
		).toMatchObject({ kind: "valid", minuteOfDay: 11 * 60 });
		expect(
			parseConcreteMeetingRequest("4 августа или 5 августа в 11", now),
		).toEqual({
			kind: "invalid_or_ambiguous",
			reason: "conflicting_dates",
		});
		expect(
			parseConcreteMeetingRequest("4 августа в 11 или в 12", now),
		).toMatchObject({
			kind: "invalid_or_ambiguous",
			reason: "conflicting_times",
			requestedMoscowDate: "2026-08-04",
		});
	});

	test("falls back to unchanged contextual behavior for no or invalid concrete request", () => {
		for (const text of ["Без конкретной даты", "4 августа в 11:10"]) {
			const proposal = generateMeetingSlotProposal(
				thursday,
				text,
				[],
				"morning",
			);
			expect(proposal.slots).toEqual(
				generateCandidateMeetingSlots(thursday, [], "morning"),
			);
			expect(proposal.requestedDateSatisfied).toBe(false);
			expect(proposal.requestedExactTimeIncluded).toBe(false);
		}
	});
});
