export const MAX_ACCEPTED_VISITOR_TEXT_LENGTH = 20_000;

export type ConversationFactField =
	| "name"
	| "company"
	| "email"
	| "phone"
	| "telegram"
	| "salesManagerCount"
	| "monthlyLeadVolume";

export type FactExtractionContext = {
	/** The server-owned field whose answer is currently pending. */
	readonly expectedField?: ConversationFactField;
	/** Set only while a server-owned confirmation question is pending. */
	readonly pendingConfirmation?: true;
	/** Set only where a correction is meaningful in the current flow. */
	readonly correctionExpected?: true;
};

/**
 * Deliberately requires the caller to identify accepted raw visitor input.
 * Assistant/model text does not satisfy this envelope and is rejected at runtime.
 */
export type AcceptedVisitorText = {
	readonly source: "visitor";
	readonly accepted: true;
	readonly text: string;
	readonly context?: FactExtractionContext;
};

/** UTF-16 offsets, matching `String.prototype.slice`. */
export type FactSourceSpan = {
	readonly start: number;
	readonly end: number;
	/** Sensitive raw evidence: callers must not log or persist it by default. */
	readonly evidence: string;
};

export type CountAmount =
	| { readonly kind: "integer"; readonly value: number }
	| { readonly kind: "range"; readonly min: number; readonly max: number };

export type MonthlyLeadVolume =
	| {
			readonly kind: "monthly";
			readonly amount: CountAmount;
	  }
	| {
			readonly kind: "daily_rate";
			readonly amount: CountAmount;
			readonly basis: "generic_day";
			readonly basisStatus: "pending";
	  }
	| {
			readonly kind: "daily_rate";
			readonly amount: CountAmount;
			readonly basis: "business_day" | "calendar_day";
			readonly basisStatus: "explicit";
	  };

type FactProposalBase<Field extends ConversationFactField, Value> = {
	readonly field: Field;
	readonly value: Value;
	readonly source: FactSourceSpan;
};

export type ConversationFactProposal =
	| FactProposalBase<"name", string>
	| FactProposalBase<"company", string>
	| FactProposalBase<"email", string>
	| FactProposalBase<"phone", string>
	| FactProposalBase<"telegram", string>
	| FactProposalBase<"salesManagerCount", number>
	| FactProposalBase<"monthlyLeadVolume", MonthlyLeadVolume>;

export type ConversationIntentIndicators = {
	readonly correction: boolean;
	readonly confirmation: "confirmed" | "declined" | null;
	readonly alreadyAnswered: boolean;
};

export type ConversationFactExtractionResult =
	| {
			readonly kind: "extracted";
			readonly proposals: readonly ConversationFactProposal[];
			readonly intents: ConversationIntentIndicators;
	  }
	| {
			readonly kind: "rejected";
			readonly reason: "invalid_input" | "input_too_long";
			readonly proposals: readonly [];
			readonly intents: ConversationIntentIndicators;
	  };

/** Contains field names only: no values, evidence, offsets, or intent text. */
export type SafeFactFieldSummary = {
	readonly fields: readonly ConversationFactField[];
};
