import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainDelta, BrainTurnInput } from "@botamin/contracts";
import { CodexAppServerBrain } from "./brain";
import {
	type CodexChildProcess,
	type CodexStdin,
	JsonlRpcClient,
} from "./jsonl-client";
import { CodexProcessSupervisor } from "./supervisor";

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

	kill(): void {
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
	toolMode: "dynamic" | "envelope" = "dynamic",
): { brain: CodexAppServerBrain; processes: FakeCodexProcess[] } {
	const processes: FakeCodexProcess[] = [];
	const supervisor = new CodexProcessSupervisor({
		codexBin: "/pinned/codex",
		codexHome: "/safe/codex-home",
		runtimeCwd: cwd,
		requestTimeoutMs: 500,
		restartBaseDelayMs: 100,
		restartMaxDelayMs: 100,
		env: {
			PATH: "/usr/bin",
			HOME: "/safe/home",
			XAI_API_KEY: "must-not-leak",
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
		toolMode,
		runtimeCwd: cwd,
		turnTimeoutMs: 1_000,
		supervisor,
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
						delta: "Добрый день!",
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
			},
		]);
		expect(processes).toHaveLength(1);
		expect(
			processRef?.messages.filter((message) => message.method === "initialize"),
		).toHaveLength(1);
		expect(processRef?.environment.XAI_API_KEY).toBeUndefined();
		expect(processRef?.environment.DATABASE_URL).toBeUndefined();
		expect(processRef?.environment.CODEX_HOME).toBe("/safe/codex-home");
		expect(processRef?.command).toContain("features.shell_tool=false");
		expect(processRef?.command).toContain('web_search="disabled"');
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

	test("dynamic tools are flag-gated, shared-contract validated, and policy checked", async () => {
		const { cwd, agentsPath } = await runtime();
		let toolResponse: Record<string, unknown> | undefined;
		const { brain } = createBrain(cwd, async (message, process) => {
			if (await standardResponse(message, process, agentsPath)) return;
			if (message.method === "turn/start") {
				await process.send({
					id: message.id,
					result: { turn: { id: PROVIDER_TURN_ID, status: "inProgress" } },
				});
				await process.send({
					id: "server_tool_1",
					method: "item/tool/call",
					params: {
						threadId: PROVIDER_THREAD_ID,
						turnId: PROVIDER_TURN_ID,
						callId: "call_1",
						namespace: null,
						tool: "create_booking",
						arguments: {
							conversationId: CONVERSATION_ID,
							idempotencyKey: "booking-key-123",
							name: "Иван",
							contacts: [{ channel: "telegram", value: "@ivan" }],
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
						turn: { id: PROVIDER_TURN_ID, status: "completed", error: null },
					},
				});
			}
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
		expect(deltas[0]).toMatchObject({
			type: "tool.request",
			turnId: EXTERNAL_TURN_ID,
			generationId: GENERATION_ID,
			tool: { name: "create_booking", callId: "call_1" },
		});
		expect(toolResponse?.result).toMatchObject({ success: true });
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
			"envelope",
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
			},
		]);
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
