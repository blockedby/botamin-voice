import { describe, expect, test } from "bun:test";
import type { BookingDraftCandidate } from "@botamin/contracts";
import { resolveCurrentBookingCandidate } from "./booking-selection";

const now = new Date("2026-07-30T12:00:00.000Z");

function candidate(startAt: string): BookingDraftCandidate {
	return {
		candidateId: Bun.randomUUIDv7(),
		meetingSlot: {
			startAt,
			endAt: new Date(new Date(startAt).getTime() + 20 * 60_000).toISOString(),
			timeZone: "Europe/Moscow",
			durationMinutes: 20,
		},
	};
}

const current = [
	candidate("2026-07-31T06:00:00.000Z"),
	candidate("2026-07-31T13:00:00.000Z"),
] as const;

describe("current booking candidate resolution", () => {
	test("selects first and second only from explicit ordinal wording", () => {
		expect(resolveCurrentBookingCandidate("первый", current, now)).toEqual({
			kind: "selected",
			candidateId: current[0].candidateId,
		});
		expect(
			resolveCurrentBookingCandidate("Выбираю второй вариант", current, now),
		).toEqual({ kind: "selected", candidateId: current[1].candidateId });
		expect(
			resolveCurrentBookingCandidate("первый или второй вариант", current, now),
		).toEqual({ kind: "ambiguous", reason: "ordinal" });
	});

	test("matches exact current time and exact Moscow date/time", () => {
		expect(
			resolveCurrentBookingCandidate("подойдёт 16:00", current, now),
		).toEqual({ kind: "selected", candidateId: current[1].candidateId });
		expect(resolveCurrentBookingCandidate("завтра в 9", current, now)).toEqual({
			kind: "selected",
			candidateId: current[0].candidateId,
		});
		expect(
			resolveCurrentBookingCandidate("31 июля 2026 года в 16:00", current, now),
		).toEqual({ kind: "selected", candidateId: current[1].candidateId });
	});

	test("selects a time-of-day only when one current candidate matches", () => {
		expect(resolveCurrentBookingCandidate("лучше утром", current, now)).toEqual(
			{
				kind: "selected",
				candidateId: current[0].candidateId,
			},
		);
		expect(resolveCurrentBookingCandidate("вечером", current, now)).toEqual({
			kind: "selected",
			candidateId: current[1].candidateId,
		});
	});

	test("fails closed for ambiguous, conflicting, and non-current time references", () => {
		const sameClockTime = [
			candidate("2026-07-31T06:00:00.000Z"),
			candidate("2026-08-03T06:00:00.000Z"),
		] as const;
		expect(
			resolveCurrentBookingCandidate("выбираю 09:00", sameClockTime, now),
		).toEqual({ kind: "ambiguous", reason: "time" });
		expect(resolveCurrentBookingCandidate("утром", sameClockTime, now)).toEqual(
			{ kind: "ambiguous", reason: "time_of_day" },
		);
		expect(
			resolveCurrentBookingCandidate("завтра в 9 или в 10", current, now),
		).toEqual({ kind: "ambiguous", reason: "time" });
		expect(
			resolveCurrentBookingCandidate("выбираю 10:00", current, now),
		).toEqual({ kind: "not_current", reason: "time" });
		expect(resolveCurrentBookingCandidate("да", current, now)).toEqual({
			kind: "none",
		});
	});
});
