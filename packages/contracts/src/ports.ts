import { z } from "zod";
import {
	EntityIdSchema,
	MpegAudioBytesSchema,
	SafeErrorSchema,
} from "./common";
import type {
	BookingDomainEvent,
	BookingSnapshot,
	QualificationPatch,
} from "./domain";
import {
	BookingSnapshotSchema,
	ConversationStageSchema,
	KnownFactsSchema,
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

export const TtsAudioSegmentSchema = z
	.object({
		generationId: EntityIdSchema,
		segmentId: EntityIdSchema,
		providerGenerationId: z.string().min(1).max(512).optional(),
		contentType: z.literal("audio/mpeg"),
		bytes: MpegAudioBytesSchema,
		final: z.literal(true),
	})
	.strict();

export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type BrainToolMode = z.infer<typeof BrainToolModeSchema>;
export type BrainTurnInput = z.infer<typeof BrainTurnInputSchema>;
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
	health(): Promise<ProviderHealth>;
}

export interface SttPort {
	transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>;
	health(): Promise<SttHealth>;
}

export interface TtsPort {
	synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment>;
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

export interface BookingService {
	/** Commits booking.created before this promise resolves. */
	createBooking(input: CreateBookingInput): Promise<CreateBookingResult>;

	/** Must reject calls until the referenced booking has been committed. */
	appendQualification(
		input: AppendQualificationInput,
	): Promise<AppendQualificationResult>;

	findByConversationId(conversationId: string): Promise<BookingSnapshot | null>;
}
