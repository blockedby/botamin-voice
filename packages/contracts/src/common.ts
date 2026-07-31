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
