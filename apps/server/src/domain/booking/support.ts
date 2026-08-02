import { createHash } from "node:crypto";
import {
	MEETING_DURATION_MINUTES,
	MEETING_TIME_ZONE,
	type MeetingSlot,
	MeetingSlotSchema,
	type MeetingTimePreference,
	MeetingTimePreferenceSchema,
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
const ALL_POLICY_MINUTES = Array.from(
	{
		length:
			(LAST_MEETING_MINUTE - FIRST_MEETING_MINUTE) / MEETING_DURATION_MINUTES +
			1,
	},
	(_, index) => FIRST_MEETING_MINUTE + index * MEETING_DURATION_MINUTES,
);

interface PreferencePolicy {
	anchors: readonly [number, number];
	band: readonly [number, number];
}

const PREFERENCE_POLICIES: Record<
	Exclude<MeetingTimePreference, "none">,
	PreferencePolicy
> = {
	morning: { anchors: [9 * 60, 10 * 60], band: [9 * 60, 11 * 60 + 40] },
	daytime: {
		anchors: [14 * 60, 15 * 60],
		band: [12 * 60, 15 * 60 + 40],
	},
	second_half: {
		anchors: [14 * 60, 15 * 60],
		band: [12 * 60, 15 * 60 + 40],
	},
	evening: { anchors: [16 * 60, 17 * 60], band: [16 * 60, 17 * 60] },
};

function validDate(date: Date): void {
	if (!Number.isFinite(date.getTime()))
		throw new TypeError("Expected a valid clock instant");
}

function normalizedPreferenceText(text: string): string | null {
	if (text.length > 500) return null;
	return text
		.toLocaleLowerCase("ru-RU")
		.replace(/[^\p{L}\p{N}:\s]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function hasPositivePhrase(
	text: string,
	positive: RegExp,
	negated: RegExp,
): boolean {
	return positive.test(text) && !negated.test(text);
}

/**
 * Reads only a small, explicit Russian-first vocabulary. Unknown, negated, or
 * conflicting wording is deliberately left to the existing server preference.
 */
export function parseMeetingTimePreference(
	userText: string,
): MeetingTimePreference | null {
	const text = normalizedPreferenceText(userText);
	if (!text) return null;
	const keywordPreferences: MeetingTimePreference[] = [];
	if (
		hasPositivePhrase(
			text,
			/(?:^| )(?:утром|с утра|на утро|в первой половине дня|до обеда)(?=$| )|^(?:только )?утро$|(?:^| )(?:лучше|предпочитаю|удобнее|можно|давайте|хочу) (?:на )?утро(?=$| )/u,
			/(?:^| )не (?:только )?(?:утром|с утра|на утро|утро|в первой половине дня|до обеда)(?=$| )/u,
		)
	) {
		keywordPreferences.push("morning");
	}
	if (
		hasPositivePhrase(
			text,
			/(?:^| )(?:дн[её]м|в дневное время|на дневное время)(?=$| )|^(?:только )?день$|(?:^| )(?:лучше|предпочитаю|удобнее|можно|давайте|хочу) (?:на )?день(?=$| )/u,
			/(?:^| )не (?:только )?(?:дн[её]м|день|в дневное время|на дневное время)(?=$| )/u,
		)
	) {
		keywordPreferences.push("daytime");
	}
	if (
		hasPositivePhrase(
			text,
			/(?:^| )(?:(?:во|на) втор(?:ой|ую) половин(?:е|у) дня|вторая половина дня|после обеда)(?=$| )/u,
			/(?:^| )не (?:только )?(?:(?:во|на) втор(?:ой|ую) половин(?:е|у) дня|вторая половина дня|после обеда)(?=$| )/u,
		)
	) {
		keywordPreferences.push("second_half");
	}
	if (
		hasPositivePhrase(
			text,
			/(?:^| )(?:вечером|на вечер|в вечернее время|только вечером|только вечер)(?=$| )|^вечер$|(?:^| )(?:лучше|предпочитаю|удобнее|можно|давайте|хочу) (?:на )?вечер(?=$| )/u,
			/(?:^| )не (?:только )?(?:вечером|на вечер|вечер|в вечернее время)(?=$| )/u,
		)
	) {
		keywordPreferences.push("evening");
	}

	const exactPreferences = new Set<MeetingTimePreference>();
	for (const match of text.matchAll(
		/(?:^| )([01]?\d|2[0-3]):([0-5]\d)(?=$| )/gu,
	)) {
		const prefix = text.slice(0, match.index).trimEnd();
		if (/(?:^| )не(?: в| на)?$/u.test(prefix)) continue;
		const minutes = Number(match[1]) * 60 + Number(match[2]);
		exactPreferences.add(
			minutes < 12 * 60 ? "morning" : minutes < 16 * 60 ? "daytime" : "evening",
		);
	}

	const keyword =
		new Set(keywordPreferences).size === 1 ? keywordPreferences[0] : null;
	const exact = exactPreferences.size === 1 ? [...exactPreferences][0] : null;
	if (keyword && exact) {
		if (keyword === exact) return keyword;
		if (keyword === "second_half" && exact === "daytime") return keyword;
		return null;
	}
	if (keywordPreferences.length > 0 && !keyword) return null;
	return keyword ?? exact ?? null;
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

function compareScores(
	left: readonly number[],
	right: readonly number[],
): number {
	for (let index = 0; index < left.length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function closestPair(
	available: readonly number[],
	anchors: readonly [number, number],
	preserveHourGap: boolean,
): [number, number] | null {
	let best: { pair: [number, number]; score: number[] } | null = null;
	for (let left = 0; left < available.length; left += 1) {
		for (let right = left + 1; right < available.length; right += 1) {
			const pair: [number, number] = [
				available[left] as number,
				available[right] as number,
			];
			const distance =
				Math.abs(pair[0] - anchors[0]) + Math.abs(pair[1] - anchors[1]);
			const gapDistance = Math.abs(
				pair[1] - pair[0] - (anchors[1] - anchors[0]),
			);
			const score = preserveHourGap
				? [gapDistance, distance, pair[0], pair[1]]
				: [distance, gapDistance, pair[0], pair[1]];
			if (!best || compareScores(score, best.score) < 0) best = { pair, score };
		}
	}
	return best?.pair ?? null;
}

function selectMinutesForDay(
	moscowDay: number,
	preference: MeetingTimePreference,
	unavailable: ReadonlySet<string>,
): [number, number] | null {
	const available = ALL_POLICY_MINUTES.filter(
		(minute) =>
			!unavailable.has(meetingSlotAtMoscowDay(moscowDay, minute).startAt),
	);
	if (available.length < 2) return null;
	if (preference === "none") {
		const morning = available.filter((minute) => minute <= 11 * 60 + 40);
		const evening = available.filter((minute) => minute >= 16 * 60);
		let best: [number, number] | null = null;
		let bestScore: number[] | null = null;
		for (const first of morning) {
			for (const second of evening) {
				const score = [
					Math.abs(first - 9 * 60) + Math.abs(second - 16 * 60),
					first,
					second,
				];
				if (!bestScore || compareScores(score, bestScore) < 0) {
					best = [first, second];
					bestScore = score;
				}
			}
		}
		return best ?? closestPair(available, [9 * 60, 16 * 60], false);
	}
	const policy = PREFERENCE_POLICIES[preference];
	const inBand = available.filter(
		(minute) => minute >= policy.band[0] && minute <= policy.band[1],
	);
	return (
		closestPair(inBand, policy.anchors, true) ??
		closestPair(available, policy.anchors, true)
	);
}

/**
 * Produces exactly two internal candidates after Moscow today. Supplied starts
 * are already-committed internal exclusions, not an external calendar claim;
 * the create transaction remains the reservation boundary.
 */
export function generateCandidateMeetingSlots(
	now: Date,
	unavailableStartAts: Iterable<string> = [],
	preference: MeetingTimePreference = "none",
): [MeetingSlot, MeetingSlot] {
	validDate(now);
	const parsedPreference = MeetingTimePreferenceSchema.parse(preference);
	const unavailable = new Set(unavailableStartAts);
	let moscowDay = moscowDayNumber(now) + 1;
	while (true) {
		const weekday = new Date(moscowDay * 86_400_000).getUTCDay();
		if (weekday >= 1 && weekday <= 5) {
			const minutes = selectMinutesForDay(
				moscowDay,
				parsedPreference,
				unavailable,
			);
			if (minutes) {
				return [
					meetingSlotAtMoscowDay(moscowDay, minutes[0]),
					meetingSlotAtMoscowDay(moscowDay, minutes[1]),
				];
			}
		}
		moscowDay += 1;
	}
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
