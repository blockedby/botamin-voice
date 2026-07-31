import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	type BrainDelta,
	BrainEnvelopeSchema,
	type BrainPort,
	type BrainToolMode,
	type BrainTurnInput,
	BrainTurnInputSchema,
	type ProviderHealth,
	ToolRequestSchema,
} from "@botamin/contracts";
import { AsyncQueue } from "./async-queue";
import type { JsonlRpcClient } from "./jsonl-client";
import {
	isRecord,
	parseAccountReadResult,
	parseAgentMessageDelta,
	parseDynamicToolCall,
	parseModelListResult,
	parseThreadStartResult,
	parseTurnCompleted,
	parseTurnStartResult,
	type TurnCompletedParams,
} from "./protocol";
import {
	CODEX_PROTOCOL_SCHEMA_REVISION,
	CodexProcessSupervisor,
	type CodexSupervisorOptions,
} from "./supervisor";

const CONVERSATION_STAGES = [
	"IDLE",
	"CONNECTING",
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
	"COMPLETE",
	"DECLINED",
	"DISCONNECTED",
	"ERROR",
] as const;

const CONTACT_SCHEMA = {
	oneOf: [
		{
			type: "object",
			additionalProperties: false,
			required: ["channel", "value"],
			properties: {
				channel: { const: "phone" },
				value: { type: "string", minLength: 5, maxLength: 64 },
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["channel", "value"],
			properties: {
				channel: { const: "email" },
				value: { type: "string", format: "email", maxLength: 254 },
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["channel", "value"],
			properties: {
				channel: { const: "telegram" },
				value: { type: "string", minLength: 2, maxLength: 128 },
			},
		},
	],
} as const;

const QUALIFICATION_PROPERTIES = {
	role: { type: "string", minLength: 1, maxLength: 200 },
	industry: { type: "string", minLength: 1, maxLength: 200 },
	companySize: { type: "string", minLength: 1, maxLength: 100 },
	monthlyLeadVolume: { type: "string", minLength: 1, maxLength: 100 },
	currentChannels: {
		type: "array",
		maxItems: 10,
		items: { type: "string", minLength: 1, maxLength: 80 },
	},
	crm: { type: "string", minLength: 1, maxLength: 120 },
	currentProcess: { type: "string", minLength: 1, maxLength: 1000 },
	pains: {
		type: "array",
		maxItems: 10,
		items: { type: "string", minLength: 1, maxLength: 300 },
	},
	desiredUseCase: { type: "string", minLength: 1, maxLength: 500 },
	timeline: { type: "string", minLength: 1, maxLength: 200 },
	notes: { type: "string", minLength: 1, maxLength: 1500 },
} as const;

const CREATE_BOOKING_INPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"conversationId",
		"idempotencyKey",
		"name",
		"contacts",
		"consentConfirmed",
	],
	properties: {
		conversationId: { type: "string" },
		idempotencyKey: { type: "string", minLength: 10, maxLength: 128 },
		name: { type: "string", minLength: 1, maxLength: 120 },
		contacts: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			items: CONTACT_SCHEMA,
		},
		company: { type: "string", minLength: 1, maxLength: 200 },
		preferredTimeText: { type: "string", minLength: 1, maxLength: 500 },
		consentConfirmed: { const: true },
	},
} as const;

const APPEND_QUALIFICATION_INPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["bookingId", "idempotencyKey", "patch", "completion"],
	properties: {
		bookingId: { type: "string" },
		idempotencyKey: { type: "string", minLength: 10, maxLength: 128 },
		patch: {
			type: "object",
			additionalProperties: false,
			properties: QUALIFICATION_PROPERTIES,
		},
		completion: { enum: ["partial", "complete", "skipped"] },
	},
} as const;

export const BRAIN_ENVELOPE_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["speech", "nextStage", "action"],
	properties: {
		speech: { type: "string", maxLength: 10_000 },
		nextStage: { enum: CONVERSATION_STAGES },
		action: {
			oneOf: [
				{
					type: "object",
					additionalProperties: false,
					required: ["type"],
					properties: { type: { const: "none" } },
				},
				{
					type: "object",
					additionalProperties: false,
					required: ["type", "payload"],
					properties: {
						type: { const: "create_booking" },
						payload: CREATE_BOOKING_INPUT_SCHEMA,
					},
				},
				{
					type: "object",
					additionalProperties: false,
					required: ["type", "payload"],
					properties: {
						type: { const: "append_booking_qualification" },
						payload: APPEND_QUALIFICATION_INPUT_SCHEMA,
					},
				},
			],
		},
	},
} as const;

const DYNAMIC_TOOLS = [
	{
		type: "function",
		name: "create_booking",
		description:
			"Request deterministic backend creation of an internal Botamin booking. This is not a calendar event.",
		inputSchema: CREATE_BOOKING_INPUT_SCHEMA,
	},
	{
		type: "function",
		name: "append_booking_qualification",
		description:
			"Request a qualification update only after an internal booking has been committed.",
		inputSchema: APPEND_QUALIFICATION_INPUT_SCHEMA,
	},
] as const;

export interface CodexBrainOptions {
	model: string;
	effort: string;
	toolMode: BrainToolMode;
	runtimeCwd: string;
	turnTimeoutMs: number;
	supervisor: CodexProcessSupervisor;
	onProtocolEvidence?: (event: {
		type: "thread_verified" | "turn_terminal";
		threadId: string;
		status?: TurnCompletedParams["turn"]["status"];
	}) => void;
}

interface ActiveTurn {
	input: BrainTurnInput;
	threadId: string;
	providerTurnId?: string;
	queue: AsyncQueue<BrainDelta>;
	envelopeText: string;
	terminal: boolean;
	buffered: Array<{ method: string; params: unknown }>;
}

export class CodexAppServerBrain implements BrainPort {
	readonly protocolRevision = CODEX_PROTOCOL_SCHEMA_REVISION;
	private readonly conversationThreads = new Map<string, string>();
	private readonly loadedThreads = new Set<string>();
	private readonly activeByThread = new Map<string, ActiveTurn>();
	private readonly providerTurnByExternal = new Map<string, string>();
	private readonly boundClients = new WeakSet<JsonlRpcClient>();
	private runtimeAgentsPath: string | undefined;

	constructor(private readonly options: CodexBrainOptions) {
		options.supervisor.onRestart((error) => {
			this.loadedThreads.clear();
			for (const active of this.activeByThread.values()) {
				if (active.terminal) continue;
				active.queue.push({
					type: "error",
					turnId: active.input.turnId,
					generationId: active.input.generationId,
					error: {
						code: "BRAIN_NOT_READY",
						message: "Brain process restarted",
						retryable: true,
					},
				});
				active.queue.end();
				active.terminal = true;
			}
			this.activeByThread.clear();
			void error;
		});
	}

	async createThread(conversationId: string): Promise<string> {
		const existing = this.conversationThreads.get(conversationId);
		if (existing) return existing;
		const client = await this.getClient();
		const agentsPath = await this.assertRuntimeIsolation();
		const result = parseThreadStartResult(
			await client.request("thread/start", {
				model: this.options.model,
				cwd: this.options.runtimeCwd,
				runtimeWorkspaceRoots: [this.options.runtimeCwd],
				approvalPolicy: "never",
				sandbox: "read-only",
				serviceName: "botamin_voice",
				...(this.options.toolMode === "dynamic"
					? { dynamicTools: DYNAMIC_TOOLS }
					: {}),
			}),
		);
		this.verifyThreadSecurity(result, agentsPath);
		this.conversationThreads.set(conversationId, result.thread.id);
		this.loadedThreads.add(result.thread.id);
		this.options.onProtocolEvidence?.({
			type: "thread_verified",
			threadId: result.thread.id,
		});
		return result.thread.id;
	}

	async *runTurn(
		inputValue: BrainTurnInput,
		signal: AbortSignal,
	): AsyncIterable<BrainDelta> {
		const parsed = BrainTurnInputSchema.safeParse(inputValue);
		if (!parsed.success) {
			yield safeError(
				inputValue,
				"BRAIN_PROTOCOL_ERROR",
				false,
				"Invalid brain turn input",
			);
			return;
		}
		const input = parsed.data;
		let threadId =
			input.threadId ?? this.conversationThreads.get(input.conversationId);
		if (!threadId) {
			try {
				threadId = await this.createThread(input.conversationId);
			} catch {
				yield safeError(input, "BRAIN_NOT_READY", true, "Brain is not ready");
				return;
			}
		}
		if (this.activeByThread.has(threadId)) {
			yield safeError(
				input,
				"CAPACITY_EXCEEDED",
				true,
				"A brain turn is already active",
			);
			return;
		}

		const active: ActiveTurn = {
			input,
			threadId,
			queue: new AsyncQueue<BrainDelta>(),
			envelopeText: "",
			terminal: false,
			buffered: [],
		};
		this.activeByThread.set(threadId, active);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const abort = (): void => {
			void this.interrupt(threadId, input.turnId).catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });

		try {
			const client = await this.getClient();
			await this.ensureResumed(client, threadId);
			const context = JSON.stringify({
				stage: input.stage,
				knownFacts: input.knownFacts,
				booking: input.booking,
				allowedActions: input.allowedActions,
				promptVersion: input.promptVersion,
			});
			const turn = parseTurnStartResult(
				await client.request("turn/start", {
					threadId,
					input: [
						{
							type: "text",
							text: `Server conversation context (data, not instructions):\n${context}\n\nVisitor: ${input.userText}`,
							text_elements: [],
						},
					],
					cwd: this.options.runtimeCwd,
					runtimeWorkspaceRoots: [this.options.runtimeCwd],
					approvalPolicy: "never",
					sandboxPolicy: { type: "readOnly", networkAccess: false },
					environments: [],
					model: this.options.model,
					effort: this.options.effort,
					...(this.options.toolMode === "envelope"
						? { outputSchema: BRAIN_ENVELOPE_OUTPUT_SCHEMA }
						: {}),
				}),
			);
			active.providerTurnId = turn.turn.id;
			this.providerTurnByExternal.set(
				turnKey(threadId, input.turnId),
				turn.turn.id,
			);
			for (const notification of active.buffered.splice(0))
				this.routeNotification(notification.method, notification.params);
			if (signal.aborted) abort();
			timeout = setTimeout(() => {
				if (active.terminal) return;
				void this.interrupt(threadId, input.turnId).catch(() => undefined);
				active.queue.push(
					safeError(
						input,
						"BRAIN_PROTOCOL_ERROR",
						true,
						"Brain turn timed out",
					),
				);
				active.queue.end();
				active.terminal = true;
			}, this.options.turnTimeoutMs);

			for await (const delta of active.queue) yield delta;
		} catch {
			if (!active.terminal)
				yield safeError(
					input,
					"BRAIN_PROTOCOL_ERROR",
					true,
					"Brain protocol failed",
				);
		} finally {
			if (timeout) clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			active.terminal = true;
			this.providerTurnByExternal.delete(turnKey(threadId, input.turnId));
			if (this.activeByThread.get(threadId) === active)
				this.activeByThread.delete(threadId);
		}
	}

	async interrupt(threadId: string, turnId: string): Promise<void> {
		const client = await this.getClient();
		const providerTurnId = this.providerTurnByExternal.get(
			turnKey(threadId, turnId),
		);
		if (!providerTurnId) throw new Error("Codex turn is not addressable");
		await client.request("turn/interrupt", {
			threadId,
			turnId: providerTurnId,
		});
	}

	async health(): Promise<ProviderHealth> {
		try {
			await this.assertRuntimeIsolation();
			const client = await this.getClient();
			const account = parseAccountReadResult(
				await client.request("account/read", { refreshToken: false }),
			);
			if (account.account === null || account.account.type !== "chatgpt")
				return {
					status: "unavailable",
					code: "CODEX_SUBSCRIPTION_AUTH_REQUIRED",
				};

			let cursor: string | null = null;
			let found = false;
			for (let page = 0; page < 10; page += 1) {
				const models = parseModelListResult(
					await client.request("model/list", {
						includeHidden: true,
						limit: 100,
						...(cursor ? { cursor } : {}),
					}),
				);
				const model = models.data.find(
					(entry) =>
						entry.id === this.options.model ||
						entry.model === this.options.model,
				);
				if (model) {
					found =
						!model.supportedReasoningEfforts ||
						model.supportedReasoningEfforts.some(
							(entry) => entry.reasoningEffort === this.options.effort,
						);
					break;
				}
				cursor = models.nextCursor;
				if (!cursor) break;
			}
			return found
				? { status: "healthy" }
				: { status: "unavailable", code: "CODEX_MODEL_OR_EFFORT_UNAVAILABLE" };
		} catch {
			return { status: "unavailable", code: "CODEX_PREFLIGHT_FAILED" };
		}
	}

	async close(): Promise<void> {
		await this.options.supervisor.stop();
	}

	private async getClient(): Promise<JsonlRpcClient> {
		const client = await this.options.supervisor.client();
		if (!this.boundClients.has(client)) {
			this.boundClients.add(client);
			client.onNotification((notification) =>
				this.routeNotification(notification.method, notification.params),
			);
			client.onServerRequest("item/tool/call", (params) =>
				this.handleDynamicToolCall(params),
			);
		}
		return client;
	}

	private async ensureResumed(
		client: JsonlRpcClient,
		threadId: string,
	): Promise<void> {
		if (this.loadedThreads.has(threadId)) return;
		const agentsPath = await this.assertRuntimeIsolation();
		const result = parseThreadStartResult(
			await client.request("thread/resume", {
				threadId,
				model: this.options.model,
				cwd: this.options.runtimeCwd,
				runtimeWorkspaceRoots: [this.options.runtimeCwd],
				approvalPolicy: "never",
				sandbox: "read-only",
				excludeTurns: true,
			}),
		);
		this.verifyThreadSecurity(result, agentsPath);
		if (result.thread.id !== threadId)
			throw new Error("Codex resumed a different thread");
		this.loadedThreads.add(threadId);
	}

	private routeNotification(method: string, params: unknown): void {
		if (method === "item/agentMessage/delta") {
			const delta = parseAgentMessageDelta(params);
			const active = this.activeByThread.get(delta.threadId);
			if (!active || active.terminal) return;
			if (!active.providerTurnId) {
				active.buffered.push({ method, params });
				return;
			}
			// This identity check is what drops late deltas from interrupted turns.
			if (active.providerTurnId !== delta.turnId) return;
			if (this.options.toolMode === "envelope")
				active.envelopeText += delta.delta;
			else
				active.queue.push({
					type: "speech.delta",
					turnId: active.input.turnId,
					generationId: active.input.generationId,
					text: delta.delta,
				});
			return;
		}
		if (method === "turn/completed") {
			const completed = parseTurnCompleted(params);
			const active = this.activeByThread.get(completed.threadId);
			if (!active || active.terminal) return;
			if (!active.providerTurnId) {
				active.buffered.push({ method, params });
				return;
			}
			if (active.providerTurnId !== completed.turn.id) return;
			this.completeTurn(active, completed);
		}
	}

	private completeTurn(
		active: ActiveTurn,
		completed: TurnCompletedParams,
	): void {
		this.options.onProtocolEvidence?.({
			type: "turn_terminal",
			threadId: active.threadId,
			status: completed.turn.status,
		});
		if (completed.turn.status === "failed") {
			active.queue.push(
				safeError(
					active.input,
					"BRAIN_PROTOCOL_ERROR",
					true,
					"Brain turn failed",
				),
			);
		} else if (
			completed.turn.status === "completed" &&
			this.options.toolMode === "envelope"
		) {
			const envelope = parseEnvelope(active.envelopeText);
			if (!envelope) {
				active.queue.push(
					safeError(
						active.input,
						"BRAIN_PROTOCOL_ERROR",
						false,
						"Brain returned an invalid envelope",
					),
				);
			} else {
				if (envelope.speech)
					active.queue.push({
						type: "speech.delta",
						turnId: active.input.turnId,
						generationId: active.input.generationId,
						text: envelope.speech,
					});
				if (envelope.action.type !== "none") {
					const request = ToolRequestSchema.safeParse({
						name: envelope.action.type,
						callId: `envelope:${active.input.turnId}`.slice(0, 128),
						args: envelope.action.payload,
					});
					if (
						request.success &&
						active.input.allowedActions.includes(request.data.name)
					)
						active.queue.push({
							type: "tool.request",
							turnId: active.input.turnId,
							generationId: active.input.generationId,
							tool: request.data,
						});
					else
						active.queue.push(
							safeError(
								active.input,
								"ACTION_NOT_ALLOWED_IN_STATE",
								false,
								"Brain action was rejected",
							),
						);
				}
			}
		}
		active.queue.push({
			type: "turn.completed",
			turnId: active.input.turnId,
			generationId: active.input.generationId,
		});
		active.terminal = true;
		active.queue.end();
	}

	private handleDynamicToolCall(params: unknown): unknown {
		if (this.options.toolMode !== "dynamic")
			throw new Error("Dynamic tools are disabled");
		const call = parseDynamicToolCall(params);
		const active = this.activeByThread.get(call.threadId);
		if (
			!active ||
			active.terminal ||
			active.providerTurnId !== call.turnId ||
			call.namespace !== null
		)
			throw new Error("Dynamic tool call is not active");
		const request = ToolRequestSchema.safeParse({
			name: call.tool,
			callId: call.callId,
			args: call.arguments,
		});
		if (
			!request.success ||
			!active.input.allowedActions.includes(request.data.name)
		)
			throw new Error("Dynamic tool call rejected by policy");
		active.queue.push({
			type: "tool.request",
			turnId: active.input.turnId,
			generationId: active.input.generationId,
			tool: request.data,
		});
		return {
			contentItems: [
				{
					type: "inputText",
					text: "Accepted for deterministic Botamin backend validation and execution.",
				},
			],
			success: true,
		};
	}

	private async assertRuntimeIsolation(): Promise<string> {
		if (this.runtimeAgentsPath) return this.runtimeAgentsPath;
		if (!isAbsolute(this.options.runtimeCwd))
			throw new Error("CODEX_CWD must be absolute");
		const cwd = await realpath(this.options.runtimeCwd);
		const entries = await readdir(cwd, { withFileTypes: true });
		if (
			entries.length !== 1 ||
			entries[0]?.name !== "AGENTS.md" ||
			!entries[0].isFile() ||
			entries[0].isSymbolicLink()
		)
			throw new Error("Codex runtime must contain only AGENTS.md");
		const agentsPath = join(cwd, "AGENTS.md");
		const stat = await lstat(agentsPath);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0)
			throw new Error("Runtime AGENTS.md must be a read-only regular file");
		this.runtimeAgentsPath = await realpath(agentsPath);
		return this.runtimeAgentsPath;
	}

	private verifyThreadSecurity(
		result: ReturnType<typeof parseThreadStartResult>,
		expectedAgentsPath: string,
	): void {
		if (result.model !== this.options.model)
			throw new Error("Codex selected an unexpected model");
		const returnedCwd = resolve(result.cwd);
		if (returnedCwd !== resolve(this.options.runtimeCwd))
			throw new Error("Codex thread cwd mismatch");
		if (
			result.instructionSources.length !== 1 ||
			resolve(result.instructionSources[0] ?? "") !==
				resolve(expectedAgentsPath)
		)
			throw new Error("Codex instructionSources mismatch");
		if (result.approvalPolicy !== "never")
			throw new Error("Codex approval policy is not never");
		if (
			!isRecord(result.sandbox) ||
			result.sandbox.type !== "readOnly" ||
			result.sandbox.networkAccess !== false
		)
			throw new Error("Codex sandbox is not read-only/network-denied");
	}
}

export function createCodexBrainFromEnv(
	env: Record<string, string | undefined> = process.env,
	overrides: Partial<
		Omit<CodexSupervisorOptions, "codexHome" | "runtimeCwd">
	> = {},
): CodexAppServerBrain {
	const codexHome = env.CODEX_HOME;
	const runtimeCwd = env.CODEX_CWD;
	if (!codexHome || !isAbsolute(codexHome))
		throw new Error("CODEX_HOME must be an absolute path");
	if (!runtimeCwd || !isAbsolute(runtimeCwd))
		throw new Error("CODEX_CWD must be an absolute path");
	const requestTimeoutMs = positiveInt(env.CODEX_REQUEST_TIMEOUT_MS, 10_000);
	const supervisor = new CodexProcessSupervisor({
		codexBin: env.CODEX_BIN ?? "codex",
		codexHome,
		runtimeCwd,
		requestTimeoutMs,
		restartBaseDelayMs: positiveInt(env.CODEX_RESTART_BASE_MS, 250),
		restartMaxDelayMs: positiveInt(env.CODEX_RESTART_MAX_MS, 10_000),
		env,
		...overrides,
	});
	const toolMode = env.CODEX_TOOL_MODE ?? "dynamic";
	if (toolMode !== "dynamic" && toolMode !== "envelope")
		throw new Error("CODEX_TOOL_MODE must be dynamic or envelope");
	return new CodexAppServerBrain({
		model: env.CODEX_MODEL ?? "gpt-5.6-luna",
		effort: env.CODEX_EFFORT ?? "low",
		toolMode,
		runtimeCwd,
		turnTimeoutMs: positiveInt(env.TURN_TIMEOUT_MS, 30_000),
		supervisor,
	});
}

function parseEnvelope(text: string) {
	try {
		return BrainEnvelopeSchema.safeParse(JSON.parse(text)).data;
	} catch {
		return undefined;
	}
}

function safeError(
	input: Pick<BrainTurnInput, "turnId" | "generationId">,
	code: Extract<BrainDelta, { type: "error" }>["error"]["code"],
	retryable: boolean,
	message: string,
): Extract<BrainDelta, { type: "error" }> {
	return {
		type: "error",
		turnId: input.turnId,
		generationId: input.generationId,
		error: { code, retryable, message },
	};
}

function turnKey(threadId: string, externalTurnId: string): string {
	return `${threadId}\u0000${externalTurnId}`;
}

function positiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error("Codex timeout/restart values must be positive integers");
	return parsed;
}
