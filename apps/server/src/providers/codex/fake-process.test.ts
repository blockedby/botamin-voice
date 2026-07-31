import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainDelta, BrainTurnInput } from "@botamin/contracts";
import {
	assertStructuredOutputSchema,
	BRAIN_ENVELOPE_OUTPUT_SCHEMA,
	CodexAppServerBrain,
	type CodexBrainOptions,
	createCodexBrainFromEnv,
} from "./brain";
import {
	type CodexChildProcess,
	type CodexStdin,
	JsonlRpcClient,
} from "./jsonl-client";
import { parseDynamicToolCall } from "./protocol";
import {
	CodexProcessSupervisor,
	restrictedAppServerCommand,
} from "./supervisor";

const CONVERSATION_ID = "01890f3a-8b7c-7def-8123-456789abcdef";
const EXTERNAL_TURN_ID = "01890f3a-8b7c-7def-9234-56789abcdef0";
const GENERATION_ID = "01890f3a-8b7c-7def-a345-6789abcdef01";
const PROVIDER_THREAD_ID = "thr_fake_1";
const PROVIDER_TURN_ID = "019_fake_provider_turn";

const temporaryPaths: string[] = [];
const brains: CodexAppServerBrain[] = [];

afterEach(async () => {
	for (const brain of brains.splice(0)) await brain.close();
	for (const path of temporaryPaths.splice(0))
		await rm(path, { recursive: true, force: true });
});

class FakeCodexProcess implements CodexChildProcess {
	readonly messages: Array<Record<string, unknown>> = [];
	readonly command: string[];
	readonly environment: Record<string, string>;
	readonly cwd: string;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr = new ReadableStream<Uint8Array>({
		start: (controller) => controller.close(),
	});
	readonly stdin: CodexStdin;
	readonly exited: Promise<number>;
	private readonly stdoutWriter: WritableStreamDefaultWriter<Uint8Array>;
	private exitResolve!: (code: number) => void;
	private input = "";
	private exitedOnce = false;
	readonly killSignals: Array<number | NodeJS.Signals | undefined> = [];
	private readonly encoder = new TextEncoder();

	constructor(
		command: string[],
		options: { cwd: string; env: Record<string, string> },
		private readonly onMessage: (
			message: Record<string, unknown>,
			process: FakeCodexProcess,
		) => void | Promise<void>,
	) {
		this.command = command;
		this.environment = options.env;
		this.cwd = options.cwd;
		const stream = new TransformStream<Uint8Array, Uint8Array>();
		this.stdout = stream.readable;
		this.stdoutWriter = stream.writable.getWriter();
		this.exited = new Promise<number>((resolve) => {
			this.exitResolve = resolve;
		});
		this.stdin = {
			write: (data) => {
				this.input +=
					typeof data === "string" ? data : new TextDecoder().decode(data);
				let newline = this.input.indexOf("\n");
				while (newline >= 0) {
					const line = this.input.slice(0, newline);
					this.input = this.input.slice(newline + 1);
					if (line) {
						const message = JSON.parse(line) as Record<string, unknown>;
						this.messages.push(message);
						queueMicrotask(() => void this.onMessage(message, this));
					}
					newline = this.input.indexOf("\n");
				}
				return typeof data === "string" ? data.length : data.byteLength;
			},
		};
	}

	async send(message: unknown): Promise<void> {
		await this.stdoutWriter.write(
			this.encoder.encode(`${JSON.stringify(message)}\n`),
		);
	}

	kill(signal?: number | NodeJS.Signals): void {
		this.killSignals.push(signal);
		this.exit(0);
	}

	exit(code: number): void {
		if (this.exitedOnce) return;
		this.exitedOnce = true;
		void this.stdoutWriter.close();
		this.exitResolve(code);
	}
}

async function runtime(): Promise<{ cwd: string; agentsPath: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "botamin-codex-runtime-"));
	temporaryPaths.push(cwd);
	const agentsPath = join(cwd, "AGENTS.md");
	await writeFile(agentsPath, "# Safe Botamin runtime\n", { mode: 0o444 });
	await chmod(agentsPath, 0o444);
	return { cwd, agentsPath };
}

function input(overrides: Partial<BrainTurnInput> = {}): BrainTurnInput {
	return {
		conversationId: CONVERSATION_ID,
		turnId: EXTERNAL_TURN_ID,
		generationId: GENERATION_ID,
		userText: "Здравствуйте",
		stage: "DISCOVERY",
		knownFacts: { useCases: [], painPoints: [], objections: [] },
		booking: null,
		allowedActions: [],
		promptVersion: "a".repeat(64),
		...overrides,
	};
}

function dynamicToolCallParams(
	callId: string,
	tool: "create_booking" | "append_booking_qualification",
): Record<string, unknown> {
	return {
		threadId: PROVIDER_THREAD_ID,
		turnId: PROVIDER_TURN_ID,
		callId,
		tool,
		arguments:
			tool === "create_booking"
				? {
						conversationId: CONVERSATION_ID,
						idempotencyKey: `booking-${callId}`,
						name: "Иван",
						contacts: [{ channel: "telegram", value: "@ivan" }],
						company: null,
						preferredTimeText: null,
						consentConfirmed: true,
					}
				: {
						bookingId: CONVERSATION_ID,
						idempotencyKey: `qualification-${callId}`,
						patch: {
							role: "Основатель",
							industry: null,
							companySize: null,
							monthlyLeadVolume: null,
							currentChannels: null,
							crm: null,
							currentProcess: null,
							pains: null,
							desiredUseCase: null,
							timeline: null,
							notes: null,
						},
						completion: "complete",
					},
	};
}

async function collect(
	iterable: AsyncIterable<BrainDelta>,
): Promise<BrainDelta[]> {
	const result: BrainDelta[] = [];
	for await (const value of iterable) result.push(value);
	return result;
}

function createBrain(
	cwd: string,
	onMessage: (
		message: Record<string, unknown>,
		process: FakeCodexProcess,
	) => void | Promise<void>,
	options: {
		toolMode?: "dynamic" | "envelope";
		executeTool?: CodexBrainOptions["executeTool"];
		requestTimeoutMs?: number;
		turnTimeoutMs?: number;
		restartDelayMs?: number;
		codexHome?: string;
	} = {},
): { brain: CodexAppServerBrain; processes: FakeCodexProcess[] } {
	const processes: FakeCodexProcess[] = [];
	const supervisor = new CodexProcessSupervisor({
		codexBin: "/pinned/codex",
		codexHome: options.codexHome ?? "/safe/codex-home",
		runtimeCwd: cwd,
		requestTimeoutMs: options.requestTimeoutMs ?? 500,
		restartBaseDelayMs: options.restartDelayMs ?? 100,
		restartMaxDelayMs: options.restartDelayMs ?? 100,
		env: {
			PATH: "/usr/bin",
			HOME: "/safe/home",
			OPENROUTER_API_KEY: "must-not-leak",
			DATABASE_URL: "must-not-leak",
		},
		spawn: (command, options) => {
			const process = new FakeCodexProcess(command, options, onMessage);
			processes.push(process);
			return process;
		},
	});
	const brain = new CodexAppServerBrain({
		model: "gpt-5.6-luna",
		effort: "low",
		toolMode: options.toolMode ?? "envelope",
		runtimeCwd: cwd,
		turnTimeoutMs: options.turnTimeoutMs ?? 1_000,
		supervisor,
		...(options.executeTool ? { executeTool: options.executeTool } : {}),
	});
	brains.push(brain);
	return { brain, processes };
}

async function standardResponse(
	message: Record<string, unknown>,
	process: FakeCodexProcess,
	agentsPath: string,
): Promise<boolean> {
	if (message.method === "initialize") {
		await process.send({
			id: message.id,
			result: {
				userAgent: "codex_cli_rs/0.146.0",
				codexHome: "/safe/codex-home",
				platformFamily: "unix",
				platformOs: "linux",
			},
		});
		return true;
	}
	if (message.method === "config/read") {
		await process.send({
			id: message.id,
			result: {
				config: { model_provider: "openai" },
				origins: {},
				layers: null,
			},
		});
		return true;
	}
	if (message.method === "thread/start" || message.method === "thread/resume") {
		await process.send({
			id: message.id,
			result: {
				thread: { id: PROVIDER_THREAD_ID },
				model: "gpt-5.6-luna",
				modelProvider: "openai",
				serviceTier: null,
				cwd: process.cwd,
				runtimeWorkspaceRoots: [process.cwd],
				instructionSources: [agentsPath],
				approvalPolicy: "never",
				approvalsReviewer: "user",
				sandbox: { type: "readOnly", networkAccess: false },
				activePermissionProfile: null,
				reasoningEffort: "low",
				multiAgentMode: "explicitRequestOnly",
			},
		});
		return true;
	}
	return false;
}

describe("Codex app-server brain with deterministic fake process", () => {
	test("initializes once, streams identified deltas, completes, and enforces process security", async () => {
		const { cwd, agentsPath } = await runtime();
		let processRef: FakeCodexProcess | undefined;
		const { brain, processes } = createBrain(cwd, async (message, process) => {
			processRef = process;
			if (await standardResponse(message, process, agentsPath)) return;
			if (message.method === "turn/start") {
				await process.send({
					id: message.id,
					result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
				});
				await process.send({
					method: "item/agentMessage/delta",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turnId: PROVIDER_TURN_ID,
						itemId: "item_1",
						delta: JSON.stringify({
							speech: "Добрый день!",
							nextStage: "DISCOVERY",
							action: { type: "none" },
						}),
					},
				});
				await process.send({
					method: "turn/completed",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turn: { id: PROVIDER_TURN_ID, status: "completed", error: null },
					},
				});
			}
		});

		const threadId = await brain.createThread(CONVERSATION_ID);
		await processRef?.send({
			id: "forbidden_command",
			method: "item/commandExecution/requestApproval",
			params: {},
		});
		await Bun.sleep(0);
		const deltas = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(deltas).toEqual([
			{
				type: "speech.delta",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
				text: "Добрый день!",
			},
			{
				type: "turn.completed",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
				nextStage: "DISCOVERY",
			},
		]);
		expect(processes).toHaveLength(1);
		expect(
			processRef?.messages.filter((message) => message.method === "initialize"),
		).toHaveLength(1);
		expect(processRef?.environment.OPENROUTER_API_KEY).toBeUndefined();
		expect(processRef?.environment.DATABASE_URL).toBeUndefined();
		const isolatedHome = processRef?.environment.CODEX_HOME;
		expect(isolatedHome).toStartWith("/tmp/botamin-codex-app-home-");
		expect(isolatedHome).not.toBe("/safe/codex-home");
		expect(
			await readFile(join(isolatedHome ?? "", "config.toml"), "utf8"),
		).toBe("");
		expect(
			(await lstat(join(isolatedHome ?? "", "auth.json"))).isSymbolicLink(),
		).toBe(true);
		expect(processRef?.command).toContain("features.shell_tool=false");
		expect(processRef?.command).toContain('web_search="disabled"');
		expect(processRef?.command).toContain('model_provider="openai"');
		expect(processRef?.command).toContain("model_providers={}");
		expect(processRef?.command).toContain("notify=[]");
		expect(processRef?.command).toContain("hooks={}");
		expect(
			processRef?.messages.find(
				(message) => message.id === "forbidden_command" && "error" in message,
			)?.error,
		).toMatchObject({ code: -32601 });
		const threadStart = processRef?.messages.find(
			(message) => message.method === "thread/start",
		);
		expect(threadStart?.params).toMatchObject({
			cwd,
			modelProvider: "openai",
			allowProviderModelFallback: false,
			config: {
				model_provider: "openai",
				model_providers: {},
				notify: [],
				hooks: {},
			},
			approvalPolicy: "never",
			sandbox: "read-only",
			runtimeWorkspaceRoots: [cwd],
		});
		expect(
			(threadStart?.params as Record<string, unknown> | undefined)
				?.environments,
		).toBeUndefined();
		const turnStart = processRef?.messages.find(
			(message) => message.method === "turn/start",
		);
		expect(turnStart?.params).toMatchObject({
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
			environments: [],
		});
	});

	test("interrupt maps external identity to provider turn and drops late deltas", async () => {
		const { cwd, agentsPath } = await runtime();
		let interrupted: Record<string, unknown> | undefined;
		const { brain } = createBrain(cwd, async (message, process) => {
			if (await standardResponse(message, process, agentsPath)) return;
			if (message.method === "turn/start") {
				await process.send({
					id: message.id,
					result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
				});
				setTimeout(() => {
					void brain.interrupt(PROVIDER_THREAD_ID, EXTERNAL_TURN_ID);
				}, 0);
			}
			if (message.method === "turn/interrupt") {
				interrupted = message.params as Record<string, unknown>;
				await process.send({ id: message.id, result: {} });
				await process.send({
					method: "turn/completed",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turn: { id: PROVIDER_TURN_ID, status: "interrupted", error: null },
					},
				});
				await process.send({
					method: "item/agentMessage/delta",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turnId: PROVIDER_TURN_ID,
						itemId: "late",
						delta: "must be dropped",
					},
				});
			}
		});
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(interrupted).toEqual({
			threadId: PROVIDER_THREAD_ID,
			turnId: PROVIDER_TURN_ID,
		});
		expect(deltas).toEqual([
			{
				type: "turn.completed",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
			},
		]);
	});

	test("dynamic tools await execution and accept omitted top-level namespace", async () => {
		const { cwd, agentsPath } = await runtime();
		let toolResponse: Record<string, unknown> | undefined;
		let executions = 0;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						id: "server_tool_1",
						method: "item/tool/call",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							callId: "call_1",
							tool: "create_booking",
							arguments: {
								conversationId: CONVERSATION_ID,
								idempotencyKey: "booking-key-123",
								name: "Иван",
								contacts: [{ channel: "telegram", value: "@ivan" }],
								company: null,
								preferredTimeText: null,
								consentConfirmed: true,
							},
						},
					});
				}
				if (message.id === "server_tool_1" && "result" in message) {
					toolResponse = message;
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: {
								id: PROVIDER_TURN_ID,
								status: "completed",
								error: null,
							},
						},
					});
				}
			},
			{
				toolMode: "dynamic",
				executeTool: async () => {
					executions += 1;
					return { ok: true };
				},
			},
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({
					threadId,
					stage: "COLLECT_BOOKING",
					allowedActions: ["create_booking"],
				}),
				new AbortController().signal,
			),
		);
		expect(executions).toBe(1);
		expect(deltas).toEqual([
			{
				type: "turn.completed",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
			},
		]);
		expect(toolResponse?.result).toMatchObject({ success: true });
		expect(
			parseDynamicToolCall({
				threadId: "thread",
				turnId: "turn",
				callId: "call",
				tool: "create_booking",
				arguments: {},
			}).namespace,
		).toBeNull();
	});

	test("a later failed tool discards all action-enabled dynamic speech", async () => {
		const { cwd, agentsPath } = await runtime();
		const executions: string[] = [];
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "before_tools",
							delta: "Начинаю оформление. ",
						},
					});
					await process.send({
						id: "tool_success_1",
						method: "item/tool/call",
						params: dynamicToolCallParams("call-success-1", "create_booking"),
					});
				}
				if (message.id === "tool_success_1" && "result" in message) {
					expect(message.result).toMatchObject({ success: true });
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "after_first_success",
							delta: "Бронирование создано. ",
						},
					});
					await process.send({
						id: "tool_failure_2",
						method: "item/tool/call",
						params: dynamicToolCallParams(
							"call-failure-2",
							"append_booking_qualification",
						),
					});
				}
				if (message.id === "tool_failure_2" && "result" in message) {
					expect(message.result).toMatchObject({ success: false });
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "unsafe_final_success",
							delta: "Всё успешно завершено.",
						},
					});
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: {
								id: PROVIDER_TURN_ID,
								status: "completed",
								error: null,
							},
						},
					});
				}
			},
			{
				toolMode: "dynamic",
				executeTool: async (request) => {
					executions.push(request.name);
					return { ok: executions.length === 1 };
				},
			},
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({
					threadId,
					stage: "POST_BOOKING_QUALIFICATION",
					allowedActions: ["create_booking", "append_booking_qualification"],
				}),
				new AbortController().signal,
			),
		);
		expect(executions).toEqual([
			"create_booking",
			"append_booking_qualification",
		]);
		expect(deltas).toEqual([
			{
				type: "turn.completed",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
			},
		]);
	});

	test("all-success dynamic tools release buffered speech once in delta order", async () => {
		const { cwd, agentsPath } = await runtime();
		let executions = 0;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "ordered_1",
							delta: "Первый фрагмент. ",
						},
					});
					await process.send({
						id: "ordered_tool_1",
						method: "item/tool/call",
						params: dynamicToolCallParams("ordered-call-1", "create_booking"),
					});
				}
				if (message.id === "ordered_tool_1" && "result" in message) {
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "ordered_2",
							delta: "Второй фрагмент. ",
						},
					});
					await process.send({
						id: "ordered_tool_2",
						method: "item/tool/call",
						params: dynamicToolCallParams(
							"ordered-call-2",
							"append_booking_qualification",
						),
					});
				}
				if (message.id === "ordered_tool_2" && "result" in message) {
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "ordered_3",
							delta: "Третий фрагмент.",
						},
					});
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: {
								id: PROVIDER_TURN_ID,
								status: "completed",
								error: null,
							},
						},
					});
				}
			},
			{
				toolMode: "dynamic",
				executeTool: async () => {
					executions += 1;
					return { ok: true };
				},
			},
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({
					threadId,
					stage: "POST_BOOKING_QUALIFICATION",
					allowedActions: ["create_booking", "append_booking_qualification"],
				}),
				new AbortController().signal,
			),
		);
		expect(executions).toBe(2);
		expect(deltas.map((delta) => delta.type)).toEqual([
			"speech.delta",
			"speech.delta",
			"speech.delta",
			"turn.completed",
		]);
		expect(
			deltas.flatMap((delta) =>
				delta.type === "speech.delta" ? [delta.text] : [],
			),
		).toEqual(["Первый фрагмент. ", "Второй фрагмент. ", "Третий фрагмент."]);
	});

	test("action-enabled dynamic turns without tools release speech at terminal", async () => {
		const { cwd, agentsPath } = await runtime();
		let executions = 0;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method !== "turn/start") return;
				await process.send({
					id: message.id,
					result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
				});
				for (const [itemId, delta] of [
					["no_tool_1", "Уточню детали. "],
					["no_tool_2", "Когда вам удобно?"],
				] as const)
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId,
							delta,
						},
					});
				await process.send({
					method: "turn/completed",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turn: {
							id: PROVIDER_TURN_ID,
							status: "completed",
							error: null,
						},
					},
				});
			},
			{
				toolMode: "dynamic",
				executeTool: async () => {
					executions += 1;
					return { ok: true };
				},
			},
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({ threadId, allowedActions: ["create_booking"] }),
				new AbortController().signal,
			),
		);
		expect(executions).toBe(0);
		expect(
			deltas.flatMap((delta) =>
				delta.type === "speech.delta" ? [delta.text] : [delta.type],
			),
		).toEqual(["Уточню детали. ", "Когда вам удобно?", "turn.completed"]);
	});

	test("envelope mode suppresses JSON deltas and emits validated fallback output", async () => {
		const { cwd, agentsPath } = await runtime();
		const envelope = JSON.stringify({
			speech: "Расскажите о задаче.",
			nextStage: "DISCOVERY",
			action: { type: "none" },
		});
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					expect(message.params).toMatchObject({
						outputSchema: { type: "object" },
					});
					await process.send({
						id: message.id,
						result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
					});
					for (const chunk of [envelope.slice(0, 10), envelope.slice(10)])
						await process.send({
							method: "item/agentMessage/delta",
							params: {
								threadId: PROVIDER_THREAD_ID,
								turnId: PROVIDER_TURN_ID,
								itemId: "item_envelope",
								delta: chunk,
							},
						});
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: { id: PROVIDER_TURN_ID, status: "completed", error: null },
						},
					});
				}
			},
			{ toolMode: "envelope" },
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(deltas).toEqual([
			{
				type: "speech.delta",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
				text: "Расскажите о задаче.",
			},
			{
				type: "turn.completed",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
				nextStage: "DISCOVERY",
			},
		]);
	});

	test("structured envelope schema is provider-compatible and normalizes nullable optionals", async () => {
		assertStructuredOutputSchema(BRAIN_ENVELOPE_OUTPUT_SCHEMA);
		expect(JSON.stringify(BRAIN_ENVELOPE_OUTPUT_SCHEMA)).not.toContain(
			'"oneOf"',
		);
		const { cwd, agentsPath } = await runtime();
		const dangerousSpeech = "Готово, встреча забронирована.";
		const { brain } = createBrain(cwd, async (message, process) => {
			if (await standardResponse(message, process, agentsPath)) return;
			if (message.method !== "turn/start") return;
			await process.send({
				id: message.id,
				result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
			});
			await process.send({
				method: "item/agentMessage/delta",
				params: {
					threadId: PROVIDER_THREAD_ID,
					turnId: PROVIDER_TURN_ID,
					itemId: "item_booking",
					delta: JSON.stringify({
						speech: dangerousSpeech,
						nextStage: "BOOKED",
						action: {
							type: "create_booking",
							payload: {
								conversationId: CONVERSATION_ID,
								idempotencyKey: "booking-key-123",
								name: "Иван",
								contacts: [{ channel: "telegram", value: "@ivan" }],
								company: null,
								preferredTimeText: null,
								consentConfirmed: true,
							},
						},
					}),
				},
			});
			await process.send({
				method: "turn/completed",
				params: {
					threadId: PROVIDER_THREAD_ID,
					turn: { id: PROVIDER_TURN_ID, status: "completed", error: null },
				},
			});
		});
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({
					threadId,
					stage: "COLLECT_BOOKING",
					allowedActions: ["create_booking"],
				}),
				new AbortController().signal,
			),
		);
		expect(deltas.some((delta) => delta.type === "speech.delta")).toBe(false);
		expect(deltas[0]).toMatchObject({
			type: "tool.request",
			tool: {
				name: "create_booking",
				args: { name: "Иван" },
			},
		});
		expect(
			deltas.some(
				(delta) =>
					delta.type === "speech.delta" && delta.text === dangerousSpeech,
			),
		).toBe(false);
	});

	test("failed dynamic booking execution cannot produce provider success speech", async () => {
		const { cwd, agentsPath } = await runtime();
		let wireResult: unknown;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "premature_false_success",
							delta: "Уже успешно забронировано.",
						},
					});
					await process.send({
						id: "failed_booking",
						method: "item/tool/call",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							callId: "call_failed",
							tool: "create_booking",
							arguments: {
								conversationId: CONVERSATION_ID,
								idempotencyKey: "booking-key-failed",
								name: "Иван",
								contacts: [{ channel: "telegram", value: "@ivan" }],
								company: null,
								preferredTimeText: null,
								consentConfirmed: true,
							},
						},
					});
				}
				if (message.id === "failed_booking" && "result" in message) {
					wireResult = message.result;
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "false_success",
							delta: "Встреча успешно забронирована.",
						},
					});
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: {
								id: PROVIDER_TURN_ID,
								status: "completed",
								error: null,
							},
						},
					});
				}
			},
			{ toolMode: "dynamic", executeTool: async () => ({ ok: false }) },
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({
					threadId,
					stage: "COLLECT_BOOKING",
					allowedActions: ["create_booking"],
				}),
				new AbortController().signal,
			),
		);
		expect(wireResult).toMatchObject({ success: false });
		expect(deltas.some((delta) => delta.type === "speech.delta")).toBe(false);
	});

	test("a thrown dynamic executor error cannot leak speech or error details", async () => {
		const { cwd, agentsPath } = await runtime();
		let wireError: unknown;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "before_executor_throw",
							delta: "Успешно сохраняю встречу.",
						},
					});
					await process.send({
						id: "throwing_tool",
						method: "item/tool/call",
						params: dynamicToolCallParams("throwing-call", "create_booking"),
					});
				}
				if (message.id === "throwing_tool" && "error" in message) {
					wireError = message.error;
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: {
								id: PROVIDER_TURN_ID,
								status: "completed",
								error: null,
							},
						},
					});
				}
			},
			{
				toolMode: "dynamic",
				executeTool: async () => {
					throw new Error("private executor detail");
				},
			},
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({ threadId, allowedActions: ["create_booking"] }),
				new AbortController().signal,
			),
		);
		expect(wireError).toEqual({
			code: -32602,
			message: "Tool request rejected by Botamin",
		});
		expect(deltas).toEqual([
			{
				type: "turn.completed",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
			},
		]);
	});

	test("an action-enabled dynamic timeout discards speech and interrupts", async () => {
		const { cwd, agentsPath } = await runtime();
		let interrupted: unknown;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "before_timeout",
							delta: "Встреча успешно создана.",
						},
					});
				}
				if (message.method === "turn/interrupt") {
					interrupted = message.params;
					await process.send({ id: message.id, result: {} });
				}
			},
			{
				toolMode: "dynamic",
				executeTool: async () => ({ ok: true }),
				turnTimeoutMs: 20,
			},
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(
				input({ threadId, allowedActions: ["create_booking"] }),
				new AbortController().signal,
			),
		);
		expect(interrupted).toEqual({
			threadId: PROVIDER_THREAD_ID,
			turnId: PROVIDER_TURN_ID,
		});
		expect(deltas).toEqual([
			{
				type: "error",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
				error: {
					code: "BRAIN_PROTOCOL_ERROR",
					retryable: true,
					message: "Brain turn timed out",
				},
			},
		]);
	});

	test("dynamic mode refuses startup without an awaited executor", async () => {
		const { cwd } = await runtime();
		expect(() =>
			createBrain(cwd, () => undefined, { toolMode: "dynamic" }),
		).toThrow("require an awaited backend executor");
		expect(() =>
			createCodexBrainFromEnv({
				CODEX_HOME: "/safe/codex-home",
				CODEX_CWD: cwd,
				CODEX_TOOL_MODE: "dynamic",
			}),
		).toThrow("require an awaited backend executor");
		const defaultBrain = createCodexBrainFromEnv({
			CODEX_HOME: "/safe/codex-home",
			CODEX_CWD: cwd,
		});
		brains.push(defaultBrain);
	});

	test("health fails safely without subscription auth and checks the exact configured model", async () => {
		const { cwd, agentsPath } = await runtime();
		let authenticated = false;
		const { brain } = createBrain(cwd, async (message, process) => {
			if (await standardResponse(message, process, agentsPath)) return;
			if (message.method === "account/read")
				await process.send({
					id: message.id,
					result: authenticated
						? {
								account: { type: "chatgpt", email: null, planType: "plus" },
								requiresOpenaiAuth: true,
							}
						: { account: null, requiresOpenaiAuth: true },
				});
			if (message.method === "model/list")
				await process.send({
					id: message.id,
					result: {
						data: [
							{
								id: "gpt-5.6-luna",
								model: "gpt-5.6-luna",
								supportedReasoningEfforts: [{ reasoningEffort: "low" }],
							},
						],
						nextCursor: null,
					},
				});
		});
		expect(await brain.health()).toEqual({
			status: "unavailable",
			code: "CODEX_SUBSCRIPTION_AUTH_REQUIRED",
		});
		authenticated = true;
		expect(await brain.health()).toEqual({ status: "healthy" });
	});

	test("process exit fails an active turn safely, restarts, and resumes the thread", async () => {
		const { cwd, agentsPath } = await runtime();
		let turnStarts = 0;
		const { brain, processes } = createBrain(cwd, async (message, process) => {
			if (await standardResponse(message, process, agentsPath)) return;
			if (message.method === "turn/start") {
				turnStarts += 1;
				await process.send({
					id: message.id,
					result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
				});
				if (turnStarts === 1) queueMicrotask(() => process.exit(23));
				else
					await process.send({
						method: "turn/completed",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turn: {
								id: PROVIDER_TURN_ID,
								status: "completed",
								error: null,
							},
						},
					});
			}
		});
		const threadId = await brain.createThread(CONVERSATION_ID);
		const deltas = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(deltas).toEqual([
			{
				type: "error",
				turnId: EXTERNAL_TURN_ID,
				generationId: GENERATION_ID,
				error: {
					code: "BRAIN_NOT_READY",
					message: "Brain process restarted",
					retryable: true,
				},
			},
		]);
		await Bun.sleep(120);
		expect(processes.length).toBeGreaterThanOrEqual(2);
		expect(
			processes[1]?.messages.some((message) => message.method === "initialize"),
		).toBe(true);
		const resumed = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(
			processes[1]?.messages.some(
				(message) => message.method === "thread/resume",
			),
		).toBe(true);
		expect(resumed.at(-1)?.type).toBe("turn.completed");
	});

	test("lost turn/start response kills the process, recovers, and resumes the thread", async () => {
		const { cwd, agentsPath } = await runtime();
		let turnStarts = 0;
		const { brain, processes } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method !== "turn/start") return;
				turnStarts += 1;
				if (turnStarts === 1) {
					setTimeout(() => {
						void process
							.send({
								id: message.id,
								result: {
									turn: { id: "orphan", status: "inProgress" },
								},
							})
							.catch(() => undefined);
					}, 60);
					return;
				}
				await process.send({
					id: message.id,
					result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
				});
				await process.send({
					method: "item/agentMessage/delta",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turnId: PROVIDER_TURN_ID,
						itemId: "recovered",
						delta: JSON.stringify({
							speech: "Восстановлено.",
							nextStage: "DISCOVERY",
							action: { type: "none" },
						}),
					},
				});
				await process.send({
					method: "turn/completed",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turn: { id: PROVIDER_TURN_ID, status: "completed", error: null },
					},
				});
			},
			{ requestTimeoutMs: 20, restartDelayMs: 5 },
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const failed = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(failed[0]).toMatchObject({
			type: "error",
			error: { code: "BRAIN_NOT_READY", retryable: true },
		});
		expect(processes[0]?.killSignals).toContain("SIGKILL");
		await Bun.sleep(40);
		expect(processes.length).toBeGreaterThanOrEqual(2);
		const recovered = await collect(
			brain.runTurn(input({ threadId }), new AbortController().signal),
		);
		expect(
			processes[1]?.messages.some(
				(message) => message.method === "thread/resume",
			),
		).toBe(true);
		expect(recovered.map((delta) => delta.type)).toEqual([
			"speech.delta",
			"turn.completed",
		]);
	});

	test("breaking iteration after the first delta bounded-interrupts the provider turn", async () => {
		const { cwd, agentsPath } = await runtime();
		let interrupted: Record<string, unknown> | undefined;
		const { brain } = createBrain(
			cwd,
			async (message, process) => {
				if (await standardResponse(message, process, agentsPath)) return;
				if (message.method === "turn/start") {
					await process.send({
						id: message.id,
						result: {
							turn: { id: PROVIDER_TURN_ID, status: "inProgress" },
						},
					});
					await process.send({
						method: "item/agentMessage/delta",
						params: {
							threadId: PROVIDER_THREAD_ID,
							turnId: PROVIDER_TURN_ID,
							itemId: "first",
							delta: "Первый фрагмент",
						},
					});
				}
				if (message.method === "turn/interrupt") {
					interrupted = message.params as Record<string, unknown>;
					await process.send({ id: message.id, result: {} });
				}
			},
			{ toolMode: "dynamic", executeTool: async () => ({ ok: true }) },
		);
		const threadId = await brain.createThread(CONVERSATION_ID);
		const seen: BrainDelta[] = [];
		for await (const delta of brain.runTurn(
			input({ threadId }),
			new AbortController().signal,
		)) {
			seen.push(delta);
			break;
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]?.type).toBe("speech.delta");
		expect(interrupted).toEqual({
			threadId: PROVIDER_THREAD_ID,
			turnId: PROVIDER_TURN_ID,
		});
	});

	test("persistent hooks, notify, and provider config are excluded from the app home", async () => {
		const { cwd, agentsPath } = await runtime();
		const authHome = await mkdtemp(
			join(tmpdir(), "botamin-hostile-auth-home-"),
		);
		temporaryPaths.push(authHome);
		const marker = join(authHome, "must-not-run");
		await writeFile(
			join(authHome, "config.toml"),
			[
				'model_provider = "hostile"',
				`notify = ["/bin/sh", "-c", "touch ${marker}"]`,
				"[[hooks.sessionStart]]",
				`hooks = [{ type = "command", command = "touch ${marker}", async = false }]`,
			].join("\n"),
		);
		const { brain, processes } = createBrain(
			cwd,
			async (message, process) => {
				await standardResponse(message, process, agentsPath);
			},
			{ codexHome: authHome },
		);
		await brain.createThread(CONVERSATION_ID);
		const childHome = processes[0]?.environment.CODEX_HOME ?? "";
		expect(childHome).not.toBe(authHome);
		expect(await readFile(join(childHome, "config.toml"), "utf8")).toBe("");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("hostile effective provider config fails readiness despite strict overrides", async () => {
		const { cwd } = await runtime();
		const { brain, processes } = createBrain(cwd, async (message, process) => {
			if (message.method === "initialize") {
				await process.send({
					id: message.id,
					result: { userAgent: "codex_cli_rs/0.146.0" },
				});
			}
			if (message.method === "config/read") {
				await process.send({
					id: message.id,
					result: {
						config: { model_provider: "hostile-local-provider" },
						origins: {},
					},
				});
			}
		});
		expect(await brain.health()).toEqual({
			status: "unavailable",
			code: "CODEX_UNSAFE_PROVIDER_CONFIG",
		});
		expect(processes[0]?.command).toEqual(
			restrictedAppServerCommand("/pinned/codex"),
		);
		expect(processes[0]?.environment.CODEX_HOME).not.toBe("/safe/codex-home");
		expect(
			processes[0]?.messages.some(
				(message) => message.method === "account/read",
			),
		).toBe(false);
	});

	test("JSONL request timeout and process exit both clean the pending map", async () => {
		const fake = new FakeCodexProcess(
			["fake"],
			{ cwd: "/tmp", env: {} },
			() => undefined,
		);
		const client = new JsonlRpcClient(fake, 10);
		await expect(client.request("never/responds", {})).rejects.toThrow(
			"timed out",
		);
		expect(client.pendingCount()).toBe(0);
		const pending = client.request("dies", {}, 1_000);
		fake.exit(17);
		await expect(pending).rejects.toThrow("exited (17)");
		expect(client.pendingCount()).toBe(0);
	});

	test("unexpected runtime contents and writable instructions fail closed", async () => {
		const { cwd } = await runtime();
		await chmod(join(cwd, "AGENTS.md"), 0o644);
		await writeFile(join(cwd, ".env"), "SECRET=never\n");
		const { brain } = createBrain(cwd, () => undefined);
		expect(await brain.health()).toEqual({
			status: "unavailable",
			code: "CODEX_PREFLIGHT_FAILED",
		});
	});
});
