import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Public identifiers are opaque, non-PII ULIDs or UUIDv7 values. */
export const EntityIdSchema = z
	.string()
	.refine((value) => ULID_PATTERN.test(value) || UUID_V7_PATTERN.test(value), {
		message: "Expected a ULID or UUIDv7",
	});

export const Rfc3339UtcSchema = z.iso.datetime({ offset: false });

export const ContractVersionSchema = z.literal(CONTRACT_VERSION);

export const LocaleSchema = z.string().min(2).max(35);

/** Runtime-neutral binary payload validation shared by ports and transports. */
export const NonEmptyUint8ArraySchema = z
	.instanceof(Uint8Array)
	.refine((bytes) => bytes.byteLength > 0, {
		message: "Expected non-empty bytes",
	});

const MPEG1_LAYER3_BITRATES_KBPS = [
	0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;
const MPEG2_LAYER3_BITRATES_KBPS = [
	0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
] as const;
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const;

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

function id3v2End(bytes: Uint8Array): number | null {
	if (!ascii(bytes, 0, "ID3")) return 0;
	if (bytes.byteLength < 10) return null;
	const majorVersion = bytes[3];
	const revision = bytes[4];
	const flags = bytes[5];
	if (
		(majorVersion !== 3 && majorVersion !== 4) ||
		revision === undefined ||
		revision === 0xff ||
		flags === undefined ||
		(majorVersion === 3 ? (flags & 0x1f) !== 0 : (flags & 0x0f) !== 0)
	) {
		return null;
	}
	const sizeBytes = [bytes[6], bytes[7], bytes[8], bytes[9]];
	if (
		sizeBytes.some(
			(value): value is undefined =>
				value === undefined || (value & 0x80) !== 0,
		)
	) {
		return null;
	}
	const [size6, size7, size8, size9] = sizeBytes as [
		number,
		number,
		number,
		number,
	];
	const size = (((((size6 << 7) | size7) << 7) | size8) << 7) | size9;
	const footerOffset = 10 + size;
	if ((flags & 0x10) === 0) {
		return footerOffset <= bytes.byteLength ? footerOffset : null;
	}
	const end = footerOffset + 10;
	if (
		majorVersion !== 4 ||
		end > bytes.byteLength ||
		!ascii(bytes, footerOffset, "3DI")
	) {
		return null;
	}
	for (let index = 3; index < 10; index += 1) {
		if (bytes[footerOffset + index] !== bytes[index]) return null;
	}
	return end;
}

function mpegLayer3FrameLength(
	bytes: Uint8Array,
	offset: number,
): number | null {
	const byte0 = bytes[offset];
	const byte1 = bytes[offset + 1];
	const byte2 = bytes[offset + 2];
	const byte3 = bytes[offset + 3];
	if (
		byte0 === undefined ||
		byte1 === undefined ||
		byte2 === undefined ||
		byte3 === undefined
	) {
		return null;
	}
	if (byte0 !== 0xff || (byte1 & 0xe0) !== 0xe0) return null;
	const versionBits = (byte1 >> 3) & 0x03;
	const layerBits = (byte1 >> 1) & 0x03;
	const bitrateIndex = (byte2 >> 4) & 0x0f;
	const sampleRateIndex = (byte2 >> 2) & 0x03;
	if (
		versionBits === 0x01 ||
		layerBits !== 0x01 ||
		bitrateIndex === 0 ||
		bitrateIndex === 0x0f ||
		sampleRateIndex === 0x03 ||
		(byte3 & 0x03) === 0x02
	) {
		return null;
	}
	const mpeg1 = versionBits === 0x03;
	const bitrateKbps = (
		mpeg1 ? MPEG1_LAYER3_BITRATES_KBPS : MPEG2_LAYER3_BITRATES_KBPS
	)[bitrateIndex];
	const mpeg1SampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex];
	if (bitrateKbps === undefined || mpeg1SampleRate === undefined) return null;
	const sampleRate =
		versionBits === 0x00
			? mpeg1SampleRate / 4
			: versionBits === 0x02
				? mpeg1SampleRate / 2
				: mpeg1SampleRate;
	const padding = (byte2 >> 1) & 0x01;
	return (
		Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1_000) / sampleRate) +
		padding
	);
}

/** Return true only when every byte belongs to one complete MP3 file. */
export function isCompleteMp3File(bytes: Uint8Array): boolean {
	let offset = id3v2End(bytes);
	if (offset === null) return false;
	let frames = 0;
	while (offset < bytes.byteLength) {
		if (
			frames > 0 &&
			bytes.byteLength - offset === 128 &&
			ascii(bytes, offset, "TAG")
		) {
			offset = bytes.byteLength;
			break;
		}
		const length = mpegLayer3FrameLength(bytes, offset);
		if (length === null || length < 4 || offset + length > bytes.byteLength) {
			return false;
		}
		offset += length;
		frames += 1;
	}
	return frames > 0 && offset === bytes.byteLength;
}

/** Strict complete-file MP3 validation shared by provider and WS boundaries. */
export const MpegAudioBytesSchema = NonEmptyUint8ArraySchema.refine(
	isCompleteMp3File,
	{ message: "Expected one complete MPEG Layer III file" },
);

export const SafeErrorCodeSchema = z.enum([
	"MIC_PERMISSION_DENIED",
	"CONSENT_REQUIRED",
	"SESSION_EXPIRED",
	"CAPACITY_EXCEEDED",
	"STT_UNAVAILABLE",
	"BRAIN_NOT_READY",
	"BRAIN_AUTH_REQUIRED",
	"BRAIN_RATE_LIMITED",
	"BRAIN_PROTOCOL_ERROR",
	"TTS_UNAVAILABLE",
	"BOOKING_VALIDATION_FAILED",
	"IDEMPOTENCY_CONFLICT",
	"ACTION_NOT_ALLOWED_IN_STATE",
	"DB_UNAVAILABLE",
	"NOTIFIER_FAILED",
	"INVALID_EVENT",
	"INTERNAL_ERROR",
]);

export const SafeErrorSchema = z
	.object({
		code: SafeErrorCodeSchema,
		message: z.string().min(1).max(500),
		retryable: z.boolean(),
	})
	.strict();

export type EntityId = z.infer<typeof EntityIdSchema>;
export type SafeError = z.infer<typeof SafeErrorSchema>;
export type SafeErrorCode = z.infer<typeof SafeErrorCodeSchema>;
