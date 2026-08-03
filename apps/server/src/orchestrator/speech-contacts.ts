import { scanPhoneLikeText } from "@botamin/contracts";

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

/** Redacts original source spans selected by the shared bounded scan view. */
export function redactPhoneLikeSpeechCandidates(input: string): string {
	const detection = scanPhoneLikeText(input);
	if (detection.overflow) return CONTACT_REDACTION;
	let output = "";
	let cursor = 0;
	for (const candidate of detection.regions) {
		const extension =
			input.slice(candidate.end).match(PHONE_EXTENSION)?.[0] ?? "";
		output += input.slice(cursor, candidate.start);
		output += CONTACT_REDACTION;
		cursor = candidate.end + extension.length;
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
	const phoneDetection = scanPhoneLikeText(text);
	if (phoneDetection.overflow) {
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

	for (const region of phoneDetection.regions) {
		const sourceCandidate = text.slice(region.start, region.end);
		const extension = text.slice(region.end).match(PHONE_EXTENSION)?.[0] ?? "";
		const next = text[region.end + extension.length] ?? "";
		// Approval is intentionally based only on untouched, strict source text.
		// The shared normalized view can select a span but can never canonicalize it.
		const canonical =
			extension || /[\p{L}\p{N}]/u.test(next)
				? null
				: canonicalPhone(sourceCandidate);
		pushCandidate(
			candidates,
			{
				start: region.start,
				end: region.end + extension.length,
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
