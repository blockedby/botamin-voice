import type {
	ConversationStage,
	LocalReactionClipId,
} from "@botamin/contracts";

export type ReactionTriggerIntent =
	| "latency_backchannel_needed"
	| "scheduling_calculation_active"
	| "data_validation_active"
	| "objection_detected"
	| "clarification_required";

interface ReactionPolicyEntry {
	readonly clipId: LocalReactionClipId;
	readonly trigger: ReactionTriggerIntent;
	readonly allowedStages: readonly ConversationStage[];
}

const INTERACTIVE_STAGES = [
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
] as const satisfies readonly ConversationStage[];

/** Server policy mirrors only the manifest's IDs, stages, and trigger classes. */
const REACTION_POLICY = [
	...[
		"neutral-good",
		"neutral-accepted",
		"neutral-checking",
		"neutral-moment",
	].map((clipId) => ({
		clipId,
		trigger: "latency_backchannel_needed",
		allowedStages: INTERACTIVE_STAGES,
	})),
	...[
		"schedule-calculating-options",
		"schedule-checking-intervals",
		"schedule-matching-time",
	].map((clipId) => ({
		clipId,
		trigger: "scheduling_calculation_active",
		allowedStages: ["BOOKING_OFFER"],
	})),
	...[
		"validation-checking-data",
		"validation-checking-format",
		"validation-checking-fields",
	].map((clipId) => ({
		clipId,
		trigger: "data_validation_active",
		allowedStages: ["DISCOVERY"],
	})),
	...[
		"objection-examine",
		"objection-more-detail",
		"objection-to-the-point",
	].map((clipId) => ({
		clipId,
		trigger: "objection_detected",
		allowedStages: ["OBJECTION"],
	})),
	...[
		"clarification-one-point",
		"clarification-one-detail",
		"clarification-meaning",
	].map((clipId) => ({
		clipId,
		trigger: "clarification_required",
		allowedStages: ["DISCOVERY", "VALUE", "OBJECTION", "BOOKING_OFFER"],
	})),
] as readonly ReactionPolicyEntry[];

const TERMINAL_OR_PRIVATE_STAGES = new Set<ConversationStage>([
	"IDLE",
	"CONNECTING",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
	"COMPLETE",
	"DECLINED",
	"DISCONNECTED",
	"ERROR",
]);

const CONTACT_OR_DATE_PATTERN =
	/(?:@|https?:\/\/|www\.|(?:e-?mail|email|телефон|телеграм|telegram|контакт|почт[аы]|номер)|\d{1,2}[.:]\d{2}|\d{4}-\d{2}-\d{2}|(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*)/iu;
const EXACT_FACT_PATTERN =
	/(?:\d|[%₽$€]|(?:сколько|когда|где|какой адрес|точн(?:ый|ая|ое|ые|о)|цена|стоимость|срок|дата|время))/iu;

/** Conservative safety fence: a false positive only removes decoration. */
export function hasPrivateOrExactReactionContent(text: string): boolean {
	return CONTACT_OR_DATE_PATTERN.test(text) || EXACT_FACT_PATTERN.test(text);
}

function classifyTrigger(
	stage: ConversationStage,
	userText: string,
): ReactionTriggerIntent {
	const normalized = userText.toLocaleLowerCase("ru-RU");
	if (
		/(?:уточн|не понял|не поняла|что значит|поясни|проясни)\p{L}*/u.test(
			normalized,
		)
	) {
		return "clarification_required";
	}
	if (
		stage === "DISCOVERY" &&
		/(?:провер|формат|валид|корректн)\p{L}*/u.test(normalized)
	) {
		return "data_validation_active";
	}
	if (stage === "OBJECTION") return "objection_detected";
	if (stage === "BOOKING_OFFER") return "scheduling_calculation_active";
	return "latency_backchannel_needed";
}

export function selectLocalReaction(input: {
	turnId: string;
	generationId: string;
	stage: ConversationStage;
	userText: string;
	assistantText: string;
	supportedClipIds: ReadonlySet<LocalReactionClipId>;
}): LocalReactionClipId | null {
	if (
		TERMINAL_OR_PRIVATE_STAGES.has(input.stage) ||
		hasPrivateOrExactReactionContent(input.userText) ||
		hasPrivateOrExactReactionContent(input.assistantText)
	) {
		return null;
	}
	const trigger = classifyTrigger(input.stage, input.userText);
	const candidates = REACTION_POLICY.filter(
		(entry) =>
			entry.trigger === trigger &&
			entry.allowedStages.includes(input.stage) &&
			input.supportedClipIds.has(entry.clipId),
	);
	if (candidates.length === 0) return null;
	const seed = `${input.turnId}:${input.generationId}:${trigger}`;
	let hash = 2_166_136_261;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return candidates[(hash >>> 0) % candidates.length]?.clipId ?? null;
}
