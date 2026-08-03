import { z } from "zod";
import {
	ContractVersionSchema,
	EntityIdSchema,
	LocaleSchema,
	Rfc3339UtcSchema,
	SafeErrorSchema,
} from "./common";
import { ConversationStageSchema, ConversationStatusSchema } from "./domain";

export const AudioClientConfigSchema = z
	.object({
		inputSampleRate: z.literal(16_000),
		inputEncoding: z.literal("pcm16le"),
		chunkMs: z.literal(100),
		maxUtteranceMs: z.number().int().min(100).max(120_000),
		maxPcmBytes: z.number().int().min(3_200).max(3_840_000),
		outputContentType: z.enum(["audio/mpeg", "audio/wav"]),
		outputMode: z.literal("complete-phrase-segments"),
	})
	.strict()
	.superRefine((config, context) => {
		if (config.maxPcmBytes % 2 !== 0) {
			context.addIssue({
				code: "custom",
				message: "maxPcmBytes must contain whole PCM16 samples",
				path: ["maxPcmBytes"],
			});
		}
		if (config.maxPcmBytes > Math.floor(config.maxUtteranceMs * 32)) {
			context.addIssue({
				code: "custom",
				message: "maxPcmBytes cannot exceed the utterance duration limit",
				path: ["maxPcmBytes"],
			});
		}
	});

export const CreateConversationRequestSchema = z
	.object({
		source: z.literal("landing"),
		locale: LocaleSchema.default("ru-RU"),
		qualificationEnabled: z.boolean(),
		consent: z
			.object({
				voiceProcessing: z.literal(true),
				contactProcessing: z.literal(true),
			})
			.strict(),
	})
	.strict();

export const CreateConversationResponseSchema = z
	.object({
		conversationId: EntityIdSchema,
		wsUrl: z.string().startsWith("/ws/v1/conversations/"),
		/** One-use bearer presented in the first client.hello, then rotated. */
		clientToken: z.string().min(32).max(256),
		expiresAt: Rfc3339UtcSchema,
		clientConfig: AudioClientConfigSchema,
	})
	.strict();

export const StopConversationRequestSchema = z
	.object({
		reason: z.enum(["user_requested", "page_unload", "client_error"]),
	})
	.strict();

export const StopConversationResponseSchema = z
	.object({
		conversationId: EntityIdSchema,
		stopped: z.literal(true),
	})
	.strict();

export const ApiErrorResponseSchema = z
	.object({
		v: ContractVersionSchema,
		error: SafeErrorSchema,
	})
	.strict();

export const LiveHealthResponseSchema = z
	.object({
		status: z.literal("ok"),
	})
	.strict();

export const ReadinessCheckSchema = z
	.object({
		name: z.enum([
			"database",
			"brain",
			"voice",
			"prompts",
			"notifier",
			"recovery",
			"capacity",
		]),
		status: z.enum(["ready", "degraded", "unready"]),
		code: z.string().min(1).max(100).optional(),
	})
	.strict();

export const ReadyHealthResponseSchema = z
	.object({
		status: z.enum(["ready", "unready"]),
		checks: z.array(ReadinessCheckSchema).min(1),
	})
	.strict();

export const DevConversationResponseSchema = z
	.object({
		conversationId: EntityIdSchema,
		status: ConversationStatusSchema,
		stage: ConversationStageSchema,
		turns: z.array(
			z
				.object({
					turnId: EntityIdSchema,
					userText: z.string(),
					assistantText: z.string(),
					interrupted: z.boolean(),
				})
				.strict(),
		),
		events: z.array(z.unknown()),
	})
	.strict();

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export type AudioClientConfig = z.infer<typeof AudioClientConfigSchema>;
export type CreateConversationRequest = z.input<
	typeof CreateConversationRequestSchema
>;
export type CreateConversationResponse = z.infer<
	typeof CreateConversationResponseSchema
>;
export type DevConversationResponse = z.infer<
	typeof DevConversationResponseSchema
>;
export type LiveHealthResponse = z.infer<typeof LiveHealthResponseSchema>;
export type ReadyHealthResponse = z.infer<typeof ReadyHealthResponseSchema>;
export type StopConversationRequest = z.infer<
	typeof StopConversationRequestSchema
>;
export type StopConversationResponse = z.infer<
	typeof StopConversationResponseSchema
>;
