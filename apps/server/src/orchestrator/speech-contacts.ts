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
const EMAIL_CANDIDATE =
	/(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~@-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?![\p{L}\p{N}-])/giu;
const PHONE_CANDIDATE =
	/(?<![\p{L}\p{N}])(?:\+[\p{Zs}\t]*)?[\p{Nd}](?:[\p{Nd}\p{Zs}\t().,/\\‐‑‒–—―−\u200B-\u200D\u2060\uFEFF-]*[\p{Nd}])?(?![\p{L}\p{N}])/gu;
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
const ALLOWED_PHONE = /^[+\p{Nd}\p{Zs}\t().\-‐‑‒–—―−]+$/u;
const GROUPED_NUMBER =
	/^\p{Nd}{1,3}(?:[\p{Zs}\t,]\p{Nd}{3})+(?:[.,]\p{Nd}{1,2})?$/u;
const DECIMAL_NUMBER = /^\p{Nd}+[.,]\p{Nd}{1,2}$/u;
const CALENDAR_DATE =
	/^(?:\p{Nd}{1,2}[./-]\p{Nd}{1,2}[./-]\p{Nd}{2,4}|\p{Nd}{4}[./-]\p{Nd}{1,2}[./-]\p{Nd}{1,2})$/u;

interface Region {
	start: number;
	end: number;
}

interface Candidate extends Region {
	channel?: SpeechContactChannel;
	canonical?: string | undefined;
	spoken?: string | undefined;
}

const UNICODE_DECIMAL_ZEROS = [
	0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
	0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
	0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
	0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
	0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0,
	0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50,
	0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0, 0x16b50,
] as const;

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
export function isPhoneLikeSpeechCandidate(value: string): boolean {
	const normalized = value.normalize("NFKC").trim();
	const digitCount = [...normalized].filter((character) =>
		/\p{Nd}/u.test(character),
	).length;
	if (digitCount < 7 || digitCount > 15) return false;
	if (
		CALENDAR_DATE.test(normalized) ||
		GROUPED_NUMBER.test(normalized) ||
		DECIMAL_NUMBER.test(normalized)
	) {
		return false;
	}
	return true;
}

function decimalDigit(character: string): string | null {
	const normalized = character.normalize("NFKC");
	if (/^[0-9]$/u.test(normalized)) return normalized;
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return null;
	for (const zero of UNICODE_DECIMAL_ZEROS) {
		if (codePoint >= zero && codePoint <= zero + 9) {
			return String(codePoint - zero);
		}
	}
	if (codePoint >= 0x1d7ce && codePoint <= 0x1d7ff) {
		return String((codePoint - 0x1d7ce) % 10);
	}
	return null;
}

function canonicalPhone(value: string): string | null {
	const normalized = value.normalize("NFKC").trim();
	if (!ALLOWED_PHONE.test(normalized)) return null;
	const plus = normalized.startsWith("+");
	if (normalized.slice(1).includes("+")) return null;
	let digits = "";
	for (const character of normalized) {
		if (!/\p{Nd}/u.test(character)) continue;
		const digit = decimalDigit(character);
		if (digit === null) return null;
		digits += digit;
	}
	if (digits.length !== 11) return null;
	if (plus && !digits.startsWith("7")) return null;
	if (digits.startsWith("8")) return `7${digits.slice(1)}`;
	return digits.startsWith("7") ? digits : null;
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

function speakPhone(canonical: string): string {
	const groups = [
		canonical.slice(1, 4),
		canonical.slice(4, 7),
		canonical.slice(7, 9),
		canonical.slice(9, 11),
	];
	return `плюс семь, ${groups.map(speakNumberGroup).join(", ")}`;
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
	for (const match of text.matchAll(PHONE_CANDIDATE)) {
		if (!isPhoneLikeSpeechCandidate(match[0])) continue;
		const canonical = canonicalPhone(match[0]);
		pushCandidate(
			candidates,
			{
				start: match.index,
				end: match.index + match[0].length,
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
