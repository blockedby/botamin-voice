#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	buildSanitizedCodexEnv,
	CodexAppServerBrain,
	CodexProcessSupervisor,
	PINNED_CODEX_CLI_VERSION,
} from "../apps/server/src/providers/codex";

const codexHome = process.env.CODEX_HOME;
const runtimeCwd = process.env.CODEX_CWD;
const codexBin = process.env.CODEX_BIN ?? "codex";
const model = process.env.CODEX_MODEL ?? "gpt-5.6-luna";
const effort = process.env.CODEX_EFFORT ?? "low";
if (!codexHome || !isAbsolute(codexHome))
	throw new Error("CODEX_HOME must be an absolute path");
if (!runtimeCwd || !isAbsolute(runtimeCwd))
	throw new Error("CODEX_CWD must be an absolute path");

const cliVersion = await commandOutput(
	[codexBin, "--version"],
	buildSanitizedCodexEnv(codexHome),
	runtimeCwd,
);
if (cliVersion.trim() !== PINNED_CODEX_CLI_VERSION)
	throw new Error(
		`Pinned Codex CLI mismatch: expected ${PINNED_CODEX_CLI_VERSION}, got ${cliVersion.trim()}`,
	);

const terminalStatuses: string[] = [];
let instructionSourcesVerified = false;
const supervisor = new CodexProcessSupervisor({
	codexBin,
	codexHome,
	runtimeCwd,
	requestTimeoutMs: 15_000,
	restartBaseDelayMs: 500,
	restartMaxDelayMs: 10_000,
	env: process.env,
});
let streamedDelta = false;
let interruptSent = false;
let interruptPromise: Promise<void> | undefined;
let brain!: CodexAppServerBrain;
brain = new CodexAppServerBrain({
	model,
	effort,
	toolMode: "envelope",
	runtimeCwd,
	turnTimeoutMs: 45_000,
	supervisor,
	onProtocolEvidence: (event) => {
		if (event.type === "thread_verified") instructionSourcesVerified = true;
		if (event.type === "provider_delta" && event.turnId && !interruptSent) {
			streamedDelta = true;
			interruptSent = true;
			interruptPromise = brain.interrupt(event.threadId, event.turnId);
		}
		if (event.type === "turn_terminal" && event.status)
			terminalStatuses.push(event.status);
	},
});

let exitCode = 1;
try {
	const health = await brain.health();
	if (health.status !== "healthy") {
		process.stdout.write(
			`${JSON.stringify({ ok: false, cliVersion: cliVersion.trim(), modelRequested: model, health })}\n`,
		);
		process.exitCode = 1;
	} else {
		const conversationId = "01890f3a-8b7c-7def-8123-456789abcdef";
		const turnId = "01890f3a-8b7c-7def-9234-56789abcdef0";
		const generationId = "01890f3a-8b7c-7def-a345-6789abcdef01";
		const threadId = await brain.createThread(conversationId);
		const promptBytes = await readFile(join(runtimeCwd, "AGENTS.md"));
		const promptVersion = createHash("sha256")
			.update(promptBytes)
			.digest("hex");
		let completion = false;
		const controller = new AbortController();
		for await (const delta of brain.runTurn(
			{
				conversationId,
				threadId,
				turnId,
				generationId,
				userText:
					"Ответь одной короткой фразой по-русски, что ты готов обсудить Botamin. Не используй инструменты.",
				stage: "GREETING",
				knownFacts: { useCases: [], painPoints: [], objections: [] },
				booking: null,
				allowedActions: [],
				promptVersion,
			},
			controller.signal,
		)) {
			if (delta.type === "turn.completed") completion = true;
			if (delta.type === "error") throw new Error(delta.error.code);
		}
		await interruptPromise;
		const interrupted = terminalStatuses.includes("interrupted");
		const ok =
			instructionSourcesVerified &&
			streamedDelta &&
			interruptSent &&
			completion &&
			interrupted;
		process.stdout.write(
			`${JSON.stringify({
				ok,
				cliVersion: cliVersion.trim(),
				modelRequested: model,
				health,
				instructionSourcesVerified,
				streamedDelta,
				interruptSent,
				terminalStatus: terminalStatuses.at(-1) ?? null,
				completion,
				promptVersion,
				securityProfile: {
					approvalPolicy: "never",
					sandbox: "read-only",
					network: false,
					shellTool: false,
					environmentAllowlisted: true,
				},
			})}\n`,
		);
		exitCode = ok ? 0 : 1;
		process.exitCode = exitCode;
	}
} finally {
	await brain.close();
}

async function commandOutput(
	command: string[],
	env: Record<string, string>,
	cwd: string,
): Promise<string> {
	const process = Bun.spawn(command, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0)
		throw new Error(
			`Codex command failed (${code}): ${stderr.trim() || command[0]}`,
		);
	return stdout;
}
