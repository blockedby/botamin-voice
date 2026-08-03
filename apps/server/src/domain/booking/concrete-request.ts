const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60_000;
const DAY_MS = 86_400_000;
const FIRST_MEETING_MINUTE = 9 * 60;
const LAST_MEETING_MINUTE = 17 * 60;
const MEETING_GRID_MINUTES = 20;

const MONTHS: Readonly<Record<string, number>> = {
	января: 1,
	февраля: 2,
	марта: 3,
	апреля: 4,
	мая: 5,
	июня: 6,
	июля: 7,
	августа: 8,
	сентября: 9,
	октября: 10,
	ноября: 11,
	декабря: 12,
};

export const ConcreteMeetingRequestReasons = [
	"too_long",
	"conflicting_dates",
	"conflicting_times",
	"invalid_date",
	"invalid_time",
	"past",
	"same_day",
	"weekend",
	"outside_hours",
	"off_grid",
] as const;

export type ConcreteMeetingRequestReason =
	(typeof ConcreteMeetingRequestReasons)[number];

type RequestedDetails = {
	requestedMoscowDate?: string;
	minuteOfDay?: number;
	startAt?: string;
};

export type ConcreteMeetingRequestParseResult =
	| { kind: "none" }
	| {
			kind: "valid";
			requestedMoscowDate: string;
			minuteOfDay: number;
			startAt: string;
	  }
	| ({
			kind: "invalid_or_ambiguous";
			reason: ConcreteMeetingRequestReason;
	  } & RequestedDetails);

type ParsedDate = {
	moscowDay: number;
};

function invalid(
	reason: ConcreteMeetingRequestReason,
	details: RequestedDetails = {},
): ConcreteMeetingRequestParseResult {
	return { kind: "invalid_or_ambiguous", reason, ...details };
}

function validInstant(date: Date): void {
	if (!Number.isFinite(date.getTime())) {
		throw new TypeError("Expected a valid clock instant");
	}
}

function moscowDayNumber(date: Date): number {
	return Math.floor((date.getTime() + MOSCOW_UTC_OFFSET_MS) / DAY_MS);
}

function dayNumber(year: number, month: number, day: number): number | null {
	if (year < 1970 || year > 9999) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return Math.floor(date.getTime() / DAY_MS);
}

function localDate(moscowDay: number): string {
	return new Date(moscowDay * DAY_MS).toISOString().slice(0, 10);
}

function startAt(moscowDay: number, minuteOfDay: number): string {
	return new Date(
		moscowDay * DAY_MS + minuteOfDay * 60_000 - MOSCOW_UTC_OFFSET_MS,
	).toISOString();
}

function parseAbsoluteDate(
	day: number,
	month: number,
	yearText: string | undefined,
	nowDay: number,
): ParsedDate | null {
	if (yearText !== undefined) {
		const moscowDay = dayNumber(Number(yearText), month, day);
		return moscowDay === null ? null : { moscowDay };
	}

	const currentYear = new Date(nowDay * DAY_MS).getUTCFullYear();
	for (const year of [currentYear, currentYear + 1]) {
		const candidate = dayNumber(year, month, day);
		if (
			candidate !== null &&
			candidate >= nowDay &&
			candidate - nowDay <= 366
		) {
			return { moscowDay: candidate };
		}
	}
	return null;
}

/**
 * Parses a deliberately small Russian concrete date/time grammar. It performs
 * no locale or calendar I/O: Moscow is fixed at UTC+03 and `now` is injected.
 */
export function parseConcreteMeetingRequest(
	userText: string,
	now: Date,
): ConcreteMeetingRequestParseResult {
	validInstant(now);
	if (userText.length > 500) return invalid("too_long");
	const text = userText
		.toLowerCase()
		.replace(/[^\p{L}\p{N}:\s]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!text) return { kind: "none" };

	const nowDay = moscowDayNumber(now);
	const parsedDates: ParsedDate[] = [];
	const dateEnds: number[] = [];
	for (const match of text.matchAll(
		/(?:^| )(сегодня|завтра|послезавтра)(?= |$)/gu,
	)) {
		const offset = match[1] === "сегодня" ? 0 : match[1] === "завтра" ? 1 : 2;
		parsedDates.push({ moscowDay: nowDay + offset });
		dateEnds.push((match.index ?? 0) + match[0].length);
	}
	for (const match of text.matchAll(
		/(?:^| )(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4})(?:\s+года)?)?(?= |$)/gu,
	)) {
		const month = MONTHS[match[2] as string];
		const parsed =
			month === undefined
				? null
				: parseAbsoluteDate(Number(match[1]), month, match[3], nowDay);
		if (!parsed) return invalid("invalid_date");
		parsedDates.push(parsed);
		dateEnds.push((match.index ?? 0) + match[0].length);
	}
	if (parsedDates.length === 0) return { kind: "none" };
	const uniqueDays = new Set(parsedDates.map(({ moscowDay }) => moscowDay));
	if (uniqueDays.size > 1) return invalid("conflicting_dates");
	const requestedDay = parsedDates[0]?.moscowDay;
	if (requestedDay === undefined) return { kind: "none" };

	const parsedTimes: number[] = [];
	const firstDateEnd = Math.min(...dateEnds);
	const textAfterDate = text.slice(firstDateEnd);
	for (const match of textAfterDate.matchAll(
		/(?:^| )в\s+(\d{1,2})(?::(\d{1,2}))?(?= |$)/gu,
	)) {
		const hour = Number(match[1]);
		const minute = match[2] === undefined ? 0 : Number(match[2]);
		if (hour > 23 || minute > 59) {
			return invalid("invalid_time", {
				requestedMoscowDate: localDate(requestedDay),
			});
		}
		parsedTimes.push(hour * 60 + minute);
	}
	if (parsedTimes.length === 0) return { kind: "none" };
	const uniqueTimes = new Set(parsedTimes);
	if (uniqueTimes.size > 1) {
		return invalid("conflicting_times", {
			requestedMoscowDate: localDate(requestedDay),
		});
	}
	const minuteOfDay = parsedTimes[0];
	if (minuteOfDay === undefined) return { kind: "none" };
	const details = {
		requestedMoscowDate: localDate(requestedDay),
		minuteOfDay,
		startAt: startAt(requestedDay, minuteOfDay),
	};

	if (requestedDay === nowDay) return invalid("same_day", details);
	if (
		requestedDay < nowDay ||
		new Date(details.startAt).getTime() <= now.getTime()
	) {
		return invalid("past", details);
	}
	const weekday = new Date(requestedDay * DAY_MS).getUTCDay();
	if (weekday === 0 || weekday === 6) return invalid("weekend", details);
	if (minuteOfDay < FIRST_MEETING_MINUTE || minuteOfDay > LAST_MEETING_MINUTE) {
		return invalid("outside_hours", details);
	}
	if (minuteOfDay % MEETING_GRID_MINUTES !== 0) {
		return invalid("off_grid", details);
	}
	return { kind: "valid", ...details };
}
