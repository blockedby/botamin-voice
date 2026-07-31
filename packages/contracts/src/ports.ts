import { z } from "zod";
import { EntityIdSchema, SafeErrorSchema } from "./common";
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

export const SttSessionInputSchema = z
	.object({
		conversationId: EntityIdSchema,
		encoding: z.literal("pcm16le"),
		sampleRate: z.literal(16_000),
		channels: z.literal(1),
		language: z.string().min(2).max(35),
	})
	.strict();

export const SttEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("transcript.partial"),
			text: z.string().max(20_000),
			confidence: z.number().min(0).max(1).optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("transcript.final"),
			turnId: EntityIdSchema,
			text: z.string().min(1).max(20_000),
		})
		.strict(),
	z
		.object({
			type: z.literal("error"),
			error: SafeErrorSchema,
		})
		.strict(),
]);

export const TtsInputSchema = z
	.object({
		conversationId: EntityIdSchema,
		generationId: EntityIdSchema,
		text: z.string().min(1).max(20_000),
		language: z.string().min(2).max(35),
		outputEncoding: z.literal("pcm16le"),
		outputSampleRate: z.literal(24_000),
	})
	.strict();

export const TtsEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("audio.chunk"),
			generationId: EntityIdSchema,
			audioSeq: z.number().int().nonnegative(),
			audio: z.instanceof(Uint8Array),
		})
		.strict(),
	z
		.object({
			type: z.literal("audio.done"),
			generationId: EntityIdSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("error"),
			generationId: EntityIdSchema,
			error: SafeErrorSchema,
		})
		.strict(),
]);

export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type BrainToolMode = z.infer<typeof BrainToolModeSchema>;
export type BrainTurnInput = z.infer<typeof BrainTurnInputSchema>;
export type BrainDelta = z.infer<typeof BrainDeltaSchema>;
export type SttSessionInput = z.infer<typeof SttSessionInputSchema>;
export type SttEvent = z.infer<typeof SttEventSchema>;
export type TtsInput = z.infer<typeof TtsInputSchema>;
export type TtsEvent = z.infer<typeof TtsEventSchema>;

export interface BrainPort {
	createThread(conversationId: string): Promise<string>;
	runTurn(
		input: BrainTurnInput,
		signal: AbortSignal,
	): AsyncIterable<BrainDelta>;
	interrupt(threadId: string, turnId: string): Promise<void>;
	health(): Promise<ProviderHealth>;
}

export interface SttSession {
	events(): AsyncIterable<SttEvent>;
	sendAudio(frame: Uint8Array): Promise<void>;
	commit(): Promise<void>;
	close(): Promise<void>;
}

export interface SttPort {
	connect(input: SttSessionInput, signal: AbortSignal): Promise<SttSession>;
	health(): Promise<ProviderHealth>;
}

export interface TtsPort {
	synthesize(input: TtsInput, signal: AbortSignal): AsyncIterable<TtsEvent>;
	cancel(generationId: string): Promise<void>;
	health(): Promise<ProviderHealth>;
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
