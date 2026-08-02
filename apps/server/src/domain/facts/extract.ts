import { domainToASCII } from "node:url";
import {
	type AcceptedVisitorText,
	type ConversationFactExtractionResult,
	type ConversationFactField,
	type ConversationFactProposal,
	type ConversationIntentIndicators,
	type CountAmount,
	MAX_ACCEPTED_VISITOR_TEXT_LENGTH,
	type MonthlyLeadVolume,
	type SafeFactFieldSummary,
} from "./types";

const MAX_NAME_LENGTH = 120;
const MAX_COMPANY_LENGTH = 160;
const MAX_EMAIL_LENGTH = 254;
const MAX_LEAD_COUNT = 10_000_000;
const MAX_SALES_MANAGER_COUNT = 10_000;

const NO_INTENTS: ConversationIntentIndicators = {
	correction: false,
	confirmation: null,
	alreadyAnswered: false,
};

const UNICODE_DECIMAL_ZEROES = [
	0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66,
	0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810,
	0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
	0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30,
	0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
	0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x16a60,
	0x16ac0, 0x1d7ce, 0x1e140, 0x1e2f0, 0x1e950,
] as const;

function decimalDigit(character: string): number | null {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return null;
	for (const zero of UNICODE_DECIMAL_ZEROES) {
		if (codePoint >= zero && codePoint <= zero + 9) return codePoint - zero;
	}
	return null;
}

function parseDecimalDigits(text: string, maximum: number): number | null {
	let ascii = "";
	for (const character of text) {
		if (/\s/u.test(character)) continue;
		const digit = decimalDigit(character);
		if (digit === null) return null;
		ascii += String(digit);
	}
	if (!ascii || ascii.length > 9) return null;
	const value = Number(ascii);
	return Number.isSafeInteger(value) && value <= maximum ? value : null;
}

function trimSpan(text: string, start: number, end: number) {
	const raw = text.slice(start, end);
	const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
	const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
	const trimmedStart = start + leading;
	const trimmedEnd = Math.max(trimmedStart, end - trailing);
	return {
		start: trimmedStart,
		end: trimmedEnd,
		evidence: text.slice(trimmedStart, trimmedEnd),
	};
}

function addProposal(
	proposals: ConversationFactProposal[],
	proposal: ConversationFactProposal,
): void {
	const key = JSON.stringify([proposal.field, proposal.value]);
	if (
		proposals.some(
			(existing) => JSON.stringify([existing.field, existing.value]) === key,
		)
	) {
		return;
	}
	proposals.push(proposal);
}

const EMAIL_CANDIDATE =
	/(?<![\p{L}\p{N}!#$%&'*+/=?^_`{|}~.@-])([A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,128}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)(?![\p{L}\p{N}_@-])/giu;

function normalizeEmail(candidate: string): string | null {
	if (candidate.length > MAX_EMAIL_LENGTH) return null;
	const separator = candidate.lastIndexOf("@");
	if (separator <= 0) return null;
	let local = candidate.slice(0, separator).toLowerCase();
	const unicodeDomain = candidate.slice(separator + 1).toLowerCase();
	if (
		local.length > 64 ||
		local.startsWith(".") ||
		local.endsWith(".") ||
		local.includes("..")
	) {
		return null;
	}
	if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)) return null;
	let domain = domainToASCII(unicodeDomain).toLowerCase();
	if (!domain || domain.length > 253 || !domain.includes(".")) return null;
	const labels = domain.split(".");
	if (
		labels.some(
			(label) =>
				!label ||
				label.length > 63 ||
				label.startsWith("-") ||
				label.endsWith("-") ||
				!/^[a-z0-9-]+$/u.test(label),
		)
	) {
		return null;
	}
	if (domain === "googlemail.com") domain = "gmail.com";
	if (domain === "gmail.com") {
		local = (local.split("+", 1)[0] ?? "").replaceAll(".", "");
		if (!local) return null;
	}
	const normalized = `${local}@${domain}`;
	return normalized.length <= MAX_EMAIL_LENGTH ? normalized : null;
}

function extractEmails(
	text: string,
	proposals: ConversationFactProposal[],
): void {
	for (const match of text.matchAll(EMAIL_CANDIDATE)) {
		const candidate = match[1];
		if (!candidate) continue;
		const value = normalizeEmail(candidate);
		if (!value) continue;
		const start = (match.index ?? 0) + match[0].indexOf(candidate);
		addProposal(proposals, {
			field: "email",
			value,
			source: {
				start,
				end: start + candidate.length,
				evidence: candidate,
			},
		});
	}
}

const PHONE_CANDIDATE =
	/(?<![\p{L}\p{N}+])((?:\+\s*\p{Nd}|\p{Nd})(?:[\s().\-–—]*\p{Nd}){10})(?![\p{L}\p{Nd}])/gu;

function phoneDigits(candidate: string): string | null {
	let digits = "";
	for (const character of candidate) {
		if (!/\p{Nd}/u.test(character)) continue;
		const digit = decimalDigit(character);
		if (digit === null) return null;
		digits += String(digit);
	}
	return digits;
}

function extractPhones(
	text: string,
	proposals: ConversationFactProposal[],
): void {
	for (const match of text.matchAll(PHONE_CANDIDATE)) {
		const candidate = match[1];
		if (!candidate) continue;
		const digits = phoneDigits(candidate);
		if (
			digits?.length !== 11 ||
			!/[78]/u.test(digits[0] ?? "") ||
			!/[3489]/u.test(digits[1] ?? "")
		) {
			continue;
		}
		const start = (match.index ?? 0) + match[0].indexOf(candidate);
		addProposal(proposals, {
			field: "phone",
			value: `+7${digits.slice(1)}`,
			source: {
				start,
				end: start + candidate.length,
				evidence: candidate,
			},
		});
	}
}

const TELEGRAM_CONTACT =
	/(?<![\p{L}\p{N}_.@+-])((?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]))(?![A-Za-z0-9_/?#])|(?<![\p{L}\p{N}_.@+-])(@([A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]))(?![A-Za-z0-9_])/giu;

function extractTelegram(
	text: string,
	proposals: ConversationFactProposal[],
): void {
	for (const match of text.matchAll(TELEGRAM_CONTACT)) {
		const evidence = match[1] ?? match[3];
		const username = match[2] ?? match[4];
		if (!evidence || !username) continue;
		const start = (match.index ?? 0) + match[0].indexOf(evidence);
		addProposal(proposals, {
			field: "telegram",
			value: `@${username.toLowerCase()}`,
			source: {
				start,
				end: start + evidence.length,
				evidence,
			},
		});
	}
}

function normalizedWhitespace(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
			return true;
		}
	}
	return false;
}

function hasForbiddenIdentityShape(value: string): boolean {
	return (
		hasControlCharacter(value) ||
		/(?:https?:\/\/|www\.|t\.me\/|@)/iu.test(value) ||
		/(?:\+\s*\p{Nd}|\p{Nd})[\p{Nd}\s().\-–—]{6,}/u.test(value)
	);
}

function normalizeName(value: string): string | null {
	const normalized = normalizedWhitespace(value);
	if (
		!normalized ||
		normalized.length > MAX_NAME_LENGTH ||
		!/[\p{L}]/u.test(normalized) ||
		hasForbiddenIdentityShape(normalized) ||
		!/^[\p{L}\p{M}]+(?:[\p{L}\p{M}'’\- ]*[\p{L}\p{M}])?$/u.test(normalized) ||
		normalized.split(" ").length > 6
	) {
		return null;
	}
	return normalized;
}

function normalizeCompany(value: string): string | null {
	const normalized = normalizedWhitespace(value);
	if (
		!normalized ||
		normalized.length > MAX_COMPANY_LENGTH ||
		!/[\p{L}]/u.test(normalized) ||
		hasForbiddenIdentityShape(normalized) ||
		!/^[\p{L}\p{M}\p{N} .,&'’«»"()\-–—]+$/u.test(normalized) ||
		normalized.split(" ").length > 12
	) {
		return null;
	}
	return normalized;
}

const LABELLED_IDENTITY_LINE =
	/^[\p{Zs}\t]*(имя|name|компания|company)[\p{Zs}\t]*[:：=\-–—][\p{Zs}\t]*([^\r\n]*)$/gimu;

function extractLabelledIdentities(
	text: string,
	proposals: ConversationFactProposal[],
): void {
	for (const match of text.matchAll(LABELLED_IDENTITY_LINE)) {
		const label = match[1]?.toLocaleLowerCase("ru-RU");
		const rawValue = match[2];
		if (!label || rawValue === undefined) continue;
		const field = label === "имя" || label === "name" ? "name" : "company";
		const value =
			field === "name" ? normalizeName(rawValue) : normalizeCompany(rawValue);
		if (!value) continue;
		const rawStart = (match.index ?? 0) + match[0].lastIndexOf(rawValue);
		const source = trimSpan(text, rawStart, rawStart + rawValue.length);
		addProposal(proposals, { field, value, source });
	}
}

const NATURAL_NAME_AND_COMPANY =
	/меня\s+зовут\s+([\p{L}\p{M}'’\- ]{1,120}?)\s*[,;]\s*(?:моя\s+)?компания\s+([\p{L}\p{M}\p{N} .,&'’«»"()\-–—]{1,160}?)(?=$|[.!?;\r\n])/gimu;

function extractNaturalIdentity(
	text: string,
	proposals: ConversationFactProposal[],
): void {
	for (const match of text.matchAll(NATURAL_NAME_AND_COMPANY)) {
		const rawName = match[1];
		const rawCompany = match[2];
		if (!rawName || !rawCompany) continue;
		const name = normalizeName(rawName);
		const company = normalizeCompany(rawCompany);
		if (!name || !company) continue;
		const matchStart = match.index ?? 0;
		const nameStart = matchStart + match[0].indexOf(rawName);
		const companyStart = matchStart + match[0].lastIndexOf(rawCompany);
		addProposal(proposals, {
			field: "name",
			value: name,
			source: trimSpan(text, nameStart, nameStart + rawName.length),
		});
		addProposal(proposals, {
			field: "company",
			value: company,
			source: trimSpan(text, companyStart, companyStart + rawCompany.length),
		});
	}
}

const DIGIT_TOKEN = String.raw`\p{Nd}{1,9}`;
const AMOUNT_TOKEN = String.raw`(?:от\s+)?${DIGIT_TOKEN}(?:\s*(?:[-–—]|до)\s*${DIGIT_TOKEN})?`;
const LEAD_WORD = String.raw`(?:входящ(?:ий|их|ие)?\s+)?(?:лид(?:а|ов|ы)?|заяв(?:ка|ки|ок)|обращени(?:е|я|й)|запрос(?:а|ов|ы)?)`;

function parseAmount(raw: string, maximum: number): CountAmount | null {
	const digitRuns = [...raw.matchAll(/\p{Nd}+/gu)].map((match) => match[0]);
	if (digitRuns.length < 1 || digitRuns.length > 2) return null;
	const first = parseDecimalDigits(digitRuns[0] ?? "", maximum);
	if (first === null) return null;
	if (digitRuns.length === 1) return { kind: "integer", value: first };
	const second = parseDecimalDigits(digitRuns[1] ?? "", maximum);
	if (second === null || first > second) return null;
	return { kind: "range", min: first, max: second };
}

function addLeadMatch(
	text: string,
	proposals: ConversationFactProposal[],
	match: RegExpMatchArray,
	kind: "monthly" | "daily_rate",
	basis?: "generic_day" | "business_day" | "calendar_day",
): void {
	const rawAmount = match.groups?.amount;
	if (!rawAmount) return;
	const amount = parseAmount(rawAmount, MAX_LEAD_COUNT);
	if (!amount) return;
	let value: MonthlyLeadVolume;
	if (kind === "monthly") {
		value = { kind, amount };
	} else if (basis === "business_day" || basis === "calendar_day") {
		value = { kind, amount, basis, basisStatus: "explicit" };
	} else {
		value = {
			kind,
			amount,
			basis: "generic_day",
			basisStatus: "pending",
		};
	}
	const source = trimSpan(
		text,
		match.index ?? 0,
		(match.index ?? 0) + match[0].length,
	);
	addProposal(proposals, { field: "monthlyLeadVolume", value, source });
}

const MONTHLY_LEAD_PATTERNS = [
	new RegExp(
		String.raw`(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}\s*(?:в|за)\s+месяц(?:а)?(?!\p{L})`,
		"giu",
	),
	new RegExp(
		String.raw`(?:в|за)\s+месяц\s+(?:приходит\s+)?(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}`,
		"giu",
	),
	new RegExp(
		String.raw`ежемесячно\s+(?:приходит\s+)?(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}`,
		"giu",
	),
] as const;

const DAILY_LEAD_PATTERNS: ReadonlyArray<
	readonly [RegExp, "generic_day" | "business_day" | "calendar_day"]
> = [
	[
		new RegExp(
			String.raw`(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}\s*(?:в|за)\s+рабоч(?:ий|их)\s+(?:день|дня)`,
			"giu",
		),
		"business_day",
	],
	[
		new RegExp(
			String.raw`(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}\s+по\s+будням`,
			"giu",
		),
		"business_day",
	],
	[
		new RegExp(
			String.raw`(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}\s*(?:в|за)\s+календарн(?:ый|ых)\s+(?:день|дня)`,
			"giu",
		),
		"calendar_day",
	],
	[
		new RegExp(
			String.raw`(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}\s+(?:каждый\s+день|ежедневно)`,
			"giu",
		),
		"calendar_day",
	],
	[
		new RegExp(
			String.raw`(?<amount>${AMOUNT_TOKEN})\s*${LEAD_WORD}\s*(?:в|за)\s+день`,
			"giu",
		),
		"generic_day",
	],
];

function extractLeadVolume(
	text: string,
	expectedField: ConversationFactField | undefined,
	proposals: ConversationFactProposal[],
): void {
	for (const pattern of MONTHLY_LEAD_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			addLeadMatch(text, proposals, match, "monthly");
		}
	}
	for (const [pattern, basis] of DAILY_LEAD_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			addLeadMatch(text, proposals, match, "daily_rate", basis);
		}
	}
	if (expectedField !== "monthlyLeadVolume") return;
	for (const [pattern, kind, basis] of [
		[
			new RegExp(
				String.raw`^\s*(?<amount>${AMOUNT_TOKEN})\s*(?:в|за)\s+месяц[.!]?\s*$`,
				"iu",
			),
			"monthly",
			undefined,
		],
		[
			new RegExp(
				String.raw`^\s*(?<amount>${AMOUNT_TOKEN})\s*(?:в|за)\s+день[.!]?\s*$`,
				"iu",
			),
			"daily_rate",
			"generic_day",
		],
	] as const) {
		const match = pattern.exec(text);
		if (match) addLeadMatch(text, proposals, match, kind, basis);
	}
}

const MANAGER_PATTERNS = [
	new RegExp(
		String.raw`(?<amount>${DIGIT_TOKEN})\s+(?:штатн(?:ый|ых|ые)\s+)?(?:менеджер(?:а|ов|ы)?|сотрудник(?:а|ов|и)?)\s+(?:по\s+продажам|отдела\s+продаж)`,
		"giu",
	),
	new RegExp(
		String.raw`(?:в|у)\s+(?:наш(?:ем|ей)\s+)?(?:отделе|команде)\s+продаж[^.!?\r\n]{0,50}?(?:работает|работают|есть|нас)\s+(?:около\s+|примерно\s+)?(?<amount>${DIGIT_TOKEN})\s+(?:человек|сотрудник(?:а|ов)?|менеджер(?:а|ов)?)`,
		"giu",
	),
	new RegExp(
		String.raw`(?:в|у)\s+(?:наш(?:ем|ей)\s+)?(?:отделе|команде)\s+продаж\s+(?:около\s+|примерно\s+)?(?<amount>${DIGIT_TOKEN})\s+(?:человек|сотрудник(?:а|ов)?|менеджер(?:а|ов)?)`,
		"giu",
	),
] as const;

function sentenceAround(text: string, start: number, end: number): string {
	const before = text.slice(0, start);
	const after = text.slice(end);
	const sentenceStart =
		Math.max(
			before.lastIndexOf("."),
			before.lastIndexOf("!"),
			before.lastIndexOf("?"),
			before.lastIndexOf("\n"),
		) + 1;
	const endings = [".", "!", "?", "\n"]
		.map((separator) => after.indexOf(separator))
		.filter((index) => index >= 0);
	const sentenceEnd =
		end + (endings.length > 0 ? Math.min(...endings) : after.length);
	return text.slice(sentenceStart, sentenceEnd);
}

function ambiguousExternalTeam(sentence: string): boolean {
	return /(?:аутсорс|подрядчик|внешн(?:ий|его|ем|яя|ей)|колл[ -]?центр|call[ -]?cent(?:er|re)|контактн(?:ый|ого|ом)\s+центр)/iu.test(
		sentence,
	);
}

function addManagerMatch(
	text: string,
	proposals: ConversationFactProposal[],
	match: RegExpMatchArray,
): void {
	const rawAmount = match.groups?.amount;
	if (!rawAmount) return;
	const value = parseDecimalDigits(rawAmount, MAX_SALES_MANAGER_COUNT);
	if (value === null) return;
	const start = match.index ?? 0;
	const end = start + match[0].length;
	if (ambiguousExternalTeam(sentenceAround(text, start, end))) return;
	const amountStart = start + match[0].indexOf(rawAmount);
	addProposal(proposals, {
		field: "salesManagerCount",
		value,
		source: {
			start: amountStart,
			end: amountStart + rawAmount.length,
			evidence: rawAmount,
		},
	});
}

function extractSalesManagerCount(
	text: string,
	expectedField: ConversationFactField | undefined,
	proposals: ConversationFactProposal[],
): void {
	for (const pattern of MANAGER_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			addManagerMatch(text, proposals, match);
		}
	}
	if (expectedField !== "salesManagerCount") return;
	const answer = new RegExp(
		String.raw`^\s*(?:(?:работает|работают|нас|около|примерно)\s+)*(?<amount>${DIGIT_TOKEN})(?:\s+(?:человек|сотрудник(?:а|ов)?|менеджер(?:а|ов)?))?[.!]?\s*$`,
		"iu",
	).exec(text);
	if (answer) addManagerMatch(text, proposals, answer);
}

function extractIntents(
	text: string,
	context: AcceptedVisitorText["context"],
): ConversationIntentIndicators {
	if (!context) return NO_INTENTS;
	const normalized = text
		.normalize("NFKC")
		.toLocaleLowerCase("ru-RU")
		.trim()
		.replace(/\s+/gu, " ");
	let confirmation: ConversationIntentIndicators["confirmation"] = null;
	if (context.pendingConfirmation) {
		if (
			/^(?:да|да,?\s+подтверждаю|подтверждаю|верно|вс[её] верно|да,?\s+вс[её] верно|вс[её] верно,?\s+(?:записывайте|бронируйте)|согласен|согласна|yes|confirm|correct)[.!]?$/u.test(
				normalized,
			)
		) {
			confirmation = "confirmed";
		} else if (
			/^(?:нет|нет,?\s+не подтверждаю|не подтверждаю|неверно|отклоняю|no|decline|incorrect)[.!]?$/u.test(
				normalized,
			)
		) {
			confirmation = "declined";
		}
	}
	const mayInterpretCorrection =
		context.correctionExpected === true || context.expectedField !== undefined;
	const correction =
		mayInterpretCorrection &&
		/(?:^|\s)(?:исправ(?:ьте|ляю|ление)|поправка|точнее|вернее|неверно|ошиб(?:ка|ся|лась))(?=$|[^\p{L}]|:)|(?:^|\s)не\s+[^,;.!?]{1,80}\s*[,;]?\s+а\s+/iu.test(
			normalized,
		);
	const hasExpectedContext =
		context.pendingConfirmation === true ||
		context.correctionExpected === true ||
		context.expectedField !== undefined;
	const alreadyAnswered =
		hasExpectedContext &&
		/(?:^|\s)я\s+(?:на\s+это\s+)?уже\s+(?:отвечал(?:а|и)?|ответил(?:а|и)?|говорил(?:а|и)?|сообщал(?:а|и)?)(?=$|[^\p{L}])/iu.test(
			normalized,
		);
	return { correction, confirmation, alreadyAnswered };
}

function validInput(input: unknown): input is AcceptedVisitorText {
	if (typeof input !== "object" || input === null) return false;
	const candidate = input as Partial<AcceptedVisitorText>;
	return (
		candidate.source === "visitor" &&
		candidate.accepted === true &&
		typeof candidate.text === "string" &&
		(candidate.context === undefined ||
			(typeof candidate.context === "object" && candidate.context !== null))
	);
}

/** Deterministically proposes facts from one accepted raw visitor turn only. */
export function extractConversationFacts(
	input: AcceptedVisitorText,
): ConversationFactExtractionResult;
export function extractConversationFacts(
	input: unknown,
): ConversationFactExtractionResult;
export function extractConversationFacts(
	input: unknown,
): ConversationFactExtractionResult {
	if (!validInput(input)) {
		return {
			kind: "rejected",
			reason: "invalid_input",
			proposals: [],
			intents: NO_INTENTS,
		};
	}
	if (input.text.length > MAX_ACCEPTED_VISITOR_TEXT_LENGTH) {
		return {
			kind: "rejected",
			reason: "input_too_long",
			proposals: [],
			intents: NO_INTENTS,
		};
	}

	const proposals: ConversationFactProposal[] = [];
	extractEmails(input.text, proposals);
	extractPhones(input.text, proposals);
	extractTelegram(input.text, proposals);
	extractLabelledIdentities(input.text, proposals);
	extractNaturalIdentity(input.text, proposals);
	extractLeadVolume(input.text, input.context?.expectedField, proposals);
	extractSalesManagerCount(input.text, input.context?.expectedField, proposals);
	proposals.sort(
		(left, right) =>
			left.source.start - right.source.start ||
			left.source.end - right.source.end ||
			left.field.localeCompare(right.field),
	);
	return {
		kind: "extracted",
		proposals,
		intents: extractIntents(input.text, input.context),
	};
}

/** Safe for diagnostics: returns unique field names and nothing sensitive. */
export function summarizeFactFields(
	result: ConversationFactExtractionResult,
): SafeFactFieldSummary {
	return {
		fields:
			result.kind === "extracted"
				? [...new Set(result.proposals.map(({ field }) => field))]
				: [],
	};
}
