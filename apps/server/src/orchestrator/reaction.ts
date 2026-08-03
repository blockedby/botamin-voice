import type {
	ConversationStage,
	LocalReactionClipId,
} from "@botamin/contracts";

interface ReactionPolicyEntry {
	readonly clipId: LocalReactionClipId;
	readonly allowedStages: readonly ConversationStage[];
}

const INTERACTIVE_STAGES = [
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
] as const satisfies readonly ConversationStage[];

/**
 * Runtime-safe acknowledgements only. Every other corpus clip either claims an
 * active operation or can imply validation/acceptance. Those clips stay in the
 * corpus but require a future explicit, server-owned operation signal before
 * they can be added to runtime policy.
 */
const REACTION_POLICY = [
	{
		clipId: "neutral-moment",
		allowedStages: INTERACTIVE_STAGES,
	},
] as const satisfies readonly ReactionPolicyEntry[];

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
	const candidates = REACTION_POLICY.filter(
		(entry) =>
			(entry.allowedStages as readonly ConversationStage[]).includes(
				input.stage,
			) && input.supportedClipIds.has(entry.clipId),
	);
	if (candidates.length === 0) return null;
	const seed = `${input.turnId}:${input.generationId}:${input.stage}:safe-neutral`;
	let hash = 2_166_136_261;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return candidates[(hash >>> 0) % candidates.length]?.clipId ?? null;
}
