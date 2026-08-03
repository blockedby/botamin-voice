import type { ConversationStage } from "@botamin/contracts";

export const SPEECH_DELIVERY_STYLES = [
	"neutral",
	"curious",
	"serious",
	"excited",
] as const;

export type SpeechDeliveryStyle = (typeof SPEECH_DELIVERY_STYLES)[number];

export const SPEECH_RESPONSE_PROVENANCES = [
	"model_generated",
	"server_authority",
	"server_fallback",
] as const;

export type SpeechResponseProvenance =
	(typeof SPEECH_RESPONSE_PROVENANCES)[number];

export const SPEECH_RESPONSE_CATEGORIES = [
	"greeting",
	"discovery_question",
	"objection_explanation",
	"value_explanation",
	"soft_offer",
	"scheduling_calculation",
	"booking_confirmation",
	"qualification",
	"refusal",
	"error",
	"fallback",
	"failure",
	"other",
] as const;

export type SpeechResponseCategory =
	(typeof SPEECH_RESPONSE_CATEGORIES)[number];

/**
 * Trusted, server-derived presentation metadata only. Text, transcripts,
 * contacts, and durable conversation or booking objects are intentionally not
 * accepted by this boundary.
 */
export interface SpeechDeliveryStyleInput {
	readonly stage: ConversationStage;
	readonly provenance: SpeechResponseProvenance;
	readonly category: SpeechResponseCategory;
	readonly containsProtectedApprovedContact: boolean;
	readonly containsExactMeetingFacts: boolean;
	readonly containsBookingConfirmation: boolean;
	readonly containsQualificationFacts: boolean;
	readonly priorTurnInterrupted: boolean;
	/** Unicode code point count computed by the server; never the response text. */
	readonly responseLength?: number;
}

const ALWAYS_NEUTRAL_STAGES = new Set<ConversationStage>([
	"IDLE",
	"CONNECTING",
	"GREETING",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
	"COMPLETE",
	"DECLINED",
	"DISCONNECTED",
	"ERROR",
]);

const ALWAYS_NEUTRAL_CATEGORIES = new Set<SpeechResponseCategory>([
	"greeting",
	"scheduling_calculation",
	"booking_confirmation",
	"qualification",
	"refusal",
	"error",
	"fallback",
	"failure",
	"other",
]);

const MAX_EXPRESSIVE_RESPONSE_LENGTH = 320;
const EXPRESSIVE_COOLDOWN_DELIVERIES = 2;

function hasSensitiveOrAuthoritativeContent(
	input: SpeechDeliveryStyleInput,
): boolean {
	return (
		input.provenance !== "model_generated" ||
		input.containsProtectedApprovedContact ||
		input.containsExactMeetingFacts ||
		input.containsBookingConfirmation ||
		input.containsQualificationFacts
	);
}

function candidateStyle(input: SpeechDeliveryStyleInput): SpeechDeliveryStyle {
	if (
		input.priorTurnInterrupted ||
		ALWAYS_NEUTRAL_STAGES.has(input.stage) ||
		ALWAYS_NEUTRAL_CATEGORIES.has(input.category) ||
		hasSensitiveOrAuthoritativeContent(input)
	) {
		return "neutral";
	}

	if (
		input.responseLength !== undefined &&
		(!Number.isSafeInteger(input.responseLength) ||
			input.responseLength < 0 ||
			input.responseLength > MAX_EXPRESSIVE_RESPONSE_LENGTH)
	) {
		return "neutral";
	}

	if (input.stage === "DISCOVERY" && input.category === "discovery_question") {
		return "curious";
	}
	if (
		input.stage === "OBJECTION" &&
		input.category === "objection_explanation"
	) {
		return "serious";
	}
	if (
		(input.stage === "VALUE" &&
			(input.category === "value_explanation" ||
				input.category === "soft_offer")) ||
		(input.stage === "BOOKING_OFFER" && input.category === "soft_offer")
	) {
		return "excited";
	}
	return "neutral";
}

/**
 * Pure server-owned style policy. Recent history is read only by bounded index
 * lookups; curious and excited are suppressed when used in the last two
 * deliveries. The return value is always a provider-neutral low-cardinality
 * enum and carries no response text or PII.
 */
export function selectSpeechDeliveryStyle(
	input: SpeechDeliveryStyleInput,
	recentStyles: readonly SpeechDeliveryStyle[] = [],
): SpeechDeliveryStyle {
	const candidate = candidateStyle(input);
	if (candidate !== "curious" && candidate !== "excited") return candidate;

	const historyStart = Math.max(
		0,
		recentStyles.length - EXPRESSIVE_COOLDOWN_DELIVERIES,
	);
	for (let index = historyStart; index < recentStyles.length; index += 1) {
		if (recentStyles[index] === candidate) return "neutral";
	}
	return candidate;
}

/**
 * Optional per-live-session convenience wrapper. It retains only style enums
 * in process memory, is deliberately not serializable, and never touches
 * durable conversation or booking state.
 */
export class SpeechDeliveryStyleCooldown {
	#recentStyles: SpeechDeliveryStyle[] = [];

	select(input: SpeechDeliveryStyleInput): SpeechDeliveryStyle {
		const style = selectSpeechDeliveryStyle(input, this.#recentStyles);
		this.#recentStyles.push(style);
		if (this.#recentStyles.length > EXPRESSIVE_COOLDOWN_DELIVERIES) {
			this.#recentStyles.shift();
		}
		return style;
	}

	clear(): void {
		this.#recentStyles = [];
	}
}
