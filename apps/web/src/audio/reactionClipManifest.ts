import type { ConversationStage } from "@botamin/contracts";

export const REACTION_CLIP_IDS = [
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

export type ReactionClipId = (typeof REACTION_CLIP_IDS)[number];

export type ReactionClipSemanticClass =
	| "neutral_thinking_backchannel"
	| "scheduling_calculation"
	| "data_validation"
	| "objection_transition"
	| "clarification";

export type ReactionClipTriggerIntent =
	| "latency_backchannel_needed"
	| "scheduling_calculation_active"
	| "data_validation_active"
	| "objection_detected"
	| "clarification_required";

export interface ReactionClipManifestEntry {
	readonly id: ReactionClipId;
	readonly path: `/assets/reactions/${string}.mp3`;
	readonly semanticClass: ReactionClipSemanticClass;
	readonly allowedStages: readonly ConversationStage[];
	readonly triggerIntent: ReactionClipTriggerIntent;
	readonly maxDurationMs: 1_250;
	readonly maxBytes: 128_000;
}

const INTERACTIVE_STAGES = [
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
] as const satisfies readonly ConversationStage[];

const CLIP_POLICY = {
	maxDurationMs: 1_250,
	maxBytes: 128_000,
} as const;

export const REACTION_CLIP_MANIFEST = [
	{
		id: "neutral-good",
		path: "/assets/reactions/neutral-good.mp3",
		semanticClass: "neutral_thinking_backchannel",
		allowedStages: INTERACTIVE_STAGES,
		triggerIntent: "latency_backchannel_needed",
		...CLIP_POLICY,
	},
	{
		id: "neutral-accepted",
		path: "/assets/reactions/neutral-accepted.mp3",
		semanticClass: "neutral_thinking_backchannel",
		allowedStages: INTERACTIVE_STAGES,
		triggerIntent: "latency_backchannel_needed",
		...CLIP_POLICY,
	},
	{
		id: "neutral-checking",
		path: "/assets/reactions/neutral-checking.mp3",
		semanticClass: "neutral_thinking_backchannel",
		allowedStages: INTERACTIVE_STAGES,
		triggerIntent: "latency_backchannel_needed",
		...CLIP_POLICY,
	},
	{
		id: "neutral-moment",
		path: "/assets/reactions/neutral-moment.mp3",
		semanticClass: "neutral_thinking_backchannel",
		allowedStages: INTERACTIVE_STAGES,
		triggerIntent: "latency_backchannel_needed",
		...CLIP_POLICY,
	},
	{
		id: "schedule-calculating-options",
		path: "/assets/reactions/schedule-calculating-options.mp3",
		semanticClass: "scheduling_calculation",
		allowedStages: ["BOOKING_OFFER", "COLLECT_BOOKING"],
		triggerIntent: "scheduling_calculation_active",
		...CLIP_POLICY,
	},
	{
		id: "schedule-checking-intervals",
		path: "/assets/reactions/schedule-checking-intervals.mp3",
		semanticClass: "scheduling_calculation",
		allowedStages: ["BOOKING_OFFER", "COLLECT_BOOKING"],
		triggerIntent: "scheduling_calculation_active",
		...CLIP_POLICY,
	},
	{
		id: "schedule-matching-time",
		path: "/assets/reactions/schedule-matching-time.mp3",
		semanticClass: "scheduling_calculation",
		allowedStages: ["BOOKING_OFFER", "COLLECT_BOOKING"],
		triggerIntent: "scheduling_calculation_active",
		...CLIP_POLICY,
	},
	{
		id: "validation-checking-data",
		path: "/assets/reactions/validation-checking-data.mp3",
		semanticClass: "data_validation",
		allowedStages: [
			"DISCOVERY",
			"COLLECT_BOOKING",
			"POST_BOOKING_QUALIFICATION",
		],
		triggerIntent: "data_validation_active",
		...CLIP_POLICY,
	},
	{
		id: "validation-checking-format",
		path: "/assets/reactions/validation-checking-format.mp3",
		semanticClass: "data_validation",
		allowedStages: [
			"DISCOVERY",
			"COLLECT_BOOKING",
			"POST_BOOKING_QUALIFICATION",
		],
		triggerIntent: "data_validation_active",
		...CLIP_POLICY,
	},
	{
		id: "validation-checking-fields",
		path: "/assets/reactions/validation-checking-fields.mp3",
		semanticClass: "data_validation",
		allowedStages: [
			"DISCOVERY",
			"COLLECT_BOOKING",
			"POST_BOOKING_QUALIFICATION",
		],
		triggerIntent: "data_validation_active",
		...CLIP_POLICY,
	},
	{
		id: "objection-examine",
		path: "/assets/reactions/objection-examine.mp3",
		semanticClass: "objection_transition",
		allowedStages: ["OBJECTION"],
		triggerIntent: "objection_detected",
		...CLIP_POLICY,
	},
	{
		id: "objection-more-detail",
		path: "/assets/reactions/objection-more-detail.mp3",
		semanticClass: "objection_transition",
		allowedStages: ["OBJECTION"],
		triggerIntent: "objection_detected",
		...CLIP_POLICY,
	},
	{
		id: "objection-to-the-point",
		path: "/assets/reactions/objection-to-the-point.mp3",
		semanticClass: "objection_transition",
		allowedStages: ["OBJECTION"],
		triggerIntent: "objection_detected",
		...CLIP_POLICY,
	},
	{
		id: "clarification-one-point",
		path: "/assets/reactions/clarification-one-point.mp3",
		semanticClass: "clarification",
		allowedStages: [
			"DISCOVERY",
			"VALUE",
			"OBJECTION",
			"BOOKING_OFFER",
			"COLLECT_BOOKING",
			"POST_BOOKING_QUALIFICATION",
		],
		triggerIntent: "clarification_required",
		...CLIP_POLICY,
	},
	{
		id: "clarification-one-detail",
		path: "/assets/reactions/clarification-one-detail.mp3",
		semanticClass: "clarification",
		allowedStages: [
			"DISCOVERY",
			"VALUE",
			"OBJECTION",
			"BOOKING_OFFER",
			"COLLECT_BOOKING",
			"POST_BOOKING_QUALIFICATION",
		],
		triggerIntent: "clarification_required",
		...CLIP_POLICY,
	},
	{
		id: "clarification-meaning",
		path: "/assets/reactions/clarification-meaning.mp3",
		semanticClass: "clarification",
		allowedStages: [
			"DISCOVERY",
			"VALUE",
			"OBJECTION",
			"BOOKING_OFFER",
			"COLLECT_BOOKING",
			"POST_BOOKING_QUALIFICATION",
		],
		triggerIntent: "clarification_required",
		...CLIP_POLICY,
	},
] as const satisfies readonly ReactionClipManifestEntry[];
