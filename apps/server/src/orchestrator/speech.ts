import {
	phoneLikeNumericSeparatorOffsets,
	phoneLikeStreamingRunPrefixEnd,
	scanPhoneLikeText,
	trailingPhoneLikeHoldbackStart,
} from "@botamin/contracts";
import {
	type ApprovedSpeechContact,
	MAX_APPROVED_SPEECH_CONTACTS,
	markApprovedSpeechContacts,
	redactPhoneLikeSpeechCandidates,
	type SpeechContactChannel,
} from "./speech-contacts";

export type {
	ApprovedSpeechContact,
	SpeechContactChannel,
} from "./speech-contacts";

const MARKDOWN_LINK = /\[([^\x5d]+)\]\(\s*(?:https?:\/\/|www\.)[^)]+\)/giu;
const BRACKET_STYLE_TAG = /\[[^\]\r\n]*\]/gu;
const RAW_URL = /(?:https?:\/\/|www\.)[^\s<>()]*[\p{L}\p{N}/#]/giu;
const EMAIL =
	/[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
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
const MAX_PROVIDER_SPEECH_CHARS = 240;

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

export interface PrepareSpeechOptions {
	contactProcessing: boolean;
	/** Server-approved contacts from a confirmed draft or committed booking. */
	approvedContacts: readonly ApprovedSpeechContact[];
}

export interface ProtectedSpeechSpan {
	/** UTF-16 offsets into spokenText; the end is exclusive. */
	start: number;
	end: number;
}

export interface PreparedSpeech {
	spokenText: string;
	/** Approved spoken contacts that must remain inside one provider request. */
	protectedSpans: readonly ProtectedSpeechSpan[];
	metadata: {
		forwardedChannels: SpeechContactChannel[];
		forwardedCount: number;
	};
}

export type SpeechBudgetDecision =
	| { ok: true; turnChars: number; sessionChars: number }
	| { ok: false; reason: "segment" | "turn" | "session" };

const KNOWN_RUSSIAN_PRONUNCIATIONS = [
	{ pattern: /(?<![\p{L}\p{N}])CRM(?![\p{L}\p{N}])/giu, spoken: "си-эр-эм" },
	{ pattern: /(?<![\p{L}\p{N}])ООО(?![\p{L}\p{N}])/gu, spoken: "о-о-о" },
] as const;

/**
 * Applies a deliberately small provider-neutral TTS rendering pass. Privacy
 * and contact authority have already been resolved by prepareSpeech(); the
 * visible transcript is never passed through this function.
 *
 * Protected approved contacts are returned byte-for-byte unchanged. This is
 * intentionally conservative: punctuation edits around an expanded contact
 * could otherwise invalidate its atomic offsets.
 */
export function renderPreparedSpeech(prepared: PreparedSpeech): PreparedSpeech {
	if (!prepared.spokenText || prepared.protectedSpans.length > 0)
		return prepared;

	let spokenText = prepared.spokenText
		.replace(/[\t\v\f ]+/gu, " ")
		.replace(/\s+([,.!?;:])/gu, "$1")
		.replace(/([,!?;:])(?=\p{L})/gu, (punctuation, _capture, offset, source) =>
			/\p{N}/u.test(source[offset - 1] ?? "") ? punctuation : `${punctuation} `,
		)
		.replace(/(?<=\p{L})\.(?=\p{Lu})/gu, ". ")
		.trim();
	for (const pronunciation of KNOWN_RUSSIAN_PRONUNCIATIONS) {
		spokenText = spokenText.replace(
			pronunciation.pattern,
			pronunciation.spoken,
		);
	}
	return spokenText === prepared.spokenText
		? prepared
		: { ...prepared, spokenText };
}

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

/** Produces provider-safe spoken text for the TTS boundary. */
export function sanitizeSpeech(input: string): string {
	let text = stripCodeAndEnvelopes(input.replace(/\r\n?/gu, "\n"));
	text = text.replace(MARKDOWN_LINK, "$1");
	// Strip the complete bracketed control, not only its delimiters, so model
	// or visitor-authored voice tags can never become provider instructions.
	text = text.replace(BRACKET_STYLE_TAG, " ");
	text = redactPhoneLikeSpeechCandidates(text);
	text = text.replace(RAW_URL, " ");
	text = text.replace(EMAIL, CONTACT_REDACTION);
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

/**
 * Removes model-authored square-bracket delivery controls before text enters
 * the visible transcript, durable projection, or speech chunker. A control may
 * span any number of deltas. Unclosed controls fail closed at end of stream;
 * ordinary text outside controls is forwarded incrementally without buffering.
 */
export class StreamingModelControlSanitizer {
	#depth = 0;

	push(delta: string): string {
		let visible = "";
		for (const character of delta) {
			if (character === "[") {
				this.#depth += 1;
				continue;
			}
			if (character === "]") {
				if (this.#depth > 0) this.#depth -= 1;
				if (this.#depth === 0) visible += " ";
				continue;
			}
			if (this.#depth === 0) visible += character;
		}
		return visible;
	}

	flush(): void {
		this.#depth = 0;
	}

	clear(): void {
		this.#depth = 0;
	}
}

/**
 * Produces TTS-only text and forwards exact approved contacts when consented.
 * Protected offsets survive marker expansion for atomic provider chunking.
 */
export function prepareSpeech(
	input: string,
	options: PrepareSpeechOptions,
): PreparedSpeech {
	const approvedContacts =
		options.contactProcessing &&
		options.approvedContacts.length <= MAX_APPROVED_SPEECH_CONTACTS
			? options.approvedContacts
			: [];
	const stripped = stripCodeAndEnvelopes(
		input.replace(/\r\n?/gu, "\n").normalize("NFC"),
	);
	const incompleteApprovedStart = trailingApprovedContactPrefixStart(
		stripped,
		approvedStreamingPrefixes(
			options.approvedContacts.length <= MAX_APPROVED_SPEECH_CONTACTS
				? options.approvedContacts
				: [],
		),
	);
	const contactSafeInput =
		incompleteApprovedStart === null
			? stripped
			: `${stripped.slice(0, incompleteApprovedStart)}${CONTACT_REDACTION}`;
	const marked = markApprovedSpeechContacts(contactSafeInput, approvedContacts);
	let spokenText = sanitizeSpeech(marked.text);
	const protectedSpans: ProtectedSpeechSpan[] = [];
	const forwardedChannels = new Set<SpeechContactChannel>();
	let forwardedCount = 0;
	for (const contact of marked.contacts) {
		let markerStart = spokenText.indexOf(contact.marker);
		while (markerStart !== -1) {
			const replacement =
				contact.spoken.length <= MAX_PROVIDER_SPEECH_CHARS
					? contact.spoken
					: CONTACT_REDACTION;
			spokenText = `${spokenText.slice(0, markerStart)}${replacement}${spokenText.slice(markerStart + contact.marker.length)}`;
			if (replacement !== CONTACT_REDACTION) {
				protectedSpans.push({
					start: markerStart,
					end: markerStart + replacement.length,
				});
				forwardedChannels.add(contact.channel);
				forwardedCount += 1;
			}
			markerStart = spokenText.indexOf(
				contact.marker,
				markerStart + replacement.length,
			);
		}
	}
	protectedSpans.sort((left, right) => left.start - right.start);
	if (/^[\p{P}\p{S}\s]*$/u.test(spokenText)) spokenText = "";
	return {
		spokenText,
		protectedSpans,
		metadata: {
			forwardedChannels: [...forwardedChannels],
			forwardedCount,
		},
	};
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

function punctuationProtected(
	text: string,
	index: number,
	numericSeparators: ReadonlySet<number> | null,
): boolean {
	if (indexInside(EMAIL, text, index) || indexInside(RAW_URL, text, index)) {
		return true;
	}
	if (numericSeparators === null || numericSeparators.has(index)) return true;
	return ABBREVIATION_END.test(text.slice(Math.max(0, index - 12), index + 1));
}

function boundaries(text: string): number[] {
	const result: number[] = [];
	const numericSeparators = phoneLikeNumericSeparatorOffsets(text);
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] ?? "";
		if (
			/[.!?;]/u.test(character) &&
			!punctuationProtected(text, index, numericSeparators)
		) {
			result.push(index + 1);
		}
	}
	return result;
}

const NUMERIC_BOUNDARY_CONTEXT = 96;

function splitsNumericExemption(
	text: string,
	index: number,
	numericSeparators: ReadonlySet<number> | null,
): boolean {
	if (numericSeparators === null || numericSeparators.has(index)) return true;
	const start = Math.max(0, index - NUMERIC_BOUNDARY_CONTEXT);
	const end = Math.min(text.length, index + NUMERIC_BOUNDARY_CONTEXT);
	const window = text.slice(start, end);
	const localIndex = index - start;
	const whole = scanPhoneLikeText(window);
	if (whole.overflow || whole.regions.length > 0) return false;
	const left = scanPhoneLikeText(window.slice(0, localIndex));
	const right = scanPhoneLikeText(window.slice(localIndex));
	return (
		left.overflow ||
		right.overflow ||
		left.regions.length > 0 ||
		right.regions.length > 0
	);
}

function approvedStreamingPrefixes(
	contacts: readonly ApprovedSpeechContact[],
): string[] {
	const prefixes: string[] = [];
	for (const contact of contacts) {
		const normalized = contact.value.normalize("NFKC").trim().toLowerCase();
		if (contact.channel === "email" || contact.channel === "phone") {
			prefixes.push(normalized);
		}
		if (contact.channel === "telegram") {
			const username = normalized.startsWith("@")
				? normalized.slice(1)
				: normalized.match(/t\.me\/([a-z0-9_]+)/u)?.[1];
			if (username) {
				prefixes.push(
					`@${username}`,
					`t.me/${username}`,
					`https://t.me/${username}`,
					`http://t.me/${username}`,
					`www.t.me/${username}`,
				);
			}
		}
	}
	return prefixes;
}

function trailingApprovedContactPrefixStart(
	text: string,
	approvedPrefixes: readonly string[],
): number | null {
	if (approvedPrefixes.length === 0) return null;
	const maximum = Math.max(...approvedPrefixes.map((value) => value.length));
	const earliest = Math.max(0, text.length - maximum);
	for (let start = earliest; start < text.length; start += 1) {
		const previous = text[start - 1] ?? "";
		if (previous && /[\p{L}\p{N}._+@/-]/u.test(previous)) continue;
		const suffix = text.slice(start).normalize("NFKC").toLowerCase();
		if (
			suffix &&
			approvedPrefixes.some(
				(contact) => contact !== suffix && contact.startsWith(suffix),
			)
		) {
			return start;
		}
	}
	return null;
}

function safeWordBoundary(text: string, limit: number): number {
	const phoneScan = scanPhoneLikeText(text);
	const numericSeparators = phoneLikeNumericSeparatorOffsets(text);
	for (let index = Math.min(limit, text.length); index > 0; index -= 1) {
		if (!/\s/u.test(text[index] ?? "")) continue;
		if (
			phoneScan.overflow ||
			phoneScan.regions.some(
				(region) => index > region.start && index < region.end,
			) ||
			splitsNumericExemption(text, index, numericSeparators)
		) {
			continue;
		}
		return index;
	}
	return Math.min(limit, text.length);
}

/** Streaming phrase chunker with first/soft/hard targets and idle flush. */
export class StreamingSentenceChunker {
	#buffer = "";
	#first = true;
	#redactingPhoneRun = false;
	readonly #approvedContactPrefixes: readonly string[];
	readonly #firstTarget: number;
	readonly #firstMinimum: number;
	readonly #softTarget: number;
	readonly #hardLimit: number;
	readonly #idleFlushMs: number;

	constructor(
		options: number | SpeechChunkerOptions = {},
		approvedContacts: readonly ApprovedSpeechContact[] = [],
	) {
		const normalized =
			typeof options === "number" ? { hardLimit: options } : options;
		this.#hardLimit = normalized.hardLimit ?? 240;
		this.#softTarget = normalized.softTarget ?? 160;
		this.#firstTarget = normalized.firstTarget ?? 100;
		this.#firstMinimum = normalized.firstMinimum ?? 60;
		this.#idleFlushMs = normalized.idleFlushMs ?? 350;
		this.#approvedContactPrefixes = approvedStreamingPrefixes(approvedContacts);
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
		this.#redactingPhoneRun = false;
	}

	#drain(flush: boolean, idle: boolean): string[] {
		const chunks: string[] = [];
		while (this.#buffer.trim()) {
			if (this.#redactingPhoneRun) {
				const protectedEnd = phoneLikeStreamingRunPrefixEnd(this.#buffer);
				if (protectedEnd === this.#buffer.length) {
					if (flush || this.#buffer.length > this.#hardLimit) this.#buffer = "";
					break;
				}
				this.#buffer = this.#buffer.slice(protectedEnd);
				this.#redactingPhoneRun = false;
			}
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
			const phoneScan = scanPhoneLikeText(this.#buffer);
			let crossingPhoneStart: number | null = null;
			if (end !== undefined) {
				const proposedEnd = end;
				const crossing = phoneScan.overflow
					? { start: 0, end: this.#buffer.length }
					: phoneScan.regions.find(
							(region) =>
								proposedEnd > region.start && proposedEnd < region.end,
						);
				if (crossing) {
					crossingPhoneStart = crossing.start;
					end =
						crossing.start === 0 &&
						crossing.end <= this.#hardLimit &&
						crossing.end < this.#buffer.length
							? crossing.end
							: crossing.start;
				}
			}
			const phoneHoldback = trailingPhoneLikeHoldbackStart(this.#buffer);
			const approvedHoldback =
				!flush || idle
					? trailingApprovedContactPrefixStart(
							this.#buffer,
							this.#approvedContactPrefixes,
						)
					: null;
			const contactHoldback =
				phoneHoldback === null
					? approvedHoldback
					: approvedHoldback === null
						? phoneHoldback
						: Math.min(phoneHoldback, approvedHoldback);
			if (
				contactHoldback !== null &&
				end !== undefined &&
				end > contactHoldback
			) {
				end = contactHoldback;
			}
			if (end === undefined || end <= 0) {
				if (phoneHoldback === 0 && flush && !idle) {
					if (this.#buffer.length <= this.#hardLimit) end = this.#buffer.length;
					else {
						this.#buffer = "";
						this.#redactingPhoneRun = true;
						chunks.push(CONTACT_REDACTION);
						this.#first = false;
						break;
					}
				} else if (
					(phoneHoldback === 0 ||
						crossingPhoneStart === 0 ||
						phoneScan.overflow) &&
					this.#buffer.length > this.#hardLimit
				) {
					this.#buffer = "";
					this.#redactingPhoneRun = true;
					chunks.push(CONTACT_REDACTION);
					this.#first = false;
					break;
				} else break;
			}
			if (end === undefined) break;
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

interface NormalizedChunkerOptions {
	firstTarget: number;
	firstMinimum: number;
	softTarget: number;
	hardLimit: number;
}

function normalizedChunkerOptions(
	options: number | SpeechChunkerOptions,
): NormalizedChunkerOptions {
	// Reuse the streaming constructor as the single target-validation contract.
	new StreamingSentenceChunker(options);
	const normalized =
		typeof options === "number" ? { hardLimit: options } : options;
	return {
		firstTarget: normalized.firstTarget ?? 100,
		firstMinimum: normalized.firstMinimum ?? 60,
		softTarget: normalized.softTarget ?? 160,
		hardLimit: normalized.hardLimit ?? MAX_PROVIDER_SPEECH_CHARS,
	};
}

function redactOversizedProtectedSpans(
	prepared: PreparedSpeech,
	hardLimit: number,
): { text: string; spans: ProtectedSpeechSpan[] } {
	let text = "";
	let cursor = 0;
	const spans: ProtectedSpeechSpan[] = [];
	for (const span of prepared.protectedSpans) {
		if (
			!Number.isSafeInteger(span.start) ||
			!Number.isSafeInteger(span.end) ||
			span.start < cursor ||
			span.end <= span.start ||
			span.end > prepared.spokenText.length
		) {
			return { text: CONTACT_REDACTION, spans: [] };
		}
		text += prepared.spokenText.slice(cursor, span.start);
		if (span.end - span.start > hardLimit) text += CONTACT_REDACTION;
		else {
			const start = text.length;
			text += prepared.spokenText.slice(span.start, span.end);
			spans.push({ start, end: text.length });
		}
		cursor = span.end;
	}
	text += prepared.spokenText.slice(cursor);
	return { text, spans };
}

function protectedChunkEnd(
	text: string,
	cursor: number,
	proposedEnd: number,
	spans: readonly ProtectedSpeechSpan[],
	hardLimit: number,
): number {
	const crossing = spans.find(
		(span) => proposedEnd > span.start && proposedEnd < span.end,
	);
	const endingSpan = crossing ?? spans.find((span) => proposedEnd === span.end);
	if (!endingSpan) return proposedEnd;
	let contactEnd = endingSpan.end;
	while (/[,.!?;:)\]}]/u.test(text[contactEnd] ?? "")) contactEnd += 1;
	if (contactEnd - cursor <= hardLimit) return contactEnd;
	if (endingSpan.start > cursor) return endingSpan.start;
	// The contact itself fits but adjacent punctuation does not. Keep the contact
	// whole; punctuation can begin the next prose chunk without exposing it.
	return endingSpan.end;
}

/**
 * Chunks prepared speech while treating every approved spoken contact as one
 * indivisible provider token. Oversized protected spans are redacted in full.
 */
export function chunkPreparedSpeech(
	prepared: PreparedSpeech,
	options: number | SpeechChunkerOptions = {},
): string[] {
	const targets = normalizedChunkerOptions(options);
	const protectedSpeech = redactOversizedProtectedSpans(
		prepared,
		targets.hardLimit,
	);
	if (protectedSpeech.spans.length === 0) {
		return chunkSpeech(protectedSpeech.text, options);
	}

	const chunks: string[] = [];
	let cursor = 0;
	let first = true;
	while (cursor < protectedSpeech.text.length) {
		while (/\s/u.test(protectedSpeech.text[cursor] ?? "")) cursor += 1;
		if (cursor >= protectedSpeech.text.length) break;
		const remaining = protectedSpeech.text.slice(cursor);
		const minimum = first ? targets.firstMinimum : 1;
		const target = first ? targets.firstTarget : targets.softTarget;
		const stops = boundaries(remaining);
		let relativeEnd = stops.find(
			(value) => value >= minimum && value <= target,
		);
		if (relativeEnd === undefined && remaining.length >= target) {
			relativeEnd = stops.find(
				(value) => value > target && value <= targets.hardLimit,
			);
		}
		if (relativeEnd === undefined && remaining.length > targets.hardLimit) {
			relativeEnd = safeWordBoundary(remaining, targets.hardLimit);
		}
		if (relativeEnd === undefined) {
			relativeEnd = Math.min(remaining.length, targets.hardLimit);
			if (relativeEnd < remaining.length) {
				relativeEnd = safeWordBoundary(remaining, relativeEnd);
			}
		}
		const end = protectedChunkEnd(
			protectedSpeech.text,
			cursor,
			cursor + relativeEnd,
			protectedSpeech.spans,
			targets.hardLimit,
		);
		if (end <= cursor) {
			// A validated span at cursor always fits; this is a final fail-closed
			// guard against malformed offset arithmetic.
			return chunkSpeech(CONTACT_REDACTION, options);
		}
		const chunk = protectedSpeech.text.slice(cursor, end).trim();
		cursor = end;
		if (chunk && !/^[\p{P}\p{S}\s]*$/u.test(chunk)) {
			chunks.push(chunk);
			first = false;
		}
	}
	return chunks;
}

/** Convenience function for completed model output without protected spans. */
export function chunkSpeech(
	text: string,
	options: number | SpeechChunkerOptions = {},
): string[] {
	const chunker = new StreamingSentenceChunker(options);
	return [...chunker.push(text), ...chunker.flush()];
}
