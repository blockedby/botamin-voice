import { createHash } from "node:crypto";
import {
	MEETING_DURATION_MINUTES,
	MEETING_TIME_ZONE,
	type MeetingSlot,
	MeetingSlotSchema,
} from "@botamin/contracts";

export type Clock = () => Date;
export type IdFactory = () => string;

export function createEntityId(): string {
	return Bun.randomUUIDv7();
}

export function toUtcTimestamp(date: Date): string {
	return date.toISOString();
}

const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60_000;
const FIRST_MEETING_MINUTE = 9 * 60;
const LAST_MEETING_MINUTE = 17 * 60;

function validDate(date: Date): void {
	if (!Number.isFinite(date.getTime()))
		throw new TypeError("Expected a valid clock instant");
}

function moscowDayNumber(date: Date): number {
	return Math.floor((date.getTime() + MOSCOW_UTC_OFFSET_MS) / 86_400_000);
}

function meetingSlotAtMoscowDay(
	moscowDay: number,
	minuteOfDay: number,
): MeetingSlot {
	const startMs =
		moscowDay * 86_400_000 + minuteOfDay * 60_000 - MOSCOW_UTC_OFFSET_MS;
	return MeetingSlotSchema.parse({
		startAt: new Date(startMs).toISOString(),
		endAt: new Date(startMs + MEETING_DURATION_MINUTES * 60_000).toISOString(),
		timeZone: MEETING_TIME_ZONE,
		durationMinutes: MEETING_DURATION_MINUTES,
	});
}

/**
 * Produces the first two internal schedule candidates after Moscow today.
 * It uses no locale, host timezone, holiday feed, external calendar, or
 * availability API. Supplied starts are merely already-committed internal
 * exclusions; creating a booking remains the atomic reservation boundary.
 */
export function generateCandidateMeetingSlots(
	now: Date,
	unavailableStartAts: Iterable<string> = [],
): [MeetingSlot, MeetingSlot] {
	validDate(now);
	const unavailable = new Set(unavailableStartAts);
	const candidates: MeetingSlot[] = [];
	let moscowDay = moscowDayNumber(now) + 1;
	while (candidates.length < 2) {
		const weekday = new Date(moscowDay * 86_400_000).getUTCDay();
		if (weekday >= 1 && weekday <= 5) {
			for (
				let minute = FIRST_MEETING_MINUTE;
				minute <= LAST_MEETING_MINUTE && candidates.length < 2;
				minute += MEETING_DURATION_MINUTES
			) {
				const slot = meetingSlotAtMoscowDay(moscowDay, minute);
				if (!unavailable.has(slot.startAt)) candidates.push(slot);
			}
		}
		moscowDay += 1;
	}
	return [candidates[0] as MeetingSlot, candidates[1] as MeetingSlot];
}

/** Enforces the clock-dependent rules that a transport contract cannot know. */
export function isMeetingSlotBookable(slot: MeetingSlot, now: Date): boolean {
	validDate(now);
	const parsed = MeetingSlotSchema.safeParse(slot);
	if (!parsed.success) return false;
	const start = new Date(parsed.data.startAt);
	return (
		start.getTime() > now.getTime() &&
		moscowDayNumber(start) > moscowDayNumber(now)
	);
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, sortJson(entry)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

export function requestHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
