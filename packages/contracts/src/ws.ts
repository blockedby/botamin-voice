import { z } from "zod";
import {
	ContractVersionSchema,
	EntityIdSchema,
	MpegAudioBytesSchema,
	NonEmptyUint8ArraySchema,
	Rfc3339UtcSchema,
	SafeErrorSchema,
} from "./common";
import { ConversationStageSchema, QualificationFieldSchema } from "./domain";
import { AudioClientConfigSchema } from "./rest";

/** Binary-frame sequences are unsigned integers exactly representable by JS. */
export const BinaryAudioFrameSequenceSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

export const VISITOR_TEXT_MAX_LENGTH = 2_000 as const;

/** Monotonic typed-turn sequence scoped to one conversation session. */
export const VisitorTextSequenceSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

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

/** One bounded, final visitor turn. It carries no provider or tool fields. */
export const VisitorTextSubmitEventSchema = z
	.object({
		...ClientEventBaseShape,
		type: z.literal("visitor.text.submit"),
		payload: z
			.object({
				sequence: VisitorTextSequenceSchema,
				text: z.string().trim().min(1).max(VISITOR_TEXT_MAX_LENGTH),
			})
			.strict(),
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
	VisitorTextSubmitEventSchema,
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
		sequence: BinaryAudioFrameSequenceSchema,
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
				updatedFields: z.array(QualificationFieldSchema).max(2),
				qualificationFields: z.array(QualificationFieldSchema).max(2),
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

/**
 * Canonical microphone/server audio frame kinds. The wire layout is shared by
 * browser and server implementations and is independent of Node/Bun Buffer.
 */
export const BINARY_AUDIO_FRAME_KIND = Object.freeze({
	clientPcm16: 0x01,
	serverMp3Segment: 0x02,
} as const);
export const BINARY_AUDIO_FRAME_KIND_OFFSET = 0 as const;
export const BINARY_AUDIO_FRAME_SEQUENCE_OFFSET = 1 as const;
export const BINARY_AUDIO_FRAME_SEQUENCE_BYTES = 8 as const;
export const BINARY_AUDIO_FRAME_HEADER_BYTES = 9 as const;
export const BINARY_AUDIO_FRAME_PAYLOAD_OFFSET =
	BINARY_AUDIO_FRAME_HEADER_BYTES;
export const BINARY_AUDIO_FRAME_BYTE_ORDER = "big-endian" as const;

export type BinaryAudioFrameKind =
	(typeof BINARY_AUDIO_FRAME_KIND)[keyof typeof BINARY_AUDIO_FRAME_KIND];
export interface BinaryAudioFrame {
	kind: BinaryAudioFrameKind;
	sequence: number;
	payload: Uint8Array;
}

function isBinaryAudioFrameKind(value: number): value is BinaryAudioFrameKind {
	return (
		value === BINARY_AUDIO_FRAME_KIND.clientPcm16 ||
		value === BINARY_AUDIO_FRAME_KIND.serverMp3Segment
	);
}

/**
 * Encode byte 0 kind, bytes 1-8 unsigned sequence in big-endian/network order,
 * and bytes 9+ payload. Sequence must be a nonnegative JS safe integer.
 */
export function encodeBinaryAudioFrame(frame: BinaryAudioFrame): Uint8Array {
	if (!isBinaryAudioFrameKind(frame.kind)) {
		throw new RangeError(`Unknown binary audio frame kind: ${frame.kind}`);
	}
	if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
		throw new RangeError(
			"Binary audio frame sequence must be a nonnegative JS safe integer",
		);
	}
	if (
		!(frame.payload instanceof Uint8Array) ||
		frame.payload.byteLength === 0
	) {
		throw new TypeError("Binary audio frame payload must be non-empty bytes");
	}

	const rawFrame = new Uint8Array(
		BINARY_AUDIO_FRAME_HEADER_BYTES + frame.payload.byteLength,
	);
	rawFrame[BINARY_AUDIO_FRAME_KIND_OFFSET] = frame.kind;
	const view = new DataView(rawFrame.buffer);
	const high = Math.floor(frame.sequence / 0x1_0000_0000);
	const low = frame.sequence - high * 0x1_0000_0000;
	view.setUint32(BINARY_AUDIO_FRAME_SEQUENCE_OFFSET, high, false);
	view.setUint32(BINARY_AUDIO_FRAME_SEQUENCE_OFFSET + 4, low, false);
	rawFrame.set(frame.payload, BINARY_AUDIO_FRAME_PAYLOAD_OFFSET);
	return rawFrame;
}

/** Decode the canonical 9-byte network-order header and copy its payload. */
export function decodeBinaryAudioFrame(rawFrame: Uint8Array): BinaryAudioFrame {
	if (!(rawFrame instanceof Uint8Array)) {
		throw new TypeError("Binary audio frame must be Uint8Array bytes");
	}
	if (rawFrame.byteLength <= BINARY_AUDIO_FRAME_HEADER_BYTES) {
		throw new RangeError(
			"Binary audio frame must contain a 9-byte header and non-empty payload",
		);
	}

	const kind = rawFrame[BINARY_AUDIO_FRAME_KIND_OFFSET];
	if (kind === undefined || !isBinaryAudioFrameKind(kind)) {
		throw new RangeError(`Unknown binary audio frame kind: ${kind}`);
	}
	const view = new DataView(
		rawFrame.buffer,
		rawFrame.byteOffset,
		rawFrame.byteLength,
	);
	const high = view.getUint32(BINARY_AUDIO_FRAME_SEQUENCE_OFFSET, false);
	const low = view.getUint32(BINARY_AUDIO_FRAME_SEQUENCE_OFFSET + 4, false);
	const sequence = high * 0x1_0000_0000 + low;
	if (!Number.isSafeInteger(sequence)) {
		throw new RangeError(
			"Binary audio frame sequence exceeds Number.MAX_SAFE_INTEGER",
		);
	}

	return {
		kind,
		sequence,
		payload: rawFrame.slice(BINARY_AUDIO_FRAME_PAYLOAD_OFFSET),
	};
}

/** Existing microphone framing remains mono PCM16LE at 16 kHz. */
export const ClientBinaryAudioFrameMetadataSchema = z
	.object({
		direction: z.literal("client"),
		streamSeq: BinaryAudioFrameSequenceSchema,
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
 * Validates the adjacent JSON metadata and canonical raw binary frame as one
 * coherent server MP3 segment. metadata.byteLength counts payload bytes only.
 */
export const AtomicServerAudioSegmentFrameSchema = z
	.object({
		metadata: AudioSegmentMetadataSchema,
		rawFrame: NonEmptyUint8ArraySchema,
	})
	.strict()
	.superRefine((atomicFrame, context) => {
		let decoded: BinaryAudioFrame;
		try {
			decoded = decodeBinaryAudioFrame(atomicFrame.rawFrame);
		} catch (error) {
			context.addIssue({
				code: "custom",
				message:
					error instanceof Error ? error.message : "Invalid binary audio frame",
				path: ["rawFrame"],
			});
			return;
		}

		if (decoded.kind !== BINARY_AUDIO_FRAME_KIND.serverMp3Segment) {
			context.addIssue({
				code: "custom",
				message: "audio.segment must be paired with a server MP3 frame kind",
				path: ["rawFrame", BINARY_AUDIO_FRAME_KIND_OFFSET],
			});
		}
		if (decoded.sequence !== atomicFrame.metadata.sequence) {
			context.addIssue({
				code: "custom",
				message: "Binary frame sequence does not match audio.segment metadata",
				path: ["rawFrame"],
			});
		}
		if (decoded.payload.byteLength !== atomicFrame.metadata.byteLength) {
			context.addIssue({
				code: "custom",
				message:
					"Binary MP3 payload length does not match audio.segment metadata",
				path: ["rawFrame"],
			});
		}
		const mp3Result = MpegAudioBytesSchema.safeParse(decoded.payload);
		if (!mp3Result.success) {
			context.addIssue({
				code: "custom",
				message: "Binary audio.segment payload is not structurally valid MP3",
				path: ["rawFrame", BINARY_AUDIO_FRAME_PAYLOAD_OFFSET],
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
