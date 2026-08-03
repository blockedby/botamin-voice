#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";

export const MAX_CONVERSATIONS = 100;
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

const COMPOSE_DATABASE_PATH = "/data/app.db";
const ENTITY_ID_PATTERN =
	/^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const MARKDOWN_PUNCTUATION = new Set(
	Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"),
);

export type ExportSelection =
	| { kind: "latest" }
	| { kind: "conversation"; conversationId: string }
	| { kind: "limit"; limit: number }
	| { kind: "all" };

export type DialogueExportEnvelope = {
	formatVersion: 1;
	conversationCount: number;
	turnCount: number;
	markdown: string;
};

export type DialogueExportErrorCode =
	| "INVALID_ARGUMENTS"
	| "DATABASE_UNAVAILABLE"
	| "NO_CONVERSATION"
	| "EXPORT_TOO_LARGE"
	| "INVALID_DATA";

export class DialogueExportError extends Error {
	constructor(readonly code: DialogueExportErrorCode) {
		super(code);
		this.name = "DialogueExportError";
	}
}

type ConversationRow = { id: string };
type TurnRow = { user_text: string; assistant_text: string };

function invalidArguments(): never {
	throw new DialogueExportError("INVALID_ARGUMENTS");
}

export function parseExportArgs(argv: readonly string[]): ExportSelection {
	let conversationId: string | undefined;
	let limit: number | undefined;
	let all = false;
	let separatorSeen = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--" && !separatorSeen) {
			separatorSeen = true;
			continue;
		}
		if (argument === "--conversation") {
			if (conversationId !== undefined) invalidArguments();
			const value = argv[index + 1];
			if (value === undefined || !ENTITY_ID_PATTERN.test(value)) {
				invalidArguments();
			}
			conversationId = value;
			index += 1;
			continue;
		}
		if (argument === "--limit") {
			if (limit !== undefined) invalidArguments();
			const value = argv[index + 1];
			if (value === undefined || !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(value)) {
				invalidArguments();
			}
			limit = Number(value);
			index += 1;
			continue;
		}
		if (argument === "--all") {
			if (all) invalidArguments();
			all = true;
			continue;
		}
		invalidArguments();
	}

	const modeCount =
		Number(conversationId !== undefined) +
		Number(limit !== undefined) +
		Number(all);
	if (modeCount > 1) invalidArguments();
	if (conversationId !== undefined) {
		return { kind: "conversation", conversationId };
	}
	if (limit !== undefined) return { kind: "limit", limit };
	if (all) return { kind: "all" };
	return { kind: "latest" };
}

/** Accepts only an explicit absolute SQLite path or file URL. */
export function databasePathFromUrl(url: string): string {
	const value = url.startsWith("file:") ? url.slice("file:".length) : url;
	if (
		value.length === 0 ||
		value.includes("?") ||
		value.includes("#") ||
		value.includes("\0") ||
		!isAbsolute(value)
	) {
		throw new DialogueExportError("DATABASE_UNAVAILABLE");
	}
	return value;
}

function parseReaderArgs(argv: readonly string[]): {
	databasePath: string;
	selection: ExportSelection;
} {
	let databasePath: string | undefined;
	const selectorArguments: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index] ?? invalidArguments();
		if (argument !== "--database") {
			selectorArguments.push(argument);
			continue;
		}
		if (databasePath !== undefined) invalidArguments();
		const value = argv[index + 1] ?? invalidArguments();
		if (!isAbsolute(value)) invalidArguments();
		databasePath = value;
		index += 1;
	}
	if (databasePath === undefined) invalidArguments();
	return {
		databasePath,
		selection: parseExportArgs(selectorArguments),
	};
}

function visibleControls(value: string): string {
	return Array.from(value, (character) => {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) return "";
		const hidden =
			(codePoint <= 0x1f && codePoint !== 0x0a) ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			/\p{Cf}/u.test(character);
		return hidden
			? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
			: character;
	}).join("");
}

/** Neutralizes inline and line-start Markdown while preserving readable text. */
export function escapeMarkdownText(value: string): string {
	const normalized = visibleControls(
		value
			.normalize("NFC")
			.replace(/\r\n?/gu, "\n")
			.replace(/[\u2028\u2029]/gu, "\n")
			.replaceAll("\t", "    "),
	);
	const escaped = Array.from(normalized, (character) =>
		MARKDOWN_PUNCTUATION.has(character) ? `\\${character}` : character,
	).join("");
	return escaped
		.split("\n")
		.map((line) =>
			line.replace(/^ +/u, (spaces) => "&#32;".repeat(spaces.length)),
		)
		.join("\n");
}

function selectConversations(
	database: Database,
	selection: ExportSelection,
): ConversationRow[] {
	if (selection.kind === "conversation") {
		return database
			.query<ConversationRow, [string]>(
				"SELECT id FROM conversations WHERE id = ?",
			)
			.all(selection.conversationId);
	}
	if (selection.kind === "all") {
		const count = database
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM conversations",
			)
			.get()?.count;
		if (count === undefined) throw new DialogueExportError("INVALID_DATA");
		if (count > MAX_CONVERSATIONS) {
			throw new DialogueExportError("EXPORT_TOO_LARGE");
		}
		return database
			.query<ConversationRow, []>(
				`SELECT id FROM conversations
				 ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC, id DESC`,
			)
			.all();
	}
	const limit = selection.kind === "limit" ? selection.limit : 1;
	return database
		.query<ConversationRow, [number]>(
			`SELECT id FROM conversations
			 ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC, id DESC
			 LIMIT ?`,
		)
		.all(limit);
}

function transcriptBytes(database: Database, conversationId: string): number {
	const row = database
		.query<{ bytes: number }, [string]>(
			`SELECT COALESCE(SUM(
				length(CAST(user_text AS BLOB)) + length(CAST(assistant_text AS BLOB))
			), 0) AS bytes
			FROM turns WHERE conversation_id = ?`,
		)
		.get(conversationId);
	if (row === null || row.bytes < 0 || !Number.isSafeInteger(row.bytes)) {
		throw new DialogueExportError("INVALID_DATA");
	}
	return row.bytes;
}

function renderConversation(
	database: Database,
	conversation: ConversationRow,
	ordinal: number,
): { markdown: string; turnCount: number } {
	const turns = database
		.query<TurnRow, [string]>(
			`SELECT user_text, assistant_text
			 FROM turns
			 WHERE conversation_id = ?
			 ORDER BY CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END,
			          completed_at ASC,
			          rowid ASC`,
		)
		.all(conversation.id);
	const lines = [`## Диалог ${ordinal}`, ""];

	for (const [index, turn] of turns.entries()) {
		lines.push(
			`### Реплика ${index + 1}`,
			"",
			"#### Вы",
			"",
			escapeMarkdownText(turn.user_text),
			"",
			"#### Botamin",
			"",
			escapeMarkdownText(turn.assistant_text),
			"",
		);
	}
	return { markdown: lines.join("\n"), turnCount: turns.length };
}

export function buildDialogueExport(
	databasePath: string,
	selection: ExportSelection = { kind: "latest" },
): DialogueExportEnvelope {
	let database: Database;
	try {
		database = new Database(databasePath, { readonly: true, strict: true });
	} catch {
		throw new DialogueExportError("DATABASE_UNAVAILABLE");
	}

	let transactionOpen = false;
	try {
		database.run("PRAGMA query_only = ON");
		database.run("PRAGMA busy_timeout = 10000");
		database.run("BEGIN DEFERRED");
		transactionOpen = true;
		const conversations = selectConversations(database, selection);
		if (conversations.length === 0) {
			throw new DialogueExportError("NO_CONVERSATION");
		}

		let rawTranscriptBytes = 0;
		for (const conversation of conversations) {
			rawTranscriptBytes += transcriptBytes(database, conversation.id);
			if (rawTranscriptBytes > MAX_TRANSCRIPT_BYTES) {
				throw new DialogueExportError("EXPORT_TOO_LARGE");
			}
		}

		const sections = ["# Диалоги Botamin", ""];
		let turnCount = 0;
		for (const [index, conversation] of conversations.entries()) {
			const rendered = renderConversation(database, conversation, index + 1);
			sections.push(rendered.markdown);
			turnCount += rendered.turnCount;
		}
		const markdown = `${sections.join("\n")}\n`;
		if (Buffer.byteLength(markdown, "utf8") > MAX_EXPORT_BYTES) {
			throw new DialogueExportError("EXPORT_TOO_LARGE");
		}
		database.run("COMMIT");
		transactionOpen = false;
		return {
			formatVersion: 1,
			conversationCount: conversations.length,
			turnCount,
			markdown,
		};
	} catch (error) {
		if (error instanceof DialogueExportError) throw error;
		throw new DialogueExportError("DATABASE_UNAVAILABLE");
	} finally {
		if (transactionOpen) {
			try {
				database.run("ROLLBACK");
			} catch {
				// The connection is still closed below; no output is emitted on failure.
			}
		}
		database.close(false);
	}
}

function readerExitCode(code: DialogueExportErrorCode): number {
	switch (code) {
		case "INVALID_ARGUMENTS":
			return 64;
		case "NO_CONVERSATION":
			return 66;
		case "DATABASE_UNAVAILABLE":
			return 69;
		case "INVALID_DATA":
			return 70;
		case "EXPORT_TOO_LARGE":
			return 75;
	}
}

if (import.meta.main) {
	try {
		const parsed = parseReaderArgs(Bun.argv.slice(2));
		if (parsed.databasePath !== COMPOSE_DATABASE_PATH) {
			throw new DialogueExportError("INVALID_ARGUMENTS");
		}
		process.stdout.write(
			JSON.stringify(
				buildDialogueExport(parsed.databasePath, parsed.selection),
			),
		);
	} catch (error) {
		const code =
			error instanceof DialogueExportError ? error.code : "INVALID_DATA";
		process.stderr.write("dialogue export reader: status=failed\n");
		process.exitCode = readerExitCode(code);
	}
}
