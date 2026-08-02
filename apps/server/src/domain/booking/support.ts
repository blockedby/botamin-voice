import { createHash } from "node:crypto";
import {
	MEETING_DURATION_MINUTES,
	MEETING_TIME_ZONE,
	type MeetingSlot,
	MeetingSlotSchema,
	type MeetingTimeBand,
	MeetingTimeBandSchema,
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

const PREFERENCE_POLICIES: Record<MeetingTimeBand, PreferencePolicy> = {
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

export type MeetingTimePreferenceParseResult =
	| { kind: "no_mention" }
	| { kind: "selected"; preference: MeetingTimeBand }
	| { kind: "rejected"; preference: MeetingTimeBand };

const REJECTED_TIME_BAND_PATTERNS: ReadonlyArray<
	readonly [MeetingTimeBand, RegExp]
> = [
	[
		"morning",
		/^(?:нет )?(?:(?:мне )?неудобно утром|утром (?:мне )?(?:неудобно|не могу)|не утром)$/u,
	],
	[
		"daytime",
		/^(?:нет )?(?:(?:мне )?неудобно дн[её]м|дн[её]м (?:мне )?(?:неудобно|не могу)|не дн[её]м)$/u,
	],
	[
		"second_half",
		/^(?:нет )?(?:(?:мне )?неудобно во второй половине дня|во второй половине дня (?:мне )?(?:неудобно|не могу)|не во второй половине дня)$/u,
	],
	[
		"evening",
		/^(?:нет )?(?:(?:мне )?неудобно вечером|вечером (?:мне )?(?:неудобно|не могу)|не вечером)$/u,
	],
];

function explicitlyRejectedTimeBand(
	userText: string,
	text: string,
): MeetingTimeBand | null {
	if (/[?？]/u.test(userText) || /(?:^| )не только(?=$| )/u.test(text)) {
		return null;
	}
	for (const [preference, pattern] of REJECTED_TIME_BAND_PATTERNS) {
		if (pattern.test(text)) return preference;
	}
	return null;
}

/**
 * Reads only a small, explicit Russian-first vocabulary. Unknown, ambiguous,
 * and conflicting wording is distinguished from a bounded explicit rejection.
 */
export function parseMeetingTimePreference(
	userText: string,
): MeetingTimePreferenceParseResult {
	const text = normalizedPreferenceText(userText);
	if (!text) return { kind: "no_mention" };
	const rejected = explicitlyRejectedTimeBand(userText, text);
	if (rejected) return { kind: "rejected", preference: rejected };
	if (
		/(?:^| )(?:не уверен(?:а|ы)?|сомневаюсь|возможно|наверное|не всегда|не очень)(?=$| )/u.test(
			text,
		)
	) {
		return { kind: "no_mention" };
	}
	const keywordPreferences: MeetingTimeBand[] = [];
	if (
		hasPositivePhrase(
			text,
			/(?:^| )(?:утром|с утра|на утро|в первой половине дня|до обеда)(?=$| )|(?:^| )(?:в )?[\p{L}\d]+ (?:час|часа|часов) утра(?=$| )|^(?:только )?утро$|(?:^| )(?:лучше|предпочитаю|удобнее|можно|давайте|хочу) (?:на )?утро(?=$| )/u,
			/(?:^| )не (?:только )?(?:утром|с утра|на утро|утро|в первой половине дня|до обеда)(?=$| )/u,
		)
	) {
		keywordPreferences.push("morning");
	}
	if (
		hasPositivePhrase(
			text,
			/(?:^| )(?:дн[её]м|в дневное время|на дневное время)(?=$| )|(?:^| )(?:в )?[\p{L}\d]+ (?:час|часа|часов) дня(?=$| )|^(?:только )?день$|(?:^| )(?:лучше|предпочитаю|удобнее|можно|давайте|хочу) (?:на )?день(?=$| )/u,
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
			/(?:^| )(?:вечером|на вечер|в вечернее время|только вечером|только вечер)(?=$| )|(?:^| )(?:в )?[\p{L}\d]+ (?:час|часа|часов) вечера(?=$| )|^вечер$|(?:^| )(?:лучше|предпочитаю|удобнее|можно|давайте|хочу) (?:на )?вечер(?=$| )/u,
			/(?:^| )не (?:только )?(?:вечером|на вечер|вечер|в вечернее время)(?=$| )/u,
		)
	) {
		keywordPreferences.push("evening");
	}

	const exactPreferences = new Set<MeetingTimeBand>();
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
		if (keyword === exact) return { kind: "selected", preference: keyword };
		if (keyword === "second_half" && exact === "daytime") {
			return { kind: "selected", preference: keyword };
		}
		return { kind: "no_mention" };
	}
	if (keywordPreferences.length > 0 && !keyword) return { kind: "no_mention" };
	const preference = keyword ?? exact;
	return preference ? { kind: "selected", preference } : { kind: "no_mention" };
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

function minuteIsInBand(minute: number, band: MeetingTimeBand): boolean {
	const [start, end] = PREFERENCE_POLICIES[band].band;
	return minute >= start && minute <= end;
}

function selectMinutesForDay(
	moscowDay: number,
	preference: MeetingTimePreference,
	rejectedPreferences: ReadonlySet<MeetingTimeBand>,
	unavailable: ReadonlySet<string>,
): [number, number] | null {
	const available = ALL_POLICY_MINUTES.filter(
		(minute) =>
			!unavailable.has(meetingSlotAtMoscowDay(moscowDay, minute).startAt) &&
			![...rejectedPreferences].some((band) => minuteIsInBand(minute, band)),
	);
	if (available.length < 2) return null;
	if (preference === "none") {
		const [firstBand, secondBand]: [MeetingTimeBand, MeetingTimeBand] =
			rejectedPreferences.has("evening")
				? ["morning", "daytime"]
				: rejectedPreferences.has("morning")
					? ["daytime", "evening"]
					: ["morning", "evening"];
		const firstCandidates = available.filter((minute) =>
			minuteIsInBand(minute, firstBand),
		);
		const secondCandidates = available.filter((minute) =>
			minuteIsInBand(minute, secondBand),
		);
		const anchors: [number, number] = [
			PREFERENCE_POLICIES[firstBand].anchors[0],
			PREFERENCE_POLICIES[secondBand].anchors[0],
		];
		let best: [number, number] | null = null;
		let bestScore: number[] | null = null;
		for (const first of firstCandidates) {
			for (const second of secondCandidates) {
				const score = [
					Math.abs(first - anchors[0]) + Math.abs(second - anchors[1]),
					first,
					second,
				];
				if (!bestScore || compareScores(score, bestScore) < 0) {
					best = [first, second];
					bestScore = score;
				}
			}
		}
		return best;
	}
	const policy = PREFERENCE_POLICIES[preference];
	const inBand = available.filter(
		(minute) => minute >= policy.band[0] && minute <= policy.band[1],
	);
	// A stated time-of-day preference is a hard proposal band. If that band
	// cannot supply two starts on this weekday, roll forward instead of
	// contradicting the visitor with unrelated times.
	return closestPair(inBand, policy.anchors, true);
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
	rejectedPreferences: readonly MeetingTimeBand[] = [],
): [MeetingSlot, MeetingSlot] {
	validDate(now);
	const parsedPreference = MeetingTimePreferenceSchema.parse(preference);
	if (rejectedPreferences.length > 1) {
		throw new RangeError("At most one rejected meeting time band is supported");
	}
	const rejected = new Set(
		rejectedPreferences.map((band) => MeetingTimeBandSchema.parse(band)),
	);
	if (parsedPreference !== "none" && rejected.size > 0) {
		throw new TypeError("A selected preference cannot also reject a time band");
	}
	const unavailable = new Set(unavailableStartAts);
	let moscowDay = moscowDayNumber(now) + 1;
	while (true) {
		const weekday = new Date(moscowDay * 86_400_000).getUTCDay();
		if (weekday >= 1 && weekday <= 5) {
			const minutes = selectMinutesForDay(
				moscowDay,
				parsedPreference,
				rejected,
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
