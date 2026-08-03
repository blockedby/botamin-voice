#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	buildDialogueExport,
	type DialogueExportEnvelope,
	DialogueExportError,
	type DialogueExportErrorCode,
	databasePathFromUrl,
	type ExportSelection,
	MAX_EXPORT_BYTES,
	parseExportArgs,
} from "./dialogue-export-reader";

const DEFAULT_OUTPUT_DIRECTORY = ".runtime/dialogues";
const COMPOSE_DATABASE_PATH = "/data/app.db";
const COMPOSE_CHILD_TIMEOUT_MS = 30_000;
const COMPOSE_TERMINATE_GRACE_MS = 500;
const COMPOSE_TERMINATE_WAIT_MS = 2_000;
const MAX_IPC_BYTES = MAX_EXPORT_BYTES * 2 + 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DIRECT_DATABASE_ENV = "BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL";
const USAGE = `Usage:
  bun run dialogues:export [--source compose] [--conversation <ULID-or-UUIDv7> | --limit <1..100> | --all]
  bun run dialogues:export --source direct (--database <absolute-sqlite-path> | ${DIRECT_DATABASE_ENV}=file:/absolute/path)`;

type Environment = Record<string, string | undefined>;

export type DialogueExportRequest =
	| { source: "compose"; selection: ExportSelection }
	| { source: "direct"; databasePath: string; selection: ExportSelection };

export type ComposeReadOptions = {
	timeoutMs?: number;
	terminateGraceMs?: number;
	terminateWaitMs?: number;
	environment?: Environment;
	cwd?: string;
};

export type ProtectedWriteOptions = {
	now?: Date;
	randomSuffix?: () => string;
	beforeRename?: () => void | Promise<void>;
};

function safeSuffix(): string {
	return randomBytes(8).toString("hex");
}

function filenameTimestamp(now: Date): string {
	if (Number.isNaN(now.getTime())) {
		throw new DialogueExportError("INVALID_DATA");
	}
	return now.toISOString().replace(/[-:.]/gu, "");
}

/** Writes a complete mode-0600 file and exposes it only through an atomic rename. */
export async function writeProtectedDialogueFile(
	outputDirectory: string,
	markdown: string,
	options: ProtectedWriteOptions = {},
): Promise<string> {
	const directory = resolve(outputDirectory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const suffix = (options.randomSuffix ?? safeSuffix)();
	if (!/^[0-9a-f]{12,64}$/u.test(suffix)) {
		throw new DialogueExportError("INVALID_DATA");
	}
	const filename = `dialogue-${filenameTimestamp(options.now ?? new Date())}-${suffix}.md`;
	const target = join(directory, filename);
	const temporary = join(directory, `.${filename}.${safeSuffix()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(markdown, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await chmod(temporary, 0o600);
		await options.beforeRename?.();
		await rename(temporary, target);
		return target;
	} catch (error) {
		if (handle !== undefined) {
			try {
				await handle.close();
			} catch {
				// Cleanup below is still attempted.
			}
		}
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

function invalidArguments(): never {
	throw new DialogueExportError("INVALID_ARGUMENTS");
}

export function parseDialogueExportArgs(
	argv: readonly string[],
	environment: Environment = process.env,
): DialogueExportRequest {
	let source: "compose" | "direct" | undefined;
	let databaseArgument: string | undefined;
	const selectorArguments: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index] ?? invalidArguments();
		if (argument === "--source") {
			if (source !== undefined) invalidArguments();
			const value = argv[index + 1];
			if (value === "compose") source = "compose";
			else if (value === "direct") source = "direct";
			else invalidArguments();
			index += 1;
			continue;
		}
		if (argument === "--database") {
			if (databaseArgument !== undefined) invalidArguments();
			const value = argv[index + 1] ?? invalidArguments();
			if (!isAbsolute(value)) invalidArguments();
			databaseArgument = value;
			index += 1;
			continue;
		}
		selectorArguments.push(argument);
	}

	const selection = parseExportArgs(selectorArguments);
	if ((source ?? "compose") === "compose") {
		if (databaseArgument !== undefined) invalidArguments();
		return { source: "compose", selection };
	}

	const configuredDatabase = environment[DIRECT_DATABASE_ENV];
	const hasConfiguredDatabase =
		configuredDatabase !== undefined && configuredDatabase !== "";
	if (databaseArgument !== undefined && hasConfiguredDatabase)
		invalidArguments();
	if (databaseArgument !== undefined) {
		return { source: "direct", databasePath: databaseArgument, selection };
	}
	if (!hasConfiguredDatabase) invalidArguments();
	return {
		source: "direct",
		databasePath: databasePathFromUrl(configuredDatabase),
		selection,
	};
}

function selectionArguments(selection: ExportSelection): string[] {
	switch (selection.kind) {
		case "latest":
			return [];
		case "conversation":
			return ["--conversation", selection.conversationId];
		case "limit":
			return ["--limit", String(selection.limit)];
		case "all":
			return ["--all"];
	}
}

async function collectBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number,
	overflowCode: DialogueExportErrorCode,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		bytes += result.value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel().catch(() => undefined);
			throw new DialogueExportError(overflowCode);
		}
		chunks.push(result.value);
	}
	const output = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function validateEnvelope(value: unknown): DialogueExportEnvelope {
	if (typeof value !== "object" || value === null) {
		throw new DialogueExportError("INVALID_DATA");
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.formatVersion !== 1 ||
		!Number.isInteger(candidate.conversationCount) ||
		(candidate.conversationCount as number) < 1 ||
		(candidate.conversationCount as number) > 100 ||
		!Number.isInteger(candidate.turnCount) ||
		(candidate.turnCount as number) < 0 ||
		typeof candidate.markdown !== "string" ||
		Buffer.byteLength(candidate.markdown, "utf8") > MAX_EXPORT_BYTES
	) {
		throw new DialogueExportError("INVALID_DATA");
	}
	return candidate as DialogueExportEnvelope;
}

function childErrorCode(status: number): DialogueExportErrorCode {
	switch (status) {
		case 66:
			return "NO_CONVERSATION";
		case 69:
			return "DATABASE_UNAVAILABLE";
		case 75:
			return "EXPORT_TOO_LARGE";
		default:
			return "DATABASE_UNAVAILABLE";
	}
}

function processGroupExists(pid: number): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalChildGroup(
	child: ReturnType<typeof Bun.spawn>,
	signal: NodeJS.Signals,
): void {
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process or process group has already exited.
		}
	}
}

async function waitForGroupExit(pid: number, maximumMs: number): Promise<void> {
	const deadline = Date.now() + maximumMs;
	while (processGroupExists(pid) && Date.now() < deadline) {
		await Bun.sleep(10);
	}
}

async function terminateChildGroup(
	child: ReturnType<typeof Bun.spawn>,
	graceMs: number,
	waitMs: number,
): Promise<void> {
	signalChildGroup(child, "SIGTERM");
	if (process.platform === "win32") await Bun.sleep(graceMs);
	else await waitForGroupExit(child.pid, graceMs);
	if (
		(process.platform === "win32" && child.exitCode === null) ||
		processGroupExists(child.pid)
	) {
		signalChildGroup(child, "SIGKILL");
	}
	await Promise.race([
		child.exited.catch(() => -1),
		Bun.sleep(waitMs).then(() => -1),
	]);
	if (process.platform !== "win32") {
		await waitForGroupExit(child.pid, waitMs);
	}
}

export async function readFromCompose(
	selection: ExportSelection,
	options: ComposeReadOptions = {},
): Promise<DialogueExportEnvelope> {
	const timeoutMs = options.timeoutMs ?? COMPOSE_CHILD_TIMEOUT_MS;
	const terminateGraceMs =
		options.terminateGraceMs ?? COMPOSE_TERMINATE_GRACE_MS;
	const terminateWaitMs = options.terminateWaitMs ?? COMPOSE_TERMINATE_WAIT_MS;
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(
			[
				"docker",
				"compose",
				"exec",
				"-T",
				"app",
				"bun",
				"/app/scripts/dialogue-export-reader.ts",
				"--database",
				COMPOSE_DATABASE_PATH,
				...selectionArguments(selection),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: options.environment ?? process.env,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				detached: true,
			},
		);
	} catch {
		throw new DialogueExportError("DATABASE_UNAVAILABLE");
	}

	if (
		!(child.stdout instanceof ReadableStream) ||
		!(child.stderr instanceof ReadableStream)
	) {
		await terminateChildGroup(child, terminateGraceMs, terminateWaitMs);
		throw new DialogueExportError("DATABASE_UNAVAILABLE");
	}

	const stdoutPromise = collectBounded(
		child.stdout,
		MAX_IPC_BYTES,
		"EXPORT_TOO_LARGE",
	);
	const stderrPromise = collectBounded(
		child.stderr,
		MAX_STDERR_BYTES,
		"DATABASE_UNAVAILABLE",
	);
	const streamsAndExit = Promise.all([
		stdoutPromise,
		stderrPromise,
		child.exited,
	]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new DialogueExportError("DATABASE_UNAVAILABLE")),
			timeoutMs,
		);
	});

	try {
		const [stdout, , status] = await Promise.race([streamsAndExit, deadline]);
		if (timer !== undefined) clearTimeout(timer);
		if (status !== 0) {
			throw new DialogueExportError(childErrorCode(status));
		}
		let decoded: unknown;
		try {
			decoded = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(stdout),
			);
		} catch {
			throw new DialogueExportError("INVALID_DATA");
		}
		return validateEnvelope(decoded);
	} catch (error) {
		if (timer !== undefined) clearTimeout(timer);
		await terminateChildGroup(child, terminateGraceMs, terminateWaitMs);
		await Promise.race([
			Promise.allSettled([stdoutPromise, stderrPromise]),
			Bun.sleep(terminateWaitMs),
		]);
		throw error instanceof DialogueExportError
			? error
			: new DialogueExportError("DATABASE_UNAVAILABLE");
	}
}

export async function collectDialogueExport(
	request: DialogueExportRequest,
	composeOptions: ComposeReadOptions = {},
): Promise<DialogueExportEnvelope> {
	if (request.source === "direct") {
		return buildDialogueExport(request.databasePath, request.selection);
	}
	return readFromCompose(request.selection, composeOptions);
}

export async function performDialogueExport(
	request: DialogueExportRequest,
	outputDirectory: string,
	composeOptions: ComposeReadOptions = {},
): Promise<{ envelope: DialogueExportEnvelope; target: string }> {
	const envelope = await collectDialogueExport(request, composeOptions);
	const target = await writeProtectedDialogueFile(
		outputDirectory,
		envelope.markdown,
	);
	return { envelope, target };
}

function failureReason(code: DialogueExportErrorCode): string {
	switch (code) {
		case "INVALID_ARGUMENTS":
			return "invalid-arguments";
		case "NO_CONVERSATION":
			return "no-conversation";
		case "DATABASE_UNAVAILABLE":
			return "source-unavailable";
		case "EXPORT_TOO_LARGE":
			return "bounded-limit";
		case "INVALID_DATA":
			return "invalid-data";
	}
}

export async function runDialogueExport(
	argv: readonly string[],
	environment: Environment = process.env,
): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let request: DialogueExportRequest;
	try {
		request = parseDialogueExportArgs(argv, environment);
	} catch {
		process.stderr.write(
			"dialogues export: status=failed conversations=0 turns=0 path=none reason=invalid-arguments\n",
		);
		process.stderr.write(`${USAGE}\n`);
		return 64;
	}

	try {
		const configuredDirectory =
			environment.DIALOGUES_EXPORT_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIRECTORY;
		const { envelope, target } = await performDialogueExport(
			request,
			configuredDirectory,
			{ environment },
		);
		const displayPath = relative(process.cwd(), target);
		const safePath =
			displayPath.length > 0 && !displayPath.startsWith("..")
				? displayPath
				: join(basename(resolve(configuredDirectory)), basename(target));
		process.stdout.write(
			`dialogues export: status=ok conversations=${envelope.conversationCount} turns=${envelope.turnCount} path=${safePath}\n`,
		);
		return 0;
	} catch (error) {
		const code =
			error instanceof DialogueExportError ? error.code : "INVALID_DATA";
		process.stderr.write(
			`dialogues export: status=failed conversations=0 turns=0 path=none reason=${failureReason(code)}\n`,
		);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await runDialogueExport(Bun.argv.slice(2));
}
