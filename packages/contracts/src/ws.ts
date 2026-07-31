import { z } from "zod";
import {
	ContractVersionSchema,
	EntityIdSchema,
	NonEmptyUint8ArraySchema,
	Rfc3339UtcSchema,
	SafeErrorSchema,
} from "./common";
import { ConversationStageSchema } from "./domain";
import { AudioClientConfigSchema } from "./rest";

export const InputAudioConfigSchema = z
	.object({
		encoding: z.literal("pcm16le"),
		sampleRate: z.literal(16_000),
		channels: z.literal(1),
		chunkMs: z.literal(100),
	})
	.strict();

const ClientEventBaseShape = {
	v: ContractVersionSchema,
	conversationId: EntityIdSchema,
	at: Rfc3339UtcSchema,
};

export const ClientHelloEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("client.hello"),
		payload: z
			.object({
				resumeToken: z.string().min(16).max(512).nullable(),
				audio: InputAudioConfigSchema,
			})
			.strict(),
	})
	.strict();

export const AudioCommitEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("audio.commit"),
		payload: z.object({}).strict(),
	})
	.strict();

const PlaybackEventPayloadSchema = z
	.object({
		generationId: EntityIdSchema,
	})
	.strict();

export const PlaybackStartedEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("playback.started"),
		payload: PlaybackEventPayloadSchema,
	})
	.strict();

export const PlaybackInterruptedEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("playback.interrupted"),
		payload: z
			.object({
				generationId: EntityIdSchema,
				reason: z.enum([
					"barge_in",
					"user_stop",
					"new_generation",
					"playback_error",
				]),
			})
			.strict(),
	})
	.strict();

export const SessionStopEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("session.stop"),
		payload: z
			.object({
				reason: z.enum(["user_requested", "page_unload", "client_error"]),
			})
			.strict(),
	})
	.strict();

export const ClientPingEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("client.ping"),
		payload: z
			.object({
				sentAt: Rfc3339UtcSchema,
			})
			.strict(),
	})
	.strict();

export const ClientWsEventSchema = z.discriminatedUnion("type", [
	ClientHelloEventSchema,
	AudioCommitEventSchema,
	PlaybackStartedEventSchema,
	PlaybackInterruptedEventSchema,
	SessionStopEventSchema,
	ClientPingEventSchema,
]);

const ServerEventBaseShape = {
	v: ContractVersionSchema,
	conversationId: EntityIdSchema,
	seq: z.number().int().positive(),
	at: Rfc3339UtcSchema,
};

export const SessionReadyEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("session.ready"),
		payload: z
			.object({
				state: ConversationStageSchema,
				resumeToken: z.string().min(16).max(512),
				clientConfig: AudioClientConfigSchema,
			})
			.strict(),
	})
	.strict();

export const StateChangedEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("state.changed"),
		payload: z
			.object({
				from: ConversationStageSchema,
				to: ConversationStageSchema,
				reason: z.string().min(1).max(200),
			})
			.strict(),
	})
	.strict();

export const TranscriptPartialEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("transcript.partial"),
		payload: z
			.object({
				text: z.string().max(20_000),
				confidence: z.number().min(0).max(1).optional(),
			})
			.strict(),
	})
	.strict();

export const TranscriptFinalEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("transcript.final"),
		payload: z
			.object({
				turnId: EntityIdSchema,
				text: z.string().min(1).max(20_000),
			})
			.strict(),
	})
	.strict();

const AssistantGenerationPayloadSchema = z
	.object({
		generationId: EntityIdSchema,
	})
	.strict();

export const AssistantTextDeltaEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("assistant.text.delta"),
		payload: z
			.object({
				generationId: EntityIdSchema,
				text: z.string().min(1).max(20_000),
			})
			.strict(),
	})
	.strict();

export const AssistantTextDoneEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("assistant.text.done"),
		payload: z
			.object({
				generationId: EntityIdSchema,
				fullText: z.string().max(20_000),
			})
			.strict(),
	})
	.strict();

export const AudioSegmentMetadataSchema = z
	.object({
		generationId: EntityIdSchema,
		segmentId: EntityIdSchema,
		sequence: z.number().int().nonnegative(),
		contentType: z.literal("audio/mpeg"),
		byteLength: z.number().int().positive(),
		final: z.literal(true),
	})
	.strict();

/** Metadata for the one complete binary MP3 payload that follows atomically. */
export const AudioSegmentEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("audio.segment"),
		payload: AudioSegmentMetadataSchema,
	})
	.strict();

export const AssistantAudioDoneEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("assistant.audio.done"),
		payload: AssistantGenerationPayloadSchema,
	})
	.strict();

export const AssistantInterruptedEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("assistant.interrupted"),
		payload: AssistantGenerationPayloadSchema,
	})
	.strict();

export const BookingCreatedWsEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("booking.created"),
		payload: z
			.object({
				bookingId: EntityIdSchema,
				status: z.literal("booked"),
				qualificationStatus: z.literal("none"),
				createdAt: Rfc3339UtcSchema,
			})
			.strict(),
	})
	.strict();

export const BookingUpdatedWsEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("booking.updated"),
		payload: z
			.object({
				bookingId: EntityIdSchema,
				qualificationStatus: z.enum(["partial", "complete", "skipped"]),
				updatedFields: z.array(z.string().min(1)).max(11),
				updatedAt: Rfc3339UtcSchema,
			})
			.strict(),
	})
	.strict();

export const SessionCapacityWarningEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("session.capacity_warning"),
		payload: z
			.object({
				message: z.string().min(1).max(300),
			})
			.strict(),
	})
	.strict();

export const ErrorWsEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("error"),
		payload: SafeErrorSchema,
	})
	.strict();

export const ServerPongEventSchema = z
	.object({
		...ServerEventBaseShape,
		type: z.literal("server.pong"),
		payload: z
			.object({
				clientSentAt: Rfc3339UtcSchema,
			})
			.strict(),
	})
	.strict();

export const ServerWsEventSchema = z.discriminatedUnion("type", [
	SessionReadyEventSchema,
	StateChangedEventSchema,
	TranscriptPartialEventSchema,
	TranscriptFinalEventSchema,
	AssistantTextDeltaEventSchema,
	AssistantTextDoneEventSchema,
	AudioSegmentEventSchema,
	AssistantAudioDoneEventSchema,
	AssistantInterruptedEventSchema,
	BookingCreatedWsEventSchema,
	BookingUpdatedWsEventSchema,
	SessionCapacityWarningEventSchema,
	ErrorWsEventSchema,
	ServerPongEventSchema,
]);

export const WsJsonEventSchema = z.union([
	ClientWsEventSchema,
	ServerWsEventSchema,
]);

export const BINARY_AUDIO_FRAME_KIND = {
	clientPcm16: 0x01,
	serverMp3Segment: 0x02,
} as const;

/** Existing microphone framing remains mono PCM16LE at 16 kHz. */
export const ClientBinaryAudioFrameMetadataSchema = z
	.object({
		direction: z.literal("client"),
		streamSeq: z.number().int().nonnegative(),
		encoding: z.literal("pcm16le"),
		sampleRate: z.literal(16_000),
	})
	.strict();

export const ServerBinaryAudioFrameMetadataSchema = z
	.object({
		direction: z.literal("server"),
		...AudioSegmentMetadataSchema.shape,
	})
	.strict();

export const BinaryAudioFrameMetadataSchema = z.discriminatedUnion(
	"direction",
	[ClientBinaryAudioFrameMetadataSchema, ServerBinaryAudioFrameMetadataSchema],
);

/**
 * Runtime validation for adjacency: one audio.segment metadata payload is
 * followed by exactly one complete, non-empty binary payload of the same size.
 */
export const AtomicServerAudioSegmentFrameSchema = z
	.object({
		metadata: AudioSegmentMetadataSchema,
		bytes: NonEmptyUint8ArraySchema,
	})
	.strict()
	.superRefine((frame, context) => {
		if (frame.metadata.byteLength !== frame.bytes.byteLength) {
			context.addIssue({
				code: "custom",
				message:
					"Binary MP3 payload length does not match audio.segment metadata",
				path: ["bytes"],
			});
		}
	});

export type AtomicServerAudioSegmentFrame = z.infer<
	typeof AtomicServerAudioSegmentFrameSchema
>;
export type AudioSegmentMetadata = z.infer<typeof AudioSegmentMetadataSchema>;
export type AudioSegmentWsEvent = z.infer<typeof AudioSegmentEventSchema>;
export type BinaryAudioFrameMetadata = z.infer<
	typeof BinaryAudioFrameMetadataSchema
>;
export type ClientWsEvent = z.infer<typeof ClientWsEventSchema>;
export type ServerWsEvent = z.infer<typeof ServerWsEventSchema>;
export type WsJsonEvent = z.infer<typeof WsJsonEventSchema>;
export type WsServerEventType = ServerWsEvent["type"];
