import { z } from "zod";
import { CanonicalTtsWavBytesSchema } from "./audio";
import {
	EntityIdSchema,
	MpegAudioBytesSchema,
	SafeErrorSchema,
} from "./common";
import type {
	BookingDomainEvent,
	BookingSnapshot,
	MeetingSlot,
	MeetingTimeBand,
	MeetingTimePreference,
	QualificationPatch,
} from "./domain";
import {
	BookingSnapshotSchema,
	ConversationStageSchema,
	KnownFactsSchema,
	MeetingSlotSchema,
	MeetingTimeBandSchema,
	MeetingTimePreferenceSchema,
} from "./domain";
import type {
	AppendQualificationInput,
	AppendQualificationResult,
	CreateBookingInput,
	CreateBookingResult,
} from "./tools";
import { BrainActionNameSchema, ToolRequestSchema } from "./tools";

export const ProviderHealthSchema = z
	.object({
		status: z.enum(["healthy", "degraded", "unavailable"]),
		code: z.string().min(1).max(100).optional(),
	})
	.strict();

export const TtsHealthSchema = z.enum(["ready", "degraded", "unavailable"]);

export const BrainToolModeSchema = z.enum(["dynamic", "envelope"]);

const MOSCOW_WEEKDAYS = [
	"воскресенье",
	"понедельник",
	"вторник",
	"среда",
	"четверг",
	"пятница",
	"суббота",
] as const;
const MOSCOW_OFFSET_MS = 3 * 60 * 60_000;

function slotFallsInTimeBand(
	slot: MeetingSlot,
	band: MeetingTimeBand,
): boolean {
	const moscow = new Date(new Date(slot.startAt).getTime() + MOSCOW_OFFSET_MS);
	const minute = moscow.getUTCHours() * 60 + moscow.getUTCMinutes();
	if (band === "morning") return minute >= 9 * 60 && minute <= 11 * 60 + 40;
	if (band === "evening") return minute >= 16 * 60 && minute <= 17 * 60;
	return minute >= 12 * 60 && minute <= 15 * 60 + 40;
}

export const ConcreteSchedulingReasonSchema = z.enum([
	"exact_request_included",
	"exact_time_not_included",
	"requested_date_unsatisfied",
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
]);

const ConcreteSchedulingNoneSchema = z
	.object({ kind: z.literal("none") })
	.strict();

const ConcreteSchedulingIncludedSchema = z
	.object({
		kind: z.literal("included"),
		requestedMoscowLocalDate: z.iso.date(),
		requestedMoscowLocalTime: z.string().regex(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/u),
		reason: z.literal("exact_request_included"),
		candidateIndex: z.union([z.literal(0), z.literal(1)]),
	})
	.strict();

const ConcreteSchedulingNotIncludedSchema = z
	.object({
		kind: z.literal("not_included"),
		requestedMoscowLocalDate: z.iso.date().optional(),
		requestedMoscowLocalTime: z
			.string()
			.regex(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/u)
			.optional(),
		reason: ConcreteSchedulingReasonSchema.exclude(["exact_request_included"]),
		candidateIndex: z.null(),
	})
	.strict()
	.superRefine((interpretation, refinement) => {
		const validRequestReason =
			interpretation.reason === "exact_time_not_included" ||
			interpretation.reason === "requested_date_unsatisfied";
		const hasRequestedDate =
			interpretation.requestedMoscowLocalDate !== undefined;
		const hasRequestedTime =
			interpretation.requestedMoscowLocalTime !== undefined;
		if (
			hasRequestedDate !== hasRequestedTime ||
			validRequestReason !== (hasRequestedDate && hasRequestedTime)
		) {
			refinement.addIssue({
				code: "custom",
				message:
					"Only a valid concrete request may include requested Moscow date and time",
			});
		}
	});

export const ConcreteSchedulingInterpretationSchema = z.union([
	ConcreteSchedulingNoneSchema,
	ConcreteSchedulingIncludedSchema,
	ConcreteSchedulingNotIncludedSchema,
]);

export const SchedulingCandidateSchema = z
	.object({
		meetingSlot: MeetingSlotSchema,
		displayLabel: z
			.string()
			.min(1)
			.max(200)
			.regex(
				/^\d{2} [а-яё]+ \d{4} года, (?:воскресенье|понедельник|вторник|среда|четверг|пятница|суббота), \d{2}:\d{2}–\d{2}:\d{2} по Москве$/u,
			),
	})
	.strict();

export const SchedulingContextSchema = z
	.object({
		currentInstant: z.iso
			.datetime({ offset: false })
			.refine((value) => new Date(value).toISOString() === value, {
				message: "Expected a canonical current UTC instant",
			}),
		moscowLocalDate: z.iso.date(),
		moscowWeekday: z.enum(MOSCOW_WEEKDAYS),
		timeOfDayPreference: MeetingTimePreferenceSchema,
		rejectedTimeOfDayPreferences: z
			.array(MeetingTimeBandSchema)
			.max(1)
			.default([]),
		concreteRequestInterpretation: ConcreteSchedulingInterpretationSchema,
		candidateMeetingSlots: z.tuple([
			SchedulingCandidateSchema,
			SchedulingCandidateSchema,
		]),
	})
	.strict()
	.superRefine((context, refinement) => {
		const local = new Date(
			new Date(context.currentInstant).getTime() + MOSCOW_OFFSET_MS,
		);
		const expectedDate = `${String(local.getUTCFullYear()).padStart(4, "0")}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
		if (context.moscowLocalDate !== expectedDate) {
			refinement.addIssue({
				code: "custom",
				path: ["moscowLocalDate"],
				message: "Moscow date must match the current instant",
			});
		}
		if (context.moscowWeekday !== MOSCOW_WEEKDAYS[local.getUTCDay()]) {
			refinement.addIssue({
				code: "custom",
				path: ["moscowWeekday"],
				message: "Moscow weekday must match the current instant",
			});
		}
		if (
			context.timeOfDayPreference !== "none" &&
			context.rejectedTimeOfDayPreferences.length > 0
		) {
			refinement.addIssue({
				code: "custom",
				path: ["rejectedTimeOfDayPreferences"],
				message: "A selected preference cannot also reject a time band",
			});
		}
		for (const rejected of context.rejectedTimeOfDayPreferences) {
			if (
				context.candidateMeetingSlots.some((candidate) =>
					slotFallsInTimeBand(candidate.meetingSlot, rejected),
				)
			) {
				refinement.addIssue({
					code: "custom",
					path: ["candidateMeetingSlots"],
					message: "Candidates must exclude explicitly rejected time bands",
				});
			}
		}
		if (
			context.candidateMeetingSlots[0].meetingSlot.startAt ===
			context.candidateMeetingSlots[1].meetingSlot.startAt
		) {
			refinement.addIssue({
				code: "custom",
				path: ["candidateMeetingSlots"],
				message: "Candidates must be unique",
			});
		}

		const concrete = context.concreteRequestInterpretation;
		if (concrete.kind === "none") return;
		const candidateLocalStarts = context.candidateMeetingSlots.map(
			(candidate) => {
				const local = new Date(
					new Date(candidate.meetingSlot.startAt).getTime() + MOSCOW_OFFSET_MS,
				);
				return {
					date: local.toISOString().slice(0, 10),
					time: `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`,
				};
			},
		);
		if (concrete.kind === "included") {
			const included = candidateLocalStarts[concrete.candidateIndex];
			if (
				included?.date !== concrete.requestedMoscowLocalDate ||
				included.time !== concrete.requestedMoscowLocalTime
			) {
				refinement.addIssue({
					code: "custom",
					path: ["concreteRequestInterpretation", "candidateIndex"],
					message: "Included candidate must match the exact concrete request",
				});
			}
			return;
		}
		if (!concrete.requestedMoscowLocalDate) return;
		if (
			candidateLocalStarts.some(
				(candidate) =>
					candidate.date === concrete.requestedMoscowLocalDate &&
					candidate.time === concrete.requestedMoscowLocalTime,
			)
		) {
			refinement.addIssue({
				code: "custom",
				path: ["concreteRequestInterpretation"],
				message:
					"A not-included interpretation cannot contain the exact request",
			});
		}
		const requestedDateSatisfied = candidateLocalStarts.every(
			(candidate) => candidate.date === concrete.requestedMoscowLocalDate,
		);
		if (
			(concrete.reason === "exact_time_not_included") !==
			requestedDateSatisfied
		) {
			refinement.addIssue({
				code: "custom",
				path: ["concreteRequestInterpretation", "reason"],
				message: "Concrete reason must match requested-date fulfillment",
			});
		}
	});

export const BrainTurnInputSchema = z
	.object({
		conversationId: EntityIdSchema,
		threadId: z.string().min(1).max(256).optional(),
		turnId: EntityIdSchema,
		generationId: EntityIdSchema,
		userText: z.string().min(1).max(20_000),
		stage: ConversationStageSchema,
		knownFacts: KnownFactsSchema,
		booking: BookingSnapshotSchema.nullable(),
		schedulingContext: SchedulingContextSchema,
		allowedActions: z.array(BrainActionNameSchema).max(2),
		promptVersion: z.string().regex(/^[a-f0-9]{64}$/i),
	})
	.strict();

export const BrainDeltaSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("speech.delta"),
			turnId: EntityIdSchema,
			generationId: EntityIdSchema,
			text: z.string().min(1).max(20_000),
		})
		.strict(),
	z
		.object({
			type: z.literal("tool.request"),
			turnId: EntityIdSchema,
			generationId: EntityIdSchema,
			tool: ToolRequestSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("turn.completed"),
			turnId: EntityIdSchema,
			generationId: EntityIdSchema,
			/** Untrusted brain proposal; the orchestrator must validate a state edge. */
			nextStage: ConversationStageSchema.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("error"),
			turnId: EntityIdSchema,
			generationId: EntityIdSchema,
			error: SafeErrorSchema,
		})
		.strict(),
]);

/**
 * Provider-independent contract safety ceiling. Gateway/provider configured
 * duration and byte limits remain authoritative and are normally much lower.
 */
export const STT_CONTRACT_MAX_AUDIO_BYTES = 10_000_000 as const;

export const SttAudioBytesSchema = z
	.custom<Uint8Array>(
		(value): value is Uint8Array => value instanceof Uint8Array,
		{ message: "Expected Uint8Array audio bytes" },
	)
	.refine((bytes) => bytes.byteLength > 0, {
		message: "Expected non-empty audio bytes",
	})
	.refine((bytes) => bytes.byteLength <= STT_CONTRACT_MAX_AUDIO_BYTES, {
		message: `Expected at most ${STT_CONTRACT_MAX_AUDIO_BYTES} contract audio bytes`,
	});

export const SttTranscriptionRequestDataSchema = z
	.object({
		conversationId: EntityIdSchema,
		turnId: EntityIdSchema,
		audio: SttAudioBytesSchema,
		contentType: z.literal("audio/wav"),
		language: z.string().trim().min(2).max(35),
	})
	.strict();

export const SttTranscriptionResultSchema = z
	.object({
		conversationId: EntityIdSchema,
		turnId: EntityIdSchema,
		text: z.string().trim().min(1).max(20_000),
		final: z.literal(true),
	})
	.strict();

export const SttHealthSchema = z.enum(["ready", "degraded", "unavailable"]);

/**
 * Serializable synthesis data only. AbortSignal deliberately stays outside
 * Zod: it is a live Web Platform cancellation capability, not JSON data, and
 * cannot be serialized or reconstructed reliably at a REST/WS boundary.
 */
export const TtsSynthesisRequestDataSchema = z
	.object({
		conversationId: EntityIdSchema,
		turnId: EntityIdSchema,
		generationId: EntityIdSchema,
		segmentId: EntityIdSchema,
		text: z.string().min(1).max(20_000),
	})
	.strict();

const TtsAudioSegmentBaseShape = {
	generationId: EntityIdSchema,
	segmentId: EntityIdSchema,
	providerGenerationId: z.string().min(1).max(512).optional(),
	final: z.literal(true),
};

export const TtsMp3AudioSegmentSchema = z
	.object({
		...TtsAudioSegmentBaseShape,
		contentType: z.literal("audio/mpeg"),
		bytes: MpegAudioBytesSchema,
	})
	.strict();

export const TtsWavAudioSegmentSchema = z
	.object({
		...TtsAudioSegmentBaseShape,
		contentType: z.literal("audio/wav"),
		bytes: CanonicalTtsWavBytesSchema,
	})
	.strict();

/** One complete, final MP3 or canonical 24 kHz PCM16 WAV segment. */
export const TtsAudioSegmentSchema = z.discriminatedUnion("contentType", [
	TtsMp3AudioSegmentSchema,
	TtsWavAudioSegmentSchema,
]);

export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type BrainToolMode = z.infer<typeof BrainToolModeSchema>;
export type BrainTurnInput = z.infer<typeof BrainTurnInputSchema>;
export type SchedulingCandidate = z.infer<typeof SchedulingCandidateSchema>;
export type ConcreteSchedulingInterpretation = z.infer<
	typeof ConcreteSchedulingInterpretationSchema
>;
export type ConcreteSchedulingReason = z.infer<
	typeof ConcreteSchedulingReasonSchema
>;
export type SchedulingContext = z.infer<typeof SchedulingContextSchema>;
export type BrainDelta = z.infer<typeof BrainDeltaSchema>;
export type SttTranscriptionRequestData = z.infer<
	typeof SttTranscriptionRequestDataSchema
>;
/** TypeScript-only request boundary: validated data plus live cancellation. */
export type SttTranscriptionRequest = SttTranscriptionRequestData & {
	signal: AbortSignal;
};
export type SttTranscriptionResult = z.infer<
	typeof SttTranscriptionResultSchema
>;
export type SttHealth = z.infer<typeof SttHealthSchema>;
export type TtsHealth = z.infer<typeof TtsHealthSchema>;
export type TtsSynthesisRequestData = z.infer<
	typeof TtsSynthesisRequestDataSchema
>;
/** TypeScript-only request boundary: validated data plus live cancellation. */
export type TtsSynthesisRequest = TtsSynthesisRequestData & {
	signal: AbortSignal;
};
export type TtsAudioSegment = z.infer<typeof TtsAudioSegmentSchema>;

export interface BrainPort {
	createThread(conversationId: string): Promise<string>;
	runTurn(
		input: BrainTurnInput,
		signal: AbortSignal,
	): AsyncIterable<BrainDelta>;
	interrupt(threadId: string, turnId: string): Promise<void>;
	/** Optional per-conversation lifecycle cleanup for shared brain adapters. */
	releaseConversation?(conversationId: string): Promise<void>;
	health(): Promise<ProviderHealth>;
}

export interface SttPort {
	transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>;
	health(): Promise<SttHealth>;
}

export interface TtsPort {
	synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment>;
	/** Optional cleanup for per-session budgets and adapter bookkeeping. */
	resetSession?(conversationId: string): void | Promise<void>;
	health(): Promise<TtsHealth>;
}

export interface Notifier {
	publish(event: BookingDomainEvent): Promise<void>;
}

export interface LeadNotifier extends Notifier {}

export interface BookingRepository {
	findById(bookingId: string): Promise<BookingSnapshot | null>;
	findByConversationId(conversationId: string): Promise<BookingSnapshot | null>;
	insert(input: CreateBookingInput): Promise<BookingSnapshot>;
	updateQualification(
		bookingId: string,
		patch: QualificationPatch,
		status: "partial" | "complete" | "skipped",
	): Promise<BookingSnapshot>;
}

export interface ConcreteMeetingCandidateRequest {
	/** Accepted final turn text; consumed only by the deterministic server parser. */
	userText: string;
	/** Canonical server clock sample shared with the orchestrator turn. */
	currentInstant: string;
}

export interface BookingService {
	/** Two current internal candidates; this is not an external availability claim. */
	candidateMeetingSlots(
		preference?: MeetingTimePreference,
		rejectedPreferences?: readonly MeetingTimeBand[],
		concreteRequest?: ConcreteMeetingCandidateRequest,
	): Promise<[MeetingSlot, MeetingSlot]>;
	/** Commits booking.created before this promise resolves. */
	createBooking(input: CreateBookingInput): Promise<CreateBookingResult>;

	/** Must reject calls until the referenced booking has been committed. */
	appendQualification(
		input: AppendQualificationInput,
	): Promise<AppendQualificationResult>;

	findByConversationId(conversationId: string): Promise<BookingSnapshot | null>;
}
