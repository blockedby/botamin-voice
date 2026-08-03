export type JsonObject = Record<string, unknown>;

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface RpcNotification {
	method: string;
	params?: unknown;
}

export interface RpcServerRequest extends RpcNotification {
	id: number | string;
}

export interface ThreadStartResult {
	thread: { id: string };
	model: string;
	modelProvider: string;
	cwd: string;
	instructionSources: string[];
	approvalPolicy: unknown;
	sandbox: unknown;
}

export interface TurnStartResult {
	turn: { id: string; status: string; error?: unknown };
}

export interface ModelListResult {
	data: Array<{
		id: string;
		model: string;
		hidden?: boolean;
		supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
		serviceTiers?: Array<{
			id: string;
			name: string;
			description: string;
		}>;
		additionalSpeedTiers?: string[];
	}>;
	nextCursor: string | null;
}

export interface AccountReadResult {
	account: null | { type: string };
	requiresOpenaiAuth: boolean;
}

export interface ConfigReadResult {
	modelProvider: string;
}

export interface DynamicToolCallParams {
	threadId: string;
	turnId: string;
	callId: string;
	namespace: string | null;
	tool: string;
	arguments: unknown;
}

export interface AgentMessageDeltaParams {
	threadId: string;
	turnId: string;
	itemId: string;
	delta: string;
}

export interface TurnCompletedParams {
	threadId: string;
	turn: {
		id: string;
		status: "completed" | "interrupted" | "failed" | "inProgress";
		error: null | { message?: string; codexErrorInfo?: unknown };
	};
}

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): JsonObject {
	if (!isRecord(value)) throw new Error(`Invalid Codex protocol ${label}`);
	return value;
}

export function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Invalid Codex protocol ${label}`);
	return value;
}

export function parseThreadStartResult(value: unknown): ThreadStartResult {
	const root = requireRecord(value, "thread response");
	const thread = requireRecord(root.thread, "thread");
	if (!Array.isArray(root.instructionSources))
		throw new Error("Invalid Codex protocol instructionSources");
	return {
		thread: { id: requireString(thread.id, "thread.id") },
		model: requireString(root.model, "model"),
		modelProvider: requireString(root.modelProvider, "modelProvider"),
		cwd: requireString(root.cwd, "cwd"),
		instructionSources: root.instructionSources.map((entry) =>
			requireString(entry, "instruction source"),
		),
		approvalPolicy: root.approvalPolicy,
		sandbox: root.sandbox,
	};
}

export function parseTurnStartResult(value: unknown): TurnStartResult {
	const root = requireRecord(value, "turn response");
	const turn = requireRecord(root.turn, "turn");
	return {
		turn: {
			id: requireString(turn.id, "turn.id"),
			status: requireString(turn.status, "turn.status"),
			error: turn.error,
		},
	};
}

export function parseModelListResult(value: unknown): ModelListResult {
	const root = requireRecord(value, "model/list response");
	if (!Array.isArray(root.data))
		throw new Error("Invalid Codex protocol model/list data");
	return {
		data: root.data.map((entry) => {
			const model = requireRecord(entry, "model");
			const efforts = Array.isArray(model.supportedReasoningEfforts)
				? model.supportedReasoningEfforts.map((effort) => ({
						reasoningEffort: requireString(
							requireRecord(effort, "reasoning effort").reasoningEffort,
							"reasoningEffort",
						),
					}))
				: undefined;
			const serviceTiers = optionalArray(
				model.serviceTiers,
				"serviceTiers",
			)?.map((entry) => {
				const tier = requireRecord(entry, "service tier");
				return {
					id: requireString(tier.id, "serviceTier.id"),
					name: requireString(tier.name, "serviceTier.name"),
					description: requireString(
						tier.description,
						"serviceTier.description",
					),
				};
			});
			const additionalSpeedTiers = optionalArray(
				model.additionalSpeedTiers,
				"additionalSpeedTiers",
			)?.map((tier) => requireString(tier, "additionalSpeedTier"));
			return {
				id: requireString(model.id, "model.id"),
				model: requireString(model.model, "model.model"),
				...(typeof model.hidden === "boolean" ? { hidden: model.hidden } : {}),
				...(efforts ? { supportedReasoningEfforts: efforts } : {}),
				...(serviceTiers ? { serviceTiers } : {}),
				...(additionalSpeedTiers ? { additionalSpeedTiers } : {}),
			};
		}),
		nextCursor:
			root.nextCursor === null
				? null
				: requireString(root.nextCursor, "nextCursor"),
	};
}

function optionalArray(value: unknown, label: string): unknown[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`Invalid Codex protocol ${label}`);
	return value;
}

export function parseAccountReadResult(value: unknown): AccountReadResult {
	const root = requireRecord(value, "account/read response");
	if (typeof root.requiresOpenaiAuth !== "boolean")
		throw new Error("Invalid Codex protocol requiresOpenaiAuth");
	if (root.account === null)
		return { account: null, requiresOpenaiAuth: root.requiresOpenaiAuth };
	return {
		account: {
			type: requireString(
				requireRecord(root.account, "account").type,
				"account.type",
			),
		},
		requiresOpenaiAuth: root.requiresOpenaiAuth,
	};
}

export function parseConfigReadResult(value: unknown): ConfigReadResult {
	const root = requireRecord(value, "config/read response");
	const config = requireRecord(root.config, "config/read config");
	return {
		modelProvider: requireString(
			config.model_provider,
			"config.model_provider",
		),
	};
}

export function parseAgentMessageDelta(
	value: unknown,
): AgentMessageDeltaParams {
	const root = requireRecord(value, "agent delta");
	return {
		threadId: requireString(root.threadId, "delta.threadId"),
		turnId: requireString(root.turnId, "delta.turnId"),
		itemId: requireString(root.itemId, "delta.itemId"),
		delta: requireString(root.delta, "delta.delta"),
	};
}

export function parseTurnCompleted(value: unknown): TurnCompletedParams {
	const root = requireRecord(value, "turn completed");
	const turn = requireRecord(root.turn, "completed turn");
	const status = requireString(turn.status, "completed status");
	if (!["completed", "interrupted", "failed", "inProgress"].includes(status))
		throw new Error("Invalid Codex protocol turn status");
	const error = turn.error;
	if (error !== null && !isRecord(error))
		throw new Error("Invalid Codex protocol turn error");
	return {
		threadId: requireString(root.threadId, "completed.threadId"),
		turn: {
			id: requireString(turn.id, "completed.turn.id"),
			status: status as TurnCompletedParams["turn"]["status"],
			error: error as TurnCompletedParams["turn"]["error"],
		},
	};
}

export function parseDynamicToolCall(value: unknown): DynamicToolCallParams {
	const root = requireRecord(value, "dynamic tool call");
	return {
		threadId: requireString(root.threadId, "tool.threadId"),
		turnId: requireString(root.turnId, "tool.turnId"),
		callId: requireString(root.callId, "tool.callId"),
		// CLI 0.146.0 omits namespace for top-level tools; explicit null is
		// equivalent on the pinned wire protocol.
		namespace:
			root.namespace === undefined || root.namespace === null
				? null
				: requireString(root.namespace, "tool.namespace"),
		tool: requireString(root.tool, "tool.name"),
		arguments: root.arguments,
	};
}
