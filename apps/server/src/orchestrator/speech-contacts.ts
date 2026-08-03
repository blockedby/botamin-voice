export type SpeechContactChannel = "email" | "phone" | "telegram";

export interface ApprovedSpeechContact {
	channel: SpeechContactChannel;
	value: string;
}

export interface MarkedSpeechContact {
	channel: SpeechContactChannel;
	marker: string;
	spoken: string;
}

export interface MarkedSpeechContacts {
	text: string;
	contacts: readonly MarkedSpeechContact[];
}

export const MAX_APPROVED_SPEECH_CONTACTS = 3;

const CONTACT_REDACTION = "контакт скрыт";
const PRIVATE_USE = /[\uE000-\uF8FF]/gu;
const MAX_PHONE_DETECTION_CODE_UNITS = 16_384;
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
const PHONE_MUTATION_MAP = new Map<string, string>([
	["＋", "+"],
	["：", ":"],
	["；", ";"],
	["∶", ":"],
	["．", "."],
	["。", "."],
	["․", "."],
	["‥", "."],
	["⁚", ":"],
	["⁝", ":"],
	["⁞", ":"],
	["꞉", ":"],
	["﹕", ":"],
	["﹔", ";"],
	["﹒", "."],
	["·", "."],
	["•", "."],
	["‣", "."],
	["∙", "."],
	["⋅", "."],
	["◦", "."],
	["▪", "."],
	["▫", "."],
	["●", "."],
	["○", "."],
	["・", "."],
	["･", "."],
	["，", ","],
	["﹐", ","],
	["٫", "."],
	["٬", ","],
	["／", "/"],
	["⁄", "/"],
	["∕", "/"],
	["＼", "\\"],
	["％", "%"],
	["（", "("],
	["）", ")"],
	["［", "["],
	["］", "]"],
	["｛", "{"],
	["｝", "}"],
]);
const UNICODE_DASH = /^\p{Pd}$/u;

function decimalDigit(character: string): number | null {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return null;
	for (const zero of UNICODE_DECIMAL_ZEROES) {
		if (codePoint >= zero && codePoint <= zero + 9) return codePoint - zero;
	}
	return null;
}

interface PhoneDetectionText {
	text: string;
	starts: number[];
	ends: number[];
}

/** Normalize only the bounded phone alphabet; approval still uses the original text. */
function normalizePhoneDetection(input: string): PhoneDetectionText | null {
	if (input.length > MAX_PHONE_DETECTION_CODE_UNITS) return null;
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let sourceOffset = 0;
	for (const character of input) {
		const digit = decimalDigit(character);
		const mapped =
			digit !== null
				? String(digit)
				: (PHONE_MUTATION_MAP.get(character) ??
					(UNICODE_DASH.test(character) ? "-" : character));
		text += mapped;
		for (let index = 0; index < mapped.length; index += 1) {
			starts.push(sourceOffset);
			ends.push(sourceOffset + character.length);
		}
		sourceOffset += character.length;
	}
	return { text, starts, ends };
}
const EMAIL_CANDIDATE =
	/(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~@-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?![\p{L}\p{N}-])/giu;
export const PHONE_LIKE_SPEECH_CANDIDATE_SOURCE = String.raw`(?<![\p{L}\p{N}])(?:\+[\p{Z}\s\p{Cf}]*)?[\p{Nd}](?:[\p{Nd}\p{Z}\s\p{Cf}().,:;\/\\（）\[\]{}‐‑‒–—―−·•‣∙⋅◦▪▫●○-]*[\p{Nd}])?(?:[\p{L}_][\p{L}\p{N}_]*)?(?:\s*%)?`;
const PHONE_CANDIDATE = new RegExp(PHONE_LIKE_SPEECH_CANDIDATE_SOURCE, "gu");
const PHONE_EXTENSION = /^\s*(?:доб\.?|ext\.?)\s*\p{Nd}+/iu;
const TELEGRAM_MENTION =
	/(?<![\p{L}\p{N}_@])@[a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9](?![a-zA-Z0-9_])/gu;
const TELEGRAM_URL =
	/(?<![\p{L}\p{N}.-])(?:(?:https?:\/\/|www\.)?t\.me\/[^\s<>()]*[\p{L}\p{N}_/#])(?![\p{L}\p{N}_/?#])/giu;
const RAW_URL = /(?:https?:\/\/|www\.)[^\s<>()]*[\p{L}\p{N}/#]/giu;
const DOMAIN_ONLY =
	/(?<![@\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?![\p{L}\p{N}-])/giu;
const MARKDOWN_LINK = /\[[^\x5d]+\]\(\s*(?:https?:\/\/|www\.)[^)]+\)/giu;
const EMAIL_LOCAL = /^[\p{L}\p{N}]+(?:[._+-][\p{L}\p{N}]+)*$/u;
const DOMAIN =
	/^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u;
const TELEGRAM_USERNAME = /^[a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9]$/u;
const INTERNATIONAL_PHONE = /^\+[1-9][0-9]*(?:[ -][0-9]+)*$/u;
const INTERNATIONAL_PHONE_WITH_AREA =
	/^\+[1-9][0-9]{0,2} ?\([0-9]{2,5}\)(?:[ -][0-9]+)+$/u;
const GROUPED_NUMBER =
	/^\p{Nd}{1,3}(?:[\p{Z}\s,]\p{Nd}{3})+(?:[.,]\p{Nd}{1,2})?$/u;
const DECIMAL_NUMBER = /^\p{Nd}+[.,]\p{Nd}{1,2}$/u;
const CALENDAR_DATE_SOURCE = String.raw`(?:\p{Nd}{1,2}[./-]\p{Nd}{1,2}[./-]\p{Nd}{2,4}|\p{Nd}{4}[./-]\p{Nd}{1,2}[./-]\p{Nd}{1,2})`;
const CLOCK_TIME_SOURCE = String.raw`(?:[01]?\p{Nd}|2[0-3]):[0-5]\p{Nd}(?::[0-5]\p{Nd}(?:[.,]\p{Nd}{1,6})?)?`;
const CALENDAR_DATE = new RegExp(`^${CALENDAR_DATE_SOURCE}$`, "u");
const DATE_OR_TIME_ITEM_SOURCE = String.raw`(?:${CALENDAR_DATE_SOURCE}(?:[T,\p{Z}\s]+${CLOCK_TIME_SOURCE})?|${CLOCK_TIME_SOURCE}(?:[\p{Z}\s]+${CALENDAR_DATE_SOURCE})?)`;
const DATE_OR_TIME_SEQUENCE = new RegExp(`^${DATE_OR_TIME_ITEM_SOURCE}$`, "u");
const DATE_OR_TIME_LIST_PREFIX = new RegExp(
	String.raw`^${DATE_OR_TIME_ITEM_SOURCE}(?:[\p{Z}\s]*[,;][\p{Z}\s]*${DATE_OR_TIME_ITEM_SOURCE})*`,
	"u",
);
const DATE_OR_TIME_RANGE = new RegExp(
	String.raw`^(?:${CALENDAR_DATE_SOURCE}|${CLOCK_TIME_SOURCE})[\p{Z}\s]*(?:-|‐|‑|‒|–|—|―|−)[\p{Z}\s]*(?:${CALENDAR_DATE_SOURCE}|${CLOCK_TIME_SOURCE})$`,
	"u",
);
const NUMBER_RANGE =
	/^\p{Nd}+(?:[.,]\p{Nd}{1,2})?[\p{Z}\s]*(?:-|‐|‑|‒|–|—|―|−)[\p{Z}\s]*\p{Nd}+(?:[.,]\p{Nd}{1,2})?$/u;
const PERCENTAGE =
	/^(?:\p{Nd}+[.,]\p{Nd}{1,2}|\p{Nd}{1,3}(?:[\p{Z}\s,]\p{Nd}{3})*|\p{Nd}+)[\p{Z}\s]*%$/u;
const CASE_NUMBER_PREFIX =
	/(?:(?:^|[^\p{L}])(?:дело|кейс|заявк[аи]|заказ|тикет|обращение|сч[её]т)\s*(?:№|#|N)?|[№#])\s*$/iu;

interface PhoneCandidateContext {
	input: string;
	start: number;
}

interface Region {
	start: number;
	end: number;
}

interface Candidate extends Region {
	channel?: SpeechContactChannel;
	canonical?: string | undefined;
	spoken?: string | undefined;
}

function regions(pattern: RegExp, text: string): Region[] {
	pattern.lastIndex = 0;
	return [...text.matchAll(pattern)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

function overlaps(region: Region, others: readonly Region[]): boolean {
	return others.some(
		(other) => region.start < other.end && region.end > other.start,
	);
}

function markdownDestinationRegions(text: string): Region[] {
	MARKDOWN_LINK.lastIndex = 0;
	const result: Region[] = [];
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		const destinationOffset = match[0].indexOf("](") + 2;
		result.push({
			start: match.index + destinationOffset,
			end: match.index + match[0].length - 1,
		});
	}
	return result;
}

function canonicalEmail(value: string): string | null {
	const normalized = value.normalize("NFKC");
	const separator = normalized.lastIndexOf("@");
	if (separator <= 0 || separator !== normalized.indexOf("@")) return null;
	const local = normalized.slice(0, separator);
	const domain = normalized.slice(separator + 1);
	if (
		normalized.length > 254 ||
		local.length > 64 ||
		!EMAIL_LOCAL.test(local) ||
		!DOMAIN.test(domain)
	) {
		return null;
	}
	return `${local}@${domain.toLowerCase()}`;
}

/** Conservative residual detector used only after exact approved contacts are marked. */
export function isPhoneLikeSpeechCandidate(
	value: string,
	context?: PhoneCandidateContext,
): boolean {
	const normalized = value.normalize("NFKC").trim();
	const firstSuffix = normalized.search(/[\p{L}_]/u);
	const numericPart =
		firstSuffix < 0 ? normalized : normalized.slice(0, firstSuffix);
	const digitCount = [...numericPart].filter((character) =>
		/\p{Nd}/u.test(character),
	).length;
	if (digitCount < 7) return false;
	const ordinaryDateTimePrefix = context
		? context.input
				.slice(context.start)
				.normalize("NFKC")
				.match(DATE_OR_TIME_LIST_PREFIX)?.[0]
		: undefined;
	if (
		CALENDAR_DATE.test(normalized) ||
		DATE_OR_TIME_SEQUENCE.test(normalized) ||
		(ordinaryDateTimePrefix !== undefined &&
			ordinaryDateTimePrefix.length >= normalized.length) ||
		DATE_OR_TIME_RANGE.test(normalized) ||
		GROUPED_NUMBER.test(normalized) ||
		DECIMAL_NUMBER.test(normalized) ||
		NUMBER_RANGE.test(normalized) ||
		PERCENTAGE.test(normalized)
	) {
		return false;
	}
	if (
		context &&
		!normalized.startsWith("+") &&
		CASE_NUMBER_PREFIX.test(context.input.slice(0, context.start))
	) {
		return false;
	}
	return true;
}

/** Redacts residual phone-like text using the bounded normalized shadow. */
export function redactPhoneLikeSpeechCandidates(input: string): string {
	const detection = normalizePhoneDetection(input);
	if (detection === null) return CONTACT_REDACTION;
	const candidates: Region[] = [];
	PHONE_CANDIDATE.lastIndex = 0;
	for (const match of detection.text.matchAll(PHONE_CANDIDATE)) {
		const detectionStart = match.index;
		const detectionEnd = detectionStart + match[0].length;
		const sourceStart = detection.starts[detectionStart];
		const sourceEnd = detection.ends[detectionEnd - 1];
		if (sourceStart === undefined || sourceEnd === undefined) continue;
		if (
			!isPhoneLikeSpeechCandidate(match[0], {
				input: detection.text,
				start: detectionStart,
			})
		) {
			continue;
		}
		const extension = input.slice(sourceEnd).match(PHONE_EXTENSION)?.[0] ?? "";
		candidates.push({ start: sourceStart, end: sourceEnd + extension.length });
	}
	let output = "";
	let cursor = 0;
	for (const candidate of candidates) {
		output += input.slice(cursor, candidate.start);
		output += CONTACT_REDACTION;
		cursor = candidate.end;
	}
	return output + input.slice(cursor);
}

function canonicalPhone(value: string): string | null {
	const normalized = value.trim();
	if (
		!INTERNATIONAL_PHONE.test(normalized) &&
		!INTERNATIONAL_PHONE_WITH_AREA.test(normalized)
	) {
		return null;
	}
	const digits = normalized.replace(/[^0-9]/gu, "");
	return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function telegramUsername(value: string): string | null {
	const normalized = value.normalize("NFKC").trim();
	let username: string | undefined;
	if (normalized.startsWith("@")) username = normalized.slice(1);
	else {
		const match = normalized.match(
			/^(?:(?:https?:\/\/|www\.)?t\.me\/)([a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9])\/?$/iu,
		);
		username = match?.[1];
	}
	return username &&
		TELEGRAM_USERNAME.test(username) &&
		!username.includes("__")
		? username.toLowerCase()
		: null;
}

function canonicalContact(contact: ApprovedSpeechContact): string | null {
	if (typeof contact.value !== "string") return null;
	if (contact.channel === "email") {
		const value = canonicalEmail(contact.value);
		return value === null ? null : `email:${value}`;
	}
	if (contact.channel === "phone") {
		const value = canonicalPhone(contact.value);
		return value === null ? null : `phone:${value}`;
	}
	if (contact.channel === "telegram") {
		const value = telegramUsername(contact.value);
		return value === null ? null : `telegram:${value}`;
	}
	return null;
}

function speakEmail(value: string): string {
	return value
		.normalize("NFKC")
		.replaceAll("@", " собака ")
		.replaceAll(".", " точка ")
		.replaceAll("+", " плюс ")
		.replaceAll("-", " дефис ")
		.replaceAll("_", " подчёркивание ")
		.replace(/\s+/gu, " ")
		.trim();
}

const ONES = [
	"ноль",
	"один",
	"два",
	"три",
	"четыре",
	"пять",
	"шесть",
	"семь",
	"восемь",
	"девять",
] as const;
const TEENS = [
	"десять",
	"одиннадцать",
	"двенадцать",
	"тринадцать",
	"четырнадцать",
	"пятнадцать",
	"шестнадцать",
	"семнадцать",
	"восемнадцать",
	"девятнадцать",
] as const;
const TENS = [
	"",
	"",
	"двадцать",
	"тридцать",
	"сорок",
	"пятьдесят",
	"шестьдесят",
	"семьдесят",
	"восемьдесят",
	"девяносто",
] as const;
const HUNDREDS = [
	"",
	"сто",
	"двести",
	"триста",
	"четыреста",
	"пятьсот",
	"шестьсот",
	"семьсот",
	"восемьсот",
	"девятьсот",
] as const;

function speakNumberGroup(group: string): string {
	if (group.startsWith("0")) {
		return [...group].map((digit) => ONES[Number(digit)]).join(" ");
	}
	const value = Number(group);
	const words: string[] = [];
	if (value >= 100) words.push(HUNDREDS[Math.floor(value / 100)] ?? "");
	const remainder = value % 100;
	if (remainder >= 10 && remainder < 20)
		words.push(TEENS[remainder - 10] ?? "");
	else {
		if (remainder >= 20) words.push(TENS[Math.floor(remainder / 10)] ?? "");
		if (remainder % 10 > 0) words.push(ONES[remainder % 10] ?? "");
	}
	return words.filter(Boolean).join(" ");
}

function internationalPhoneGroups(canonical: string): string[] {
	const countryLength =
		canonical.startsWith("1") || canonical.startsWith("7") ? 1 : 2;
	const groups = [canonical.slice(0, countryLength)];
	let local = canonical.slice(countryLength);
	while (local.length > 4) {
		groups.push(local.slice(0, 3));
		local = local.slice(3);
	}
	if (local.length === 4) groups.push(local.slice(0, 2), local.slice(2));
	else if (local) groups.push(local);
	return groups;
}

function speakPhone(canonical: string): string {
	if (canonical.startsWith("7") && canonical.length === 11) {
		const groups = [
			canonical.slice(1, 4),
			canonical.slice(4, 7),
			canonical.slice(7, 9),
			canonical.slice(9, 11),
		];
		return `плюс семь, ${groups.map(speakNumberGroup).join(", ")}`;
	}
	return `плюс ${internationalPhoneGroups(canonical)
		.map(speakNumberGroup)
		.join(", ")}`;
}

function pushCandidate(
	candidates: Candidate[],
	candidate: Candidate,
	blocked: readonly Region[],
): void {
	if (!overlaps(candidate, blocked) && !overlaps(candidate, candidates)) {
		candidates.push(candidate);
	}
}

/** Replaces only exact approved contacts with opaque markers before sanitizing. */
export function markApprovedSpeechContacts(
	input: string,
	approvedContacts: readonly ApprovedSpeechContact[],
): MarkedSpeechContacts {
	const text = input.replace(PRIVATE_USE, "");
	const phoneDetection = normalizePhoneDetection(text);
	if (phoneDetection === null) {
		return { text: CONTACT_REDACTION, contacts: [] };
	}
	const approved = new Set(
		approvedContacts.map(canonicalContact).filter((value) => value !== null),
	);
	const candidates: Candidate[] = [];
	const hiddenMarkdown = markdownDestinationRegions(text);
	const rawUrls = regions(RAW_URL, text);

	TELEGRAM_URL.lastIndex = 0;
	for (const match of text.matchAll(TELEGRAM_URL)) {
		const canonical = telegramUsername(match[0]);
		const username =
			canonical === null ? undefined : match[0].match(/\/([^/]+)\/?$/u)?.[1];
		const candidate: Candidate = {
			start: match.index,
			end: match.index + match[0].length,
			channel: "telegram",
			canonical: canonical === null ? undefined : `telegram:${canonical}`,
			spoken: username === undefined ? undefined : `собака ${username}`,
		};
		pushCandidate(candidates, candidate, hiddenMarkdown);
	}

	EMAIL_CANDIDATE.lastIndex = 0;
	for (const match of text.matchAll(EMAIL_CANDIDATE)) {
		const canonical = canonicalEmail(match[0]);
		pushCandidate(
			candidates,
			{
				start: match.index,
				end: match.index + match[0].length,
				channel: "email",
				canonical: canonical === null ? undefined : `email:${canonical}`,
				spoken: canonical === null ? undefined : speakEmail(match[0]),
			},
			[...hiddenMarkdown, ...rawUrls],
		);
	}

	PHONE_CANDIDATE.lastIndex = 0;
	for (const match of phoneDetection.text.matchAll(PHONE_CANDIDATE)) {
		const detectionStart = match.index;
		const detectionEnd = match.index + match[0].length;
		const sourceStart = phoneDetection.starts[detectionStart];
		const sourceEnd = phoneDetection.ends[detectionEnd - 1];
		if (sourceStart === undefined || sourceEnd === undefined) continue;
		const sourceCandidate = text.slice(sourceStart, sourceEnd);
		if (
			!isPhoneLikeSpeechCandidate(match[0], {
				input: phoneDetection.text,
				start: detectionStart,
			})
		) {
			continue;
		}
		const extension = text.slice(sourceEnd).match(PHONE_EXTENSION)?.[0] ?? "";
		const next = text[sourceEnd + extension.length] ?? "";
		const canonical =
			extension || /[\p{L}\p{N}]/u.test(next) || sourceCandidate !== match[0]
				? null
				: canonicalPhone(sourceCandidate);
		pushCandidate(
			candidates,
			{
				start: sourceStart,
				end: sourceEnd + extension.length,
				channel: "phone",
				canonical: canonical === null ? undefined : `phone:${canonical}`,
				spoken: canonical === null ? undefined : speakPhone(canonical),
			},
			[...hiddenMarkdown, ...rawUrls],
		);
	}

	TELEGRAM_MENTION.lastIndex = 0;
	for (const match of text.matchAll(TELEGRAM_MENTION)) {
		const username = match[0].slice(1);
		pushCandidate(
			candidates,
			{
				start: match.index,
				end: match.index + match[0].length,
				channel: "telegram",
				canonical: `telegram:${username.toLowerCase()}`,
				spoken: `собака ${username}`,
			},
			[...hiddenMarkdown, ...rawUrls],
		);
	}

	DOMAIN_ONLY.lastIndex = 0;
	for (const match of text.matchAll(DOMAIN_ONLY)) {
		pushCandidate(
			candidates,
			{ start: match.index, end: match.index + match[0].length },
			[...hiddenMarkdown, ...rawUrls],
		);
	}

	candidates.sort((left, right) => left.start - right.start);
	let output = "";
	let cursor = 0;
	const marked: MarkedSpeechContact[] = [];
	for (const candidate of candidates) {
		output += text.slice(cursor, candidate.start);
		if (
			candidate.channel &&
			candidate.canonical &&
			candidate.spoken &&
			approved.has(candidate.canonical)
		) {
			const marker = `\uE000одобренныйконтакт${marked.length}\uE001`;
			output += marker;
			marked.push({
				channel: candidate.channel,
				marker,
				spoken: candidate.spoken,
			});
		} else output += CONTACT_REDACTION;
		cursor = candidate.end;
	}
	output += text.slice(cursor);
	return { text: output, contacts: marked };
}
