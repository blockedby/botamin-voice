import { z } from "zod";

/** Protocol version for the fixed local reaction corpus. */
export const LOCAL_REACTION_CAPABILITY_VERSION = 1 as const;

/**
 * Wire allowlist only. Spoken copy and asset paths intentionally stay out of
 * the protocol and server events.
 */
export const LOCAL_REACTION_CLIP_IDS = [
	"neutral-good",
	"neutral-accepted",
	"neutral-checking",
	"neutral-moment",
	"schedule-calculating-options",
	"schedule-checking-intervals",
	"schedule-matching-time",
	"validation-checking-data",
	"validation-checking-format",
	"validation-checking-fields",
	"objection-examine",
	"objection-more-detail",
	"objection-to-the-point",
	"clarification-one-point",
	"clarification-one-detail",
	"clarification-meaning",
] as const;

export const LocalReactionClipIdSchema = z.enum(LOCAL_REACTION_CLIP_IDS);
export type LocalReactionClipId = z.infer<typeof LocalReactionClipIdSchema>;

export const LocalReactionCapabilitySchema = z
	.object({
		version: z.literal(LOCAL_REACTION_CAPABILITY_VERSION),
		clipIds: z
			.array(LocalReactionClipIdSchema)
			.min(1)
			.max(LOCAL_REACTION_CLIP_IDS.length),
	})
	.strict()
	.superRefine((capability, context) => {
		if (new Set(capability.clipIds).size !== capability.clipIds.length) {
			context.addIssue({
				code: "custom",
				message: "Local reaction clip IDs must be unique",
				path: ["clipIds"],
			});
		}
	});

export type LocalReactionCapability = z.infer<
	typeof LocalReactionCapabilitySchema
>;

export const LOCAL_REACTION_DELAY_MS = 350 as const;
export const LOCAL_REACTION_DELAY_MIN_MS = 300 as const;
export const LOCAL_REACTION_DELAY_MAX_MS = 500 as const;
export const LocalReactionDelayMsSchema = z
	.number()
	.int()
	.min(LOCAL_REACTION_DELAY_MIN_MS)
	.max(LOCAL_REACTION_DELAY_MAX_MS);
