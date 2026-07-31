const MARKDOWN_LINK = /\[([^\x5d]+)\]\(\s*(?:https?:\/\/|www\.)[^)]+\)/giu;
const RAW_URL = /(?:https?:\/\/|www\.)[^\s<>()]*[\p{L}\p{N}/#]/giu;
const EMAIL =
	/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
const PHONE = /(?<![\p{L}\p{N}])(?:\+?\d[\d\s().-]{5,}\d)(?![\p{L}\p{N}])/gu;
const TELEGRAM = /(?<![\p{L}\p{N}])@[a-zA-Z][a-zA-Z0-9_]{3,31}\b/gu;
const UUID =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/gu;
const PREFIXED_ID =
	/\b(?:bkg|conv|turn|gen|seg|call|thread|evt)_[a-zA-Z0-9_-]+\b/gu;
const HIDDEN_ID =
	/\b(?:callId|generationId|segmentId|turnId|bookingId|conversationId|threadId)\s*[:=]\s*[^\s,;}]+/giu;
const TOOL_LINE =
	/^\s*(?:tool(?:\.request)?|function|arguments|payload|debug|system|assistant_to|recipient|callId|generationId|segmentId|turnId)\s*[:=].*$/gimu;
const ABBREVIATION_END =
	/(?:\b(?:т\.\s?д|т\.\s?п|и\.\s?т|г|ул|стр|д|им|см)\.|(?:^|\s)[А-ЯA-Z]\.)$/iu;
const CONTACT_REDACTION = "контакт скрыт";

export interface SpeechChunkerOptions {
	firstTarget?: number;
	firstMinimum?: number;
	softTarget?: number;
	hardLimit?: number;
	idleFlushMs?: number;
}

export interface SpeechBudgetOptions {
	maxCharsPerSegment?: number;
	maxCharsPerTurn?: number;
	maxCharsPerSession?: number;
}

export type SpeechBudgetDecision =
	| { ok: true; turnChars: number; sessionChars: number }
	| { ok: false; reason: "segment" | "turn" | "session" };

interface StructuredJsonRegion {
	start: number;
	/** Exclusive end; absent while a JSON-looking structure is incomplete. */
	end?: number;
}

function findStructuredJson(input: string): StructuredJsonRegion | null {
	for (let start = 0; start < input.length; start += 1) {
		const opener = input[start];
		if (opener !== "{" && opener !== "[") continue;
		const remainder = input.slice(start + 1).trimStart();
		const jsonLooking =
			opener === "{"
				? remainder === "" ||
					remainder.startsWith('"') ||
					remainder.startsWith("}")
				: remainder === "" ||
					remainder.startsWith('"') ||
					remainder.startsWith("{") ||
					remainder.startsWith("[") ||
					remainder.startsWith("]") ||
					/^(?:true|false|null|-?\d)/u.test(remainder);
		if (!jsonLooking) continue;
		const stack: string[] = [opener];
		let quoted = false;
		let escaped = false;
		let invalid = false;
		let end = start + 1;
		for (; end < input.length && stack.length > 0; end += 1) {
			const character = input[end] ?? "";
			if (quoted) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') quoted = false;
				continue;
			}
			if (character === '"') quoted = true;
			else if (character === "{" || character === "[") stack.push(character);
			else if (character === "}" || character === "]") {
				const expected = character === "}" ? "{" : "[";
				if (stack.at(-1) !== expected) {
					invalid = true;
					break;
				}
				stack.pop();
			}
		}
		if (invalid) continue;
		if (stack.length > 0) return { start };
		try {
			JSON.parse(input.slice(start, end));
			return { start, end };
		} catch {
			// Balanced non-JSON braces are ordinary visible text.
		}
	}
	return null;
}

function stripCompleteJson(input: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < input.length) {
		const opener = input[cursor];
		if (opener !== "{" && opener !== "[") {
			output += opener;
			cursor += 1;
			continue;
		}
		const stack: string[] = [opener];
		let quoted = false;
		let escaped = false;
		let end = cursor + 1;
		for (; end < input.length && stack.length > 0; end += 1) {
			const character = input[end] ?? "";
			if (quoted) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') quoted = false;
				continue;
			}
			if (character === '"') quoted = true;
			else if (character === "{" || character === "[") stack.push(character);
			else if (character === "}" || character === "]") {
				const expected = character === "}" ? "{" : "[";
				if (stack.at(-1) !== expected) break;
				stack.pop();
			}
		}
		const candidate = input.slice(cursor, end);
		if (stack.length === 0) {
			try {
				JSON.parse(candidate);
				output += " ";
				cursor = end;
				continue;
			} catch {
				// Keep non-JSON brackets for the ordinary speech cleanup below.
			}
		}
		output += opener;
		cursor += 1;
	}
	return output;
}

function stripCodeAndEnvelopes(input: string): string {
	let text = input.replace(/```[^\n]*\n?[\s\S]*?```/gu, " ");
	text = text.replace(/```[^\n]*\n?[\s\S]*$/gu, " ");
	text = text.replace(/`[^`\n]*`/gu, " ");
	text = text.replace(
		/<tool(?:_call|_result)?\b[^>]*>[\s\S]*?<\/tool(?:_call|_result)?>/giu,
		" ",
	);
	text = text.replace(/<[^>]*(?:tool|function|system|assistant)[^>]*>/giu, " ");
	text = stripCompleteJson(text);
	// Never speak incomplete JSON fragments released by a streaming chunker.
	// A quoted property is structural regardless of key order or nesting.
	text = text.replace(
		/(?:^|\s|[,;])(?:\{|\[)?\s*"(?:[^"\\]|\\.)*"\s*:[\s\S]*$/gu,
		" ",
	);
	text = text.replace(/\{[\s\S]*$/gu, " ");
	text = text.replace(
		/\[\s*(?:(?:"|\{|\[)|(?:true|false|null)\b|-?\d)[\s\S]*$/gu,
		" ",
	);
	text = text.replace(/^[\s,;]*[\]}][\s\S]*$/gu, " ");
	return text;
}

/**
 * Produces provider-safe spoken text. Callers retain the original model text
 * for the visible transcript; this function is only for TTS input.
 */
export function sanitizeSpeech(input: string): string {
	let text = stripCodeAndEnvelopes(input.replace(/\r\n?/gu, "\n"));
	text = text.replace(MARKDOWN_LINK, "$1");
	text = text.replace(RAW_URL, " ");
	text = text.replace(EMAIL, CONTACT_REDACTION);
	text = text.replace(PHONE, CONTACT_REDACTION);
	text = text.replace(TELEGRAM, CONTACT_REDACTION);
	text = text.replace(HIDDEN_ID, " ");
	text = text.replace(UUID, " ");
	text = text.replace(ULID, " ");
	text = text.replace(PREFIXED_ID, " ");
	text = text.replace(TOOL_LINE, "");
	text = text.replace(/^\s{0,3}#{1,6}\s+/gmu, "");
	text = text.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gmu, "");
	text = text.replace(/[{}<>]|\[|\]/gu, " ");
	text = text.replace(/[*_~>|]+/gu, " ");
	text = text.replace(
		/\b(?:create_booking|append_booking_qualification)\b/giu,
		" ",
	);
	text = text.replace(
		/(?:\s*контакт скрыт[,.]?){2,}/giu,
		` ${CONTACT_REDACTION}`,
	);
	text = text.replace(/\s+([,.!?;:])/gu, "$1");
	text = text.replace(/\s+/gu, " ").trim();
	return /^[\p{P}\p{S}\s]*$/u.test(text) ? "" : text;
}

function indexInside(pattern: RegExp, text: string, index: number): boolean {
	pattern.lastIndex = 0;
	for (const match of text.matchAll(pattern)) {
		const start = match.index;
		if (
			start !== undefined &&
			index >= start &&
			index < start + match[0].length
		) {
			return true;
		}
	}
	return false;
}

function punctuationProtected(text: string, index: number): boolean {
	if (indexInside(EMAIL, text, index) || indexInside(RAW_URL, text, index)) {
		return true;
	}
	const previous = text[index - 1] ?? "";
	const next = text[index + 1] ?? "";
	if (/\d/u.test(previous) && /\d/u.test(next)) return true;
	return ABBREVIATION_END.test(text.slice(Math.max(0, index - 12), index + 1));
}

function isUnsafeNumberBoundary(text: string, index: number): boolean {
	const left = text.slice(0, index).match(/\d[\d\s().+-]*$/u)?.[0] ?? "";
	const right = text.slice(index).match(/^\s*[\d().-]/u)?.[0] ?? "";
	return left.length > 0 && right.length > 0;
}

function boundaries(text: string): number[] {
	const result: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] ?? "";
		if (/[.!?;]/u.test(character) && !punctuationProtected(text, index)) {
			result.push(index + 1);
		}
	}
	return result;
}

function safeWordBoundary(text: string, limit: number): number {
	for (let index = Math.min(limit, text.length); index > 0; index -= 1) {
		if (!/\s/u.test(text[index] ?? "")) continue;
		if (isUnsafeNumberBoundary(text, index)) continue;
		return index;
	}
	return Math.min(limit, text.length);
}

/** Streaming phrase chunker with first/soft/hard targets and idle flush. */
export class StreamingSentenceChunker {
	#buffer = "";
	#first = true;
	readonly #firstTarget: number;
	readonly #firstMinimum: number;
	readonly #softTarget: number;
	readonly #hardLimit: number;
	readonly #idleFlushMs: number;

	constructor(options: number | SpeechChunkerOptions = {}) {
		const normalized =
			typeof options === "number" ? { hardLimit: options } : options;
		this.#hardLimit = normalized.hardLimit ?? 240;
		this.#softTarget = normalized.softTarget ?? 160;
		this.#firstTarget = normalized.firstTarget ?? 100;
		this.#firstMinimum = normalized.firstMinimum ?? 60;
		this.#idleFlushMs = normalized.idleFlushMs ?? 350;
		if (
			this.#firstMinimum < 1 ||
			this.#firstMinimum > this.#firstTarget ||
			this.#firstTarget > 120 ||
			this.#softTarget < 120 ||
			this.#softTarget > 180 ||
			this.#softTarget > this.#hardLimit ||
			this.#hardLimit > 240
		) {
			throw new RangeError("Invalid speech chunk targets");
		}
	}

	push(delta: string): string[] {
		this.#buffer += delta;
		return this.#drain(false, false);
	}

	flush(): string[] {
		return this.#drain(true, false);
	}

	flushIdle(idleMs: number): string[] {
		return idleMs >= this.#idleFlushMs ? this.#drain(true, true) : [];
	}

	get pending(): string {
		return this.#buffer;
	}

	clear(): void {
		this.#buffer = "";
	}

	#drain(flush: boolean, idle: boolean): string[] {
		const chunks: string[] = [];
		while (this.#buffer.trim()) {
			this.#buffer = this.#buffer.trimStart();
			const structured = findStructuredJson(this.#buffer);
			if (structured) {
				if (structured.start > 0) {
					const prefix = this.#buffer.slice(0, structured.start).trim();
					this.#buffer = this.#buffer.slice(structured.start);
					if (prefix) {
						chunks.push(prefix);
						this.#first = false;
					}
					continue;
				}
				if (structured.end !== undefined) {
					const envelope = this.#buffer.slice(0, structured.end).trim();
					this.#buffer = this.#buffer.slice(structured.end);
					if (envelope) {
						chunks.push(envelope);
						this.#first = false;
					}
					continue;
				}
				if (!flush && !idle) break;
			}
			const minimum = this.#first ? this.#firstMinimum : 1;
			const target = this.#first ? this.#firstTarget : this.#softTarget;
			const stops = boundaries(this.#buffer);
			let end = stops.find((value) => value >= minimum && value <= target);
			if (end === undefined && this.#buffer.length >= target) {
				end = stops.find((value) => value > target && value <= this.#hardLimit);
			}
			if (end === undefined && this.#buffer.length > this.#hardLimit) {
				end = safeWordBoundary(this.#buffer, this.#hardLimit);
			}
			if (end === undefined && (flush || idle)) {
				end = Math.min(this.#buffer.length, this.#hardLimit);
				if (end < this.#buffer.length)
					end = safeWordBoundary(this.#buffer, end);
			}
			if (end === undefined || end <= 0) break;
			const chunk = this.#buffer.slice(0, end).trim();
			this.#buffer = this.#buffer.slice(end);
			if (chunk) {
				chunks.push(chunk);
				this.#first = false;
			}
		}
		if (!this.#buffer.trim()) this.#buffer = "";
		return chunks;
	}
}

/** Charges sanitized provider text once, before any retry. */
export class SpeechBudgetGuard {
	readonly #segment: number;
	readonly #turn: number;
	readonly #session: number;
	#turnChars = 0;
	#sessionChars = 0;

	constructor(options: SpeechBudgetOptions = {}) {
		this.#segment = options.maxCharsPerSegment ?? 240;
		this.#turn = options.maxCharsPerTurn ?? 1_800;
		this.#session = options.maxCharsPerSession ?? 8_000;
		if (this.#segment < 1 || this.#segment > 240) {
			throw new RangeError("Per-segment TTS budget must be 1..240");
		}
		if (this.#turn < this.#segment || this.#session < this.#turn) {
			throw new RangeError("TTS budgets must increase from segment to session");
		}
	}

	startTurn(): void {
		this.#turnChars = 0;
	}

	reserve(text: string): SpeechBudgetDecision {
		const chars = [...text].length;
		if (chars === 0 || chars > this.#segment)
			return { ok: false, reason: "segment" };
		if (this.#turnChars + chars > this.#turn)
			return { ok: false, reason: "turn" };
		if (this.#sessionChars + chars > this.#session)
			return { ok: false, reason: "session" };
		this.#turnChars += chars;
		this.#sessionChars += chars;
		return {
			ok: true,
			turnChars: this.#turnChars,
			sessionChars: this.#sessionChars,
		};
	}

	get usage(): { turnChars: number; sessionChars: number } {
		return { turnChars: this.#turnChars, sessionChars: this.#sessionChars };
	}
}

/** Tracks the server synthesis window: one current request and one prefetch. */
export class SpeechPrefetchCoordinator {
	#inFlight = new Set<string>();

	tryStart(segmentId: string): boolean {
		if (this.#inFlight.has(segmentId) || this.#inFlight.size >= 2) return false;
		this.#inFlight.add(segmentId);
		return true;
	}

	finish(segmentId: string): void {
		this.#inFlight.delete(segmentId);
	}

	/**
	 * Provider requests are aborted through their generation signals. Keep every
	 * abort-insensitive request counted until its promise actually settles.
	 */
	abortAll(): void {
		return;
	}

	get inFlight(): number {
		return this.#inFlight.size;
	}
}

/** Convenience function for completed model output. */
export function chunkSpeech(
	text: string,
	options: number | SpeechChunkerOptions = {},
): string[] {
	const chunker = new StreamingSentenceChunker(options);
	return [...chunker.push(text), ...chunker.flush()];
}
