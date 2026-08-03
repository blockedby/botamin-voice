import type {
	BookingDraftCandidate,
	MeetingTimeBand,
} from "@botamin/contracts";
import {
	parseConcreteMeetingRequest,
	parseMeetingTimePreference,
} from "../domain/booking";

export type BookingSelectionResolution =
	| { kind: "none" }
	| { kind: "selected"; candidateId: string }
	| { kind: "ambiguous"; reason: "ordinal" | "time" | "time_of_day" }
	| { kind: "not_current"; reason: "time" | "time_of_day" };

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000;

function normalizedSelectionText(text: string): string {
	return text
		.normalize("NFKC")
		.toLocaleLowerCase("ru-RU")
		.replace(/[^\p{L}\p{N}:\s]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function ordinalReferences(text: string): number[] {
	if (
		/(?:^|\s)первый(?:\s+вариант)?\s+(?:или|и)\s+второй(?:\s+вариант)?(?:\s|$)/u.test(
			text,
		)
	) {
		return [0, 1];
	}
	const references: number[] = [];
	const first =
		/(?:^|\s)первый\s+вариант(?:\s|$)/u.test(text) ||
		/^(?:(?:выбираю|беру|давайте|подойд[её]т|мне подходит)\s+)?первый$/u.test(
			text,
		);
	const second =
		/(?:^|\s)второй\s+вариант(?:\s|$)/u.test(text) ||
		/^(?:(?:выбираю|беру|давайте|подойд[её]т|мне подходит)\s+)?второй$/u.test(
			text,
		);
	if (first) references.push(0);
	if (second) references.push(1);
	return references;
}

function moscowMinuteOfDay(candidate: BookingDraftCandidate): number {
	const local = new Date(
		new Date(candidate.meetingSlot.startAt).getTime() + MOSCOW_OFFSET_MS,
	);
	return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function candidatesAtMinute(
	candidates: readonly BookingDraftCandidate[],
	minuteOfDay: number,
): BookingDraftCandidate[] {
	return candidates.filter(
		(candidate) => moscowMinuteOfDay(candidate) === minuteOfDay,
	);
}

function explicitMinutes(text: string): number[] {
	const minutes = new Set<number>();
	for (const match of text.matchAll(
		/(?:^|\s)(?:в\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/gu,
	)) {
		minutes.add(Number(match[1]) * 60 + Number(match[2]));
	}
	for (const match of text.matchAll(
		/(?:^|\s)в\s+([01]?\d|2[0-3])(?:\s+(?:час|часа|часов))?(?=\s|$)/gu,
	)) {
		minutes.add(Number(match[1]) * 60);
	}
	return [...minutes];
}

function inBand(minute: number, band: MeetingTimeBand): boolean {
	if (band === "morning") return minute >= 9 * 60 && minute <= 11 * 60 + 40;
	if (band === "evening") return minute >= 16 * 60 && minute <= 17 * 60;
	return minute >= 12 * 60 && minute <= 15 * 60 + 40;
}

function uniqueMatch(
	matches: readonly BookingDraftCandidate[],
	reason: "time" | "time_of_day",
): BookingSelectionResolution {
	const match = matches[0];
	if (matches.length === 1 && match) {
		return { kind: "selected", candidateId: match.candidateId };
	}
	return matches.length === 0
		? { kind: "not_current", reason }
		: { kind: "ambiguous", reason };
}

/** Resolves only explicit wording against the exact server-owned current pair. */
export function resolveCurrentBookingCandidate(
	text: string,
	candidates: readonly BookingDraftCandidate[],
	now: Date,
): BookingSelectionResolution {
	const normalized = normalizedSelectionText(text);
	if (!normalized || normalized.length > 500) return { kind: "none" };

	const ordinals = ordinalReferences(normalized);
	if (ordinals.length > 1) return { kind: "ambiguous", reason: "ordinal" };
	if (ordinals.length === 1) {
		const candidate = candidates[ordinals[0] as number];
		return candidate
			? { kind: "selected", candidateId: candidate.candidateId }
			: { kind: "not_current", reason: "time" };
	}

	const concrete = parseConcreteMeetingRequest(text, now);
	if (concrete.kind === "valid") {
		return uniqueMatch(
			candidates.filter(
				(candidate) => candidate.meetingSlot.startAt === concrete.startAt,
			),
			"time",
		);
	}
	if (concrete.kind === "invalid_or_ambiguous") {
		return concrete.reason === "conflicting_dates" ||
			concrete.reason === "conflicting_times"
			? { kind: "ambiguous", reason: "time" }
			: { kind: "not_current", reason: "time" };
	}

	const mentionedMinutes = explicitMinutes(normalized);
	if (mentionedMinutes.length > 1) {
		return { kind: "ambiguous", reason: "time" };
	}
	if (mentionedMinutes.length === 1) {
		return uniqueMatch(
			candidatesAtMinute(candidates, mentionedMinutes[0] as number),
			"time",
		);
	}

	const preference = parseMeetingTimePreference(text);
	if (preference.kind !== "selected") return { kind: "none" };
	return uniqueMatch(
		candidates.filter((candidate) =>
			inBand(moscowMinuteOfDay(candidate), preference.preference),
		),
		"time_of_day",
	);
}
