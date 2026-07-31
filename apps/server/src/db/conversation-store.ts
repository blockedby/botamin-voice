import {
	type ConversationStage,
	ConversationStageSchema,
	type ConversationStatus,
	ConversationStatusSchema,
	EntityIdSchema,
	Rfc3339UtcSchema,
} from "@botamin/contracts";
import { eq } from "drizzle-orm";
import type { DomainDatabase } from "./database";
import { conversations, turns } from "./schema";

export interface CreateConversationRecord {
	id: string;
	status?: ConversationStatus;
	stage: ConversationStage;
	codexThreadId?: string;
	promptVersion: string;
	source: string;
	locale: string;
	qualificationEnabled: boolean;
	consentAt: string;
	startedAt: string;
}

export interface CreateTurnRecord {
	id: string;
	conversationId: string;
	userText: string;
	assistantText: string;
	stateBefore: ConversationStage;
	stateAfter: ConversationStage;
	completedAt?: string;
	interrupted?: boolean;
	brainModel?: string;
}

function validateConversation(input: CreateConversationRecord) {
	const status = ConversationStatusSchema.parse(input.status ?? "active");
	if (!/^[a-f0-9]{64}$/i.test(input.promptVersion)) {
		throw new TypeError("promptVersion must be a SHA-256 hash");
	}
	if (input.source.length === 0 || input.source.length > 100) {
		throw new TypeError("source must contain 1-100 characters");
	}
	if (input.locale.length < 2 || input.locale.length > 35) {
		throw new TypeError("locale must contain 2-35 characters");
	}
	return {
		...input,
		id: EntityIdSchema.parse(input.id),
		status,
		stage: ConversationStageSchema.parse(input.stage),
		consentAt: Rfc3339UtcSchema.parse(input.consentAt),
		startedAt: Rfc3339UtcSchema.parse(input.startedAt),
	};
}

function validateTurn(input: CreateTurnRecord) {
	if (input.userText.length > 20_000 || input.assistantText.length > 20_000) {
		throw new TypeError("Turn text exceeds the storage limit");
	}
	return {
		...input,
		id: EntityIdSchema.parse(input.id),
		conversationId: EntityIdSchema.parse(input.conversationId),
		stateBefore: ConversationStageSchema.parse(input.stateBefore),
		stateAfter: ConversationStageSchema.parse(input.stateAfter),
		completedAt:
			input.completedAt === undefined
				? undefined
				: Rfc3339UtcSchema.parse(input.completedAt),
		interrupted: input.interrupted ?? false,
	};
}

export interface ConversationRecord {
	id: string;
	status: ConversationStatus;
	stage: ConversationStage;
}

export class ConversationStore {
	constructor(private readonly database: DomainDatabase) {}

	create(input: CreateConversationRecord): ConversationRecord {
		const record = validateConversation(input);
		this.database
			.insert(conversations)
			.values({
				id: record.id,
				status: record.status,
				stage: record.stage,
				...(record.codexThreadId === undefined
					? {}
					: { codexThreadId: record.codexThreadId }),
				promptVersion: record.promptVersion,
				source: record.source,
				locale: record.locale,
				qualificationEnabled: record.qualificationEnabled,
				consentAt: record.consentAt,
				startedAt: record.startedAt,
			})
			.run();
		return { id: record.id, status: record.status, stage: record.stage };
	}

	appendTurn(input: CreateTurnRecord): void {
		const record = validateTurn(input);
		this.database
			.insert(turns)
			.values({
				id: record.id,
				conversationId: record.conversationId,
				userText: record.userText,
				assistantText: record.assistantText,
				stateBefore: record.stateBefore,
				stateAfter: record.stateAfter,
				...(record.completedAt === undefined
					? {}
					: { completedAt: record.completedAt }),
				interrupted: record.interrupted,
				...(record.brainModel === undefined
					? {}
					: { brainModel: record.brainModel }),
			})
			.run();
	}

	find(id: string): ConversationRecord | null {
		const row = this.database
			.select({
				id: conversations.id,
				status: conversations.status,
				stage: conversations.stage,
			})
			.from(conversations)
			.where(eq(conversations.id, id))
			.get();
		if (row === undefined) return null;
		return {
			id: row.id,
			status: ConversationStatusSchema.parse(row.status),
			stage: ConversationStageSchema.parse(row.stage),
		};
	}
}
