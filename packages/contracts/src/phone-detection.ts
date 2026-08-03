export interface PhoneLikeRegion {
	/** Inclusive UTF-16 offset in the original input. */
	start: number;
	/** Exclusive UTF-16 offset in the original input. */
	end: number;
}

export type PhoneLikeScanResult =
	| { overflow: false; regions: readonly PhoneLikeRegion[] }
	| { overflow: true; regions: readonly [] };

export const PHONE_SCAN_MAX_INPUT_CODE_UNITS = 16_384;
export const PHONE_SCAN_MAX_INPUT_CODE_POINTS = 16_384;
export const PHONE_SCAN_MAX_NORMALIZED_CODE_UNITS = 65_536;
export const PHONE_SCAN_MAX_CODE_POINT_EXPANSION = 32;
export const PHONE_SCAN_MAX_CANDIDATES = 256;

// Unicode 16 Nd zeroes. Contiguous multi-set blocks are listed per ten digits.
const UNICODE_DECIMAL_ZEROES = [
	0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66,
	0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810,
	0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
	0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30,
	0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0,
	0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0,
	0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50, 0x16130, 0x16a60, 0x16ac0,
	0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6,
	0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
] as const;

const PLUS_LIKE = new Set(["+", "➕", "✚", "✛", "✜", "✙"]);
const DOT_LIKE = new Set([
	".",
	"․",
	"‥",
	"…",
	"·",
	"•",
	"‣",
	"∙",
	"⋅",
	"◦",
	"▪",
	"▫",
	"●",
	"○",
	"・",
	"･",
	"٫",
]);
const COMMA_LIKE = new Set([",", "،", "٬", "‚", "，", "﹐"]);
const COLON_LIKE = new Set([":", "∶", "꞉", "⁚", "⁝", "⁞", "﹕"]);
const SEMICOLON_LIKE = new Set([";", "；", "﹔"]);
const SLASH_LIKE = new Set(["/", "⁄", "∕", "⧸", "／"]);
const BACKSLASH_LIKE = new Set(["\\", "⧹", "＼"]);
const OPEN_LIKE = new Set(["(", "[", "{", "⟨", "〈", "《", "「", "『", "【"]);
const CLOSE_LIKE = new Set([")", "]", "}", "⟩", "〉", "》", "」", "』", "】"]);
const MARK_OR_FORMAT = /^(?:\p{M}|\p{Cf})$/u;
const SPACE = /^(?:\p{Z}|\s)$/u;
const DASH = /^\p{Pd}$/u;
const PUNCTUATION_OR_SYMBOL = /^(?:\p{P}|\p{S})$/u;
const SOURCE_IGNORED_BY_SCAN = /^(?:\p{M}|\p{Cf})$/u;

const PHONE_CANDIDATE =
	/(?:\+[ ().,:;/\\[\]{}-]*|(?<![\p{L}\p{N}]))[0-9](?:[0-9 ().,:;/\\[\]{}-]*[0-9])?(?:[\p{L}_][\p{L}\p{N}_]*)?(?: *%)?/gu;
const GROUPED_NUMBER = /^[0-9]{1,3}(?:[ ,][0-9]{3})+(?:[.,][0-9]{1,2})?$/u;
const DECIMAL_NUMBER = /^[0-9]+[.,][0-9]{1,2}$/u;
const CALENDAR_DATE_SOURCE = `(?:[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{2,4}|[0-9]{4}[./-][0-9]{1,2}[./-][0-9]{1,2})`;
const CLOCK_TIME_SOURCE = `(?:[01]?[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.,][0-9]{1,6})?)?`;
const DATE_OR_TIME_ITEM_SOURCE = `(?:${CALENDAR_DATE_SOURCE}(?:[T, ]+${CLOCK_TIME_SOURCE})?|${CLOCK_TIME_SOURCE}(?:[ ]+${CALENDAR_DATE_SOURCE})?)`;
const DATE_OR_TIME_SEQUENCE = new RegExp(`^${DATE_OR_TIME_ITEM_SOURCE}$`, "u");
const DATE_OR_TIME_LIST_PREFIX = new RegExp(
	`^${DATE_OR_TIME_ITEM_SOURCE}(?:[ ]*[,;][ ]*${DATE_OR_TIME_ITEM_SOURCE})*`,
	"u",
);
const DATE_OR_TIME_RANGE = new RegExp(
	`^(?:${CALENDAR_DATE_SOURCE}|${CLOCK_TIME_SOURCE})[ ]*-[ ]*(?:${CALENDAR_DATE_SOURCE}|${CLOCK_TIME_SOURCE})$`,
	"u",
);
const NUMBER_RANGE =
	/^[0-9]+(?:[.,][0-9]{1,2})?[ ]*-[ ]*[0-9]+(?:[.,][0-9]{1,2})?$/u;
const PERCENTAGE =
	/^(?:[0-9]+[.,][0-9]{1,2}|[0-9]{1,3}(?:[ ,][0-9]{3})*|[0-9]+)[ ]*%$/u;
const CASE_NUMBER_PREFIX =
	/(?:(?:^|[^\p{L}])(?:дело|кейс|заявк[аи]|заказ|тикет|обращение|сч[её]т)\s*(?:No|№|#|N)?|[№#])\s*$/iu;
const PHONE_CONTEXT_PREFIX =
	/(?:тел(?:ефон)?|номер(?:а|у|ом)?|моб(?:ильный)?|phone|telephone|mobile|call|контакт)\s*(?::|;|#|№|-)?\s*$/iu;

interface ScanView {
	text: string;
	starts: number[];
	ends: number[];
}

function decimalDigit(character: string): number | null {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return null;
	for (const zero of UNICODE_DECIMAL_ZEROES) {
		if (codePoint >= zero && codePoint <= zero + 9) return codePoint - zero;
	}
	return null;
}

function normalizeScanCharacter(character: string): string {
	const digit = decimalDigit(character);
	if (digit !== null) return String(digit);
	if (MARK_OR_FORMAT.test(character)) return "";
	if (SPACE.test(character)) return " ";
	if (PLUS_LIKE.has(character)) return "+";
	if (character === "%" || character === "#") return character;
	if (DOT_LIKE.has(character)) return ".";
	if (COMMA_LIKE.has(character)) return ",";
	if (COLON_LIKE.has(character)) return ":";
	if (SEMICOLON_LIKE.has(character)) return ";";
	if (SLASH_LIKE.has(character)) return "/";
	if (BACKSLASH_LIKE.has(character)) return "\\";
	if (OPEN_LIKE.has(character)) return "(";
	if (CLOSE_LIKE.has(character)) return ")";
	if (DASH.test(character) || PUNCTUATION_OR_SYMBOL.test(character)) return "-";
	return character;
}

function createScanView(input: string): ScanView | null {
	if (input.length > PHONE_SCAN_MAX_INPUT_CODE_UNITS) return null;
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let sourceOffset = 0;
	let codePoints = 0;
	for (const sourceCharacter of input) {
		codePoints += 1;
		if (codePoints > PHONE_SCAN_MAX_INPUT_CODE_POINTS) return null;
		const sourceCodePoint = sourceCharacter.codePointAt(0);
		if (
			sourceCodePoint === undefined ||
			(sourceCodePoint >= 0xd800 && sourceCodePoint <= 0xdfff)
		) {
			return null;
		}
		let mapped = "";
		for (const normalizedCharacter of sourceCharacter.normalize("NFKC")) {
			mapped += normalizeScanCharacter(normalizedCharacter);
			if (mapped.length > PHONE_SCAN_MAX_CODE_POINT_EXPANSION) return null;
		}
		if (text.length + mapped.length > PHONE_SCAN_MAX_NORMALIZED_CODE_UNITS) {
			return null;
		}
		text += mapped;
		for (let index = 0; index < mapped.length; index += 1) {
			starts.push(sourceOffset);
			ends.push(sourceOffset + sourceCharacter.length);
		}
		sourceOffset += sourceCharacter.length;
	}
	return { text, starts, ends };
}

function includeAdjacentIgnoredSource(
	input: string,
	start: number,
	end: number,
): PhoneLikeRegion {
	let expandedStart = start;
	const preceding = [...input.slice(0, start)];
	for (let index = preceding.length - 1; index >= 0; index -= 1) {
		const character = preceding[index];
		if (character === undefined || !SOURCE_IGNORED_BY_SCAN.test(character))
			break;
		expandedStart -= character.length;
	}
	let expandedEnd = end;
	for (const character of input.slice(end)) {
		if (!SOURCE_IGNORED_BY_SCAN.test(character)) break;
		expandedEnd += character.length;
	}
	return { start: expandedStart, end: expandedEnd };
}

function isPhoneLikeCandidate(
	value: string,
	input: string,
	start: number,
): boolean {
	const normalized = value.trim();
	const firstSuffix = normalized.search(/[\p{L}_]/u);
	const numericPart =
		firstSuffix < 0 ? normalized : normalized.slice(0, firstSuffix);
	const digitCount = [...numericPart].filter((character) =>
		/[0-9]/u.test(character),
	).length;
	if (digitCount < 7) return false;

	const ordinaryDateTimePrefix = input
		.slice(start)
		.match(DATE_OR_TIME_LIST_PREFIX)?.[0];
	if (
		DATE_OR_TIME_SEQUENCE.test(normalized) ||
		(ordinaryDateTimePrefix !== undefined &&
			ordinaryDateTimePrefix.length >= normalized.length) ||
		DATE_OR_TIME_RANGE.test(normalized)
	) {
		return false;
	}

	// Long arbitrary numeric material is private by default. Narrow business
	// controls below apply only to plausible scalar values and identifiers.
	if (digitCount > 15) return true;
	const prefix = input.slice(0, start);
	const explicitPhoneContext =
		normalized.startsWith("+") || PHONE_CONTEXT_PREFIX.test(prefix);
	if (explicitPhoneContext && digitCount >= 8) return true;
	if (
		GROUPED_NUMBER.test(normalized) ||
		DECIMAL_NUMBER.test(normalized) ||
		NUMBER_RANGE.test(normalized) ||
		PERCENTAGE.test(normalized)
	) {
		return false;
	}
	if (
		!normalized.startsWith("+") &&
		CASE_NUMBER_PREFIX.test(prefix) &&
		digitCount <= 15
	) {
		return false;
	}
	return true;
}

/**
 * Detect phone-like material through a bounded normalization-only scan view.
 * Returned offsets always address whole UTF-16 spans in the untouched input;
 * normalized text and PII are never returned. Any scan failure is fail-closed.
 */
export function scanPhoneLikeText(input: string): PhoneLikeScanResult {
	const view = createScanView(input);
	if (view === null) return { overflow: true, regions: [] };
	const regions: PhoneLikeRegion[] = [];
	PHONE_CANDIDATE.lastIndex = 0;
	for (const match of view.text.matchAll(PHONE_CANDIDATE)) {
		if (!isPhoneLikeCandidate(match[0], view.text, match.index)) continue;
		const normalizedEnd = match.index + match[0].length;
		const mappedStart = view.starts[match.index];
		const mappedEnd = view.ends[normalizedEnd - 1];
		if (
			mappedStart === undefined ||
			mappedEnd === undefined ||
			mappedStart < 0 ||
			mappedEnd <= mappedStart ||
			mappedEnd > input.length
		) {
			return { overflow: true, regions: [] };
		}
		const { start: sourceStart, end: sourceEnd } = includeAdjacentIgnoredSource(
			input,
			mappedStart,
			mappedEnd,
		);
		const previous = regions.at(-1);
		if (previous && sourceStart <= previous.end) {
			previous.end = Math.max(previous.end, sourceEnd);
		} else {
			regions.push({ start: sourceStart, end: sourceEnd });
			if (regions.length > PHONE_SCAN_MAX_CANDIDATES) {
				return { overflow: true, regions: [] };
			}
		}
	}
	return { overflow: false, regions };
}

/** Eval-friendly boolean with the same fail-closed behavior as runtime. */
export function containsPhoneLikeText(input: string): boolean {
	const result = scanPhoneLikeText(input);
	return result.overflow || result.regions.length > 0;
}

/**
 * Return the source offset of a suffix that may still become phone-like when
 * more model text arrives. This is deliberately conservative: callers use it
 * only to keep a short-lived streaming suffix out of a provider-bound phrase.
 */
export function trailingPhoneLikeHoldbackStart(input: string): number | null {
	const view = createScanView(input);
	if (view === null) return 0;
	const originalEnd = view.text.length;
	const prospective = `${view.text}00000000`;
	PHONE_CANDIDATE.lastIndex = 0;
	for (const match of prospective.matchAll(PHONE_CANDIDATE)) {
		const normalizedEnd = match.index + match[0].length;
		if (match.index >= originalEnd || normalizedEnd <= originalEnd) continue;
		const sourceStart = view.starts[match.index];
		return sourceStart === undefined ? 0 : sourceStart;
	}
	return null;
}

/** Source offsets whose NFKC scan characters separate two normalized digits. */
export function phoneLikeNumericSeparatorOffsets(
	input: string,
): ReadonlySet<number> | null {
	const view = createScanView(input);
	if (view === null) return null;
	const offsets = new Set<number>();
	for (let index = 1; index + 1 < view.text.length; index += 1) {
		if (
			/[0-9]/u.test(view.text[index - 1] ?? "") &&
			!/[0-9]/u.test(view.text[index] ?? "") &&
			/[0-9]/u.test(view.text[index + 1] ?? "")
		) {
			const sourceOffset = view.starts[index];
			if (sourceOffset !== undefined) offsets.add(sourceOffset);
		}
	}
	return offsets;
}

/**
 * Return the source end of a leading numeric/separator run using the exact
 * NFKC character mapping used by the phone detector. Streaming callers use
 * this only after a bounded fail-closed redaction to discard continuation
 * fragments until ordinary text terminates the protected run.
 */
export function phoneLikeStreamingRunPrefixEnd(input: string): number {
	let sourceEnd = 0;
	for (const sourceCharacter of input) {
		let mapped = "";
		for (const normalizedCharacter of sourceCharacter.normalize("NFKC")) {
			mapped += normalizeScanCharacter(normalizedCharacter);
			if (mapped.length > PHONE_SCAN_MAX_CODE_POINT_EXPANSION)
				return input.length;
		}
		if (!/^[0-9 ().,:;/\\[\]{}+-]*$/u.test(mapped)) break;
		sourceEnd += sourceCharacter.length;
	}
	return sourceEnd;
}
