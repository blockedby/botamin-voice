import {
	type BookingSnapshot,
	type BrainActionName,
	type BrainTurnInput,
	BrainTurnInputSchema,
	type ConcreteSchedulingInterpretation,
	type KnownFacts,
	type MeetingSlot,
	type MeetingTimeBand,
	type MeetingTimePreference,
	SchedulingContextSchema,
} from "@botamin/contracts";
import type { ConcreteMeetingRequestParseResult } from "../domain/booking";

const MAX_FACT_LENGTH = 300;

function compactText(value: string): string {
	return value.replace(/\s+/gu, " ").trim().slice(0, MAX_FACT_LENGTH);
}

function compactList(values: readonly string[]): string[] {
	return [...new Set(values.map(compactText).filter(Boolean))].slice(0, 10);
}

export function compactKnownFacts(facts: KnownFacts): KnownFacts {
	return {
		...(facts.company ? { company: compactText(facts.company) } : {}),
		...(facts.role ? { role: compactText(facts.role) } : {}),
		useCases: compactList(facts.useCases),
		painPoints: compactList(facts.painPoints),
		objections: compactList(facts.objections),
	};
}

export interface BrainContextInput {
	conversationId: string;
	threadId?: string;
	turnId: string;
	generationId: string;
	userText: string;
	stage: BrainTurnInput["stage"];
	knownFacts: KnownFacts;
	booking: BookingSnapshot | null;
	allowedActions: readonly BrainActionName[];
	promptVersion: string;
	now: Date;
	timeOfDayPreference: MeetingTimePreference;
	rejectedTimeOfDayPreferences: readonly MeetingTimeBand[];
	concreteRequest: ConcreteMeetingRequestParseResult;
	candidateMeetingSlots: readonly [MeetingSlot, MeetingSlot];
}

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000;
const WEEKDAYS = [
	"воскресенье",
	"понедельник",
	"вторник",
	"среда",
	"четверг",
	"пятница",
	"суббота",
] as const;
const MONTHS = [
	"января",
	"февраля",
	"марта",
	"апреля",
	"мая",
	"июня",
	"июля",
	"августа",
	"сентября",
	"октября",
	"ноября",
	"декабря",
] as const;

function inMoscow(date: Date): Date {
	return new Date(date.getTime() + MOSCOW_OFFSET_MS);
}

function time(value: Date): string {
	return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
}

function displayLabel(slot: MeetingSlot): string {
	const start = inMoscow(new Date(slot.startAt));
	const end = inMoscow(new Date(slot.endAt));
	const date = `${String(start.getUTCDate()).padStart(2, "0")} ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()} года`;
	return `${date}, ${WEEKDAYS[start.getUTCDay()]}, ${time(start)}–${time(end)} по Москве`;
}

function concreteInterpretation(
	request: ConcreteMeetingRequestParseResult,
	candidateMeetingSlots: readonly [MeetingSlot, MeetingSlot],
): ConcreteSchedulingInterpretation {
	if (request.kind === "none") return { kind: "none" };
	if (request.kind === "invalid_or_ambiguous") {
		return {
			kind: "not_included",
			reason: request.reason,
			candidateIndex: null,
		};
	}

	const requestedMoscowLocalTime = `${String(Math.floor(request.minuteOfDay / 60)).padStart(2, "0")}:${String(request.minuteOfDay % 60).padStart(2, "0")}`;
	const candidateIndex = candidateMeetingSlots.findIndex(
		(candidate) => candidate.startAt === request.startAt,
	);
	if (candidateIndex === 0 || candidateIndex === 1) {
		return {
			kind: "included",
			requestedMoscowLocalDate: request.requestedMoscowDate,
			requestedMoscowLocalTime,
			reason: "exact_request_included",
			candidateIndex,
		};
	}
	const requestedDateSatisfied = candidateMeetingSlots.every(
		(candidate) =>
			inMoscow(new Date(candidate.startAt)).toISOString().slice(0, 10) ===
			request.requestedMoscowDate,
	);
	return {
		kind: "not_included",
		requestedMoscowLocalDate: request.requestedMoscowDate,
		requestedMoscowLocalTime,
		reason: requestedDateSatisfied
			? "exact_time_not_included"
			: "requested_date_unsatisfied",
		candidateIndex: null,
	};
}

export function buildSchedulingContext(
	now: Date,
	timeOfDayPreference: MeetingTimePreference,
	rejectedTimeOfDayPreferences: readonly MeetingTimeBand[],
	candidateMeetingSlots: readonly [MeetingSlot, MeetingSlot],
	concreteRequest: ConcreteMeetingRequestParseResult = { kind: "none" },
	exposeCandidates = true,
): BrainTurnInput["schedulingContext"] {
	if (!Number.isFinite(now.getTime()))
		throw new TypeError("Expected a valid runtime clock instant");
	const local = inMoscow(now);
	return SchedulingContextSchema.parse({
		currentInstant: now.toISOString(),
		moscowLocalDate: `${String(local.getUTCFullYear()).padStart(4, "0")}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`,
		moscowWeekday: WEEKDAYS[local.getUTCDay()],
		timeOfDayPreference: exposeCandidates ? timeOfDayPreference : "none",
		rejectedTimeOfDayPreferences: exposeCandidates
			? rejectedTimeOfDayPreferences
			: [],
		concreteRequestInterpretation: exposeCandidates
			? concreteInterpretation(concreteRequest, candidateMeetingSlots)
			: { kind: "none" },
		candidateMeetingSlots: exposeCandidates
			? candidateMeetingSlots.map((meetingSlot) => ({
					meetingSlot,
					displayLabel: displayLabel(meetingSlot),
				}))
			: [],
	});
}

/** Builds the complete, bounded context envelope passed to every brain turn. */
export function buildBrainContext(input: BrainContextInput): BrainTurnInput {
	return BrainTurnInputSchema.parse({
		conversationId: input.conversationId,
		...(input.threadId ? { threadId: input.threadId } : {}),
		turnId: input.turnId,
		generationId: input.generationId,
		userText: input.userText.replace(/\s+/gu, " ").trim(),
		stage: input.stage,
		knownFacts: compactKnownFacts(input.knownFacts),
		booking: input.booking,
		schedulingContext: buildSchedulingContext(
			input.now,
			input.timeOfDayPreference,
			input.rejectedTimeOfDayPreferences,
			input.candidateMeetingSlots,
			input.concreteRequest,
			input.stage !== "GREETING",
		),
		allowedActions: [...new Set(input.allowedActions)].sort(),
		promptVersion: input.promptVersion,
	});
}
