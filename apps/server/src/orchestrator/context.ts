import {
	type BookingSnapshot,
	type BrainActionName,
	type BrainTurnInput,
	BrainTurnInputSchema,
	type KnownFacts,
	type MeetingSlot,
	SchedulingContextSchema,
} from "@botamin/contracts";

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
	const date = `${String(start.getUTCDate()).padStart(2, "0")} ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
	return `${date}, ${WEEKDAYS[start.getUTCDay()]}, ${time(start)}–${time(end)} (МСК, Europe/Moscow)`;
}

export function buildSchedulingContext(
	now: Date,
	candidateMeetingSlots: readonly [MeetingSlot, MeetingSlot],
): BrainTurnInput["schedulingContext"] {
	if (!Number.isFinite(now.getTime()))
		throw new TypeError("Expected a valid runtime clock instant");
	const local = inMoscow(now);
	return SchedulingContextSchema.parse({
		currentInstant: now.toISOString(),
		moscowLocalDate: `${String(local.getUTCFullYear()).padStart(4, "0")}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`,
		moscowWeekday: WEEKDAYS[local.getUTCDay()],
		candidateMeetingSlots: candidateMeetingSlots.map((meetingSlot) => ({
			meetingSlot,
			displayLabel: displayLabel(meetingSlot),
		})),
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
			input.candidateMeetingSlots,
		),
		allowedActions: [...new Set(input.allowedActions)].sort(),
		promptVersion: input.promptVersion,
	});
}
