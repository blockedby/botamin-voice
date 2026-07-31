import {
	type BookingSnapshot,
	type BrainActionName,
	type BrainTurnInput,
	BrainTurnInputSchema,
	type KnownFacts,
} from "@botamin/contracts";

const MAX_FACT_LENGTH = 300;

function compactText(value: string): string {
	return value.replace(/\s+/gu, " ").trim().slice(0, MAX_FACT_LENGTH);
}

function compactList(values: readonly string[]): string[] {
	return [...new Set(values.map(compactText).filter(Boolean))].slice(0, 10);
}

export function compactKnownFacts(facts: KnownFacts): KnownFacts {
	return {
		...(facts.company ? { company: compactText(facts.company) } : {}),
		...(facts.role ? { role: compactText(facts.role) } : {}),
		useCases: compactList(facts.useCases),
		painPoints: compactList(facts.painPoints),
		objections: compactList(facts.objections),
	};
}

export interface BrainContextInput {
	conversationId: string;
	threadId?: string;
	turnId: string;
	generationId: string;
	userText: string;
	stage: BrainTurnInput["stage"];
	knownFacts: KnownFacts;
	booking: BookingSnapshot | null;
	allowedActions: readonly BrainActionName[];
	promptVersion: string;
}

/** Builds the complete, bounded context envelope passed to every brain turn. */
export function buildBrainContext(input: BrainContextInput): BrainTurnInput {
	return BrainTurnInputSchema.parse({
		conversationId: input.conversationId,
		...(input.threadId ? { threadId: input.threadId } : {}),
		turnId: input.turnId,
		generationId: input.generationId,
		userText: input.userText.replace(/\s+/gu, " ").trim(),
		stage: input.stage,
		knownFacts: compactKnownFacts(input.knownFacts),
		booking: input.booking,
		allowedActions: [...new Set(input.allowedActions)].sort(),
		promptVersion: input.promptVersion,
	});
}
