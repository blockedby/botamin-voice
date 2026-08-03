#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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
const MAX_IPC_BYTES = MAX_EXPORT_BYTES * 2 + 1024 * 1024;
const USAGE =
	"Usage: bun run dialogues:export [--conversation <ULID-or-UUIDv7> | --limit <1..100> | --all]";

export type ProtectedWriteOptions = {
	now?: Date;
	randomSuffix?: () => string;
	beforeRename?: () => void | Promise<void>;
};

function safeSuffix(): string {
	return randomBytes(8).toString("hex");
}

function filenameTimestamp(now: Date): string {
	if (Number.isNaN(now.getTime()))
		throw new DialogueExportError("INVALID_DATA");
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
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		bytes += result.value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel();
			throw new DialogueExportError("EXPORT_TOO_LARGE");
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

async function discard(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	for (;;) {
		const result = await reader.read();
		if (result.done) return;
	}
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

async function readFromCompose(
	selection: ExportSelection,
): Promise<DialogueExportEnvelope> {
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
				...selectionArguments(selection),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			},
		);
	} catch {
		throw new DialogueExportError("DATABASE_UNAVAILABLE");
	}

	try {
		if (
			!(child.stdout instanceof ReadableStream) ||
			!(child.stderr instanceof ReadableStream)
		) {
			throw new DialogueExportError("DATABASE_UNAVAILABLE");
		}
		const [stdout, , status] = await Promise.all([
			collectBounded(child.stdout, MAX_IPC_BYTES),
			discard(child.stderr),
			child.exited,
		]);
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
		if (child.exitCode === null) child.kill();
		throw error;
	}
}

export async function collectDialogueExport(
	selection: ExportSelection,
): Promise<DialogueExportEnvelope> {
	if (
		process.env.DATABASE_URL !== undefined &&
		process.env.DATABASE_URL !== ""
	) {
		return buildDialogueExport(databasePathFromUrl(), selection);
	}
	return readFromCompose(selection);
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
): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let selection: ExportSelection;
	try {
		selection = parseExportArgs(argv);
	} catch {
		process.stderr.write(
			"dialogues export: status=failed conversations=0 turns=0 path=none reason=invalid-arguments\n",
		);
		process.stderr.write(`${USAGE}\n`);
		return 64;
	}

	try {
		const envelope = await collectDialogueExport(selection);
		const configuredDirectory =
			process.env.DIALOGUES_EXPORT_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIRECTORY;
		const target = await writeProtectedDialogueFile(
			configuredDirectory,
			envelope.markdown,
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
