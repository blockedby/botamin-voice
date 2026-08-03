import { describe, expect, test } from "bun:test";
import {
	containsPhoneLikeText,
	PHONE_SCAN_MAX_INPUT_CODE_UNITS,
	scanPhoneLikeText,
} from "../src/phone-detection";

const REVIEWER_BYPASSES = [
	"+⁷⁹⁹⁹¹²³⁴⁵⁶⁷",
	"+₇₉₉₉₁₂₃₄₅₆₇",
	"+⑦⑨⑨⑨①②③④⑤⑥⑦",
	"+7;999;123;45;67",
] as const;

const SEPARATOR_CONFUSABLES = [
	":",
	";",
	";",
	"：",
	"；",
	"∶",
	"⁚",
	"⁝",
	"⁞",
	"꞉",
	"﹕",
	"﹔",
	".",
	"．",
	"。",
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
	",",
	"，",
	"﹐",
	"،",
	"٬",
	"‚",
	"/",
	"／",
	"⁄",
	"∕",
	"⧸",
	"\\",
	"＼",
	"⧹",
] as const;

interface UnicodeDigitCorpus {
	compatibility: Array<{ character: string; digit: string }>;
	decimal: string[];
}

function digitRange(zero: number): Array<{ character: string; digit: string }> {
	return Array.from({ length: 10 }, (_, digit) => ({
		character: String.fromCodePoint(zero + digit),
		digit: String(digit),
	}));
}

function unicodeDigitCorpus(): UnicodeDigitCorpus {
	const superscript = [
		0x2070, 0x00b9, 0x00b2, 0x00b3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078,
		0x2079,
	].map((codePoint, digit) => ({
		character: String.fromCodePoint(codePoint),
		digit: String(digit),
	}));
	const circled = [
		0x24ea,
		...Array.from({ length: 9 }, (_, index) => 0x2460 + index),
	].map((codePoint, digit) => ({
		character: String.fromCodePoint(codePoint),
		digit: String(digit),
	}));
	const compatibility = [
		...superscript,
		...digitRange(0x2080),
		...circled,
		...digitRange(0xff10),
		...digitRange(0x1ccf0),
		...digitRange(0x1d7ce),
		...digitRange(0x1d7d8),
		...digitRange(0x1d7e2),
		...digitRange(0x1d7ec),
		...digitRange(0x1d7f6),
		...digitRange(0x1fbf0),
	];
	const decimal: string[] = [];
	for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
		const character = String.fromCodePoint(codePoint);
		if (/^\p{Nd}$/u.test(character)) decimal.push(character);
	}
	return { compatibility, decimal };
}

function expectSingleOriginalSpan(source: string, candidate: string): void {
	const result = scanPhoneLikeText(source);
	expect(result.overflow).toBe(false);
	if (result.overflow) return;
	expect(result.regions).toHaveLength(1);
	const region = result.regions[0];
	expect(region).toBeDefined();
	if (!region) return;
	expect(source.slice(region.start, region.end)).toBe(candidate);
}

describe("shared Unicode phone-like detector", () => {
	test("covers all four terminal reviewer bypasses with exact original spans", () => {
		for (const candidate of REVIEWER_BYPASSES) {
			expectSingleOriginalSpan(`До ${candidate} после`, candidate);
		}
	});

	test("covers all 110 non-ASCII single-digit NFKC confusables", () => {
		const { compatibility } = unicodeDigitCorpus();
		expect(compatibility).toHaveLength(110);
		for (const { character, digit } of compatibility) {
			const asciiPhone = "+12345678901";
			const candidate = asciiPhone.replace(digit, character);
			expect(containsPhoneLikeText(candidate)).toBe(true);
		}
	});

	test("maps all 770 Unicode decimal digits across scripts", () => {
		const { decimal } = unicodeDigitCorpus();
		expect(decimal).toHaveLength(770);
		for (const character of decimal) {
			expect(containsPhoneLikeText(`+${character.repeat(8)}`)).toBe(true);
		}
	});

	test("covers a 45-character separator/confusable corpus", () => {
		expect(SEPARATOR_CONFUSABLES).toHaveLength(45);
		for (const separator of SEPARATOR_CONFUSABLES) {
			const candidate = `+7${separator}999${separator}123${separator}45${separator}67`;
			expectSingleOriginalSpan(`До ${candidate} после`, candidate);
		}
	});

	test("covers mixed scripts, combining marks, bidi, format chars, and expansions", () => {
		for (const candidate of [
			"+٧⁹９₉①۲३④٥６⑦",
			"+7\u0301\u20DD999\u034F123\uFE0F45\u048867",
			"+7\u200B999\u200C123\u206045\uFEFF67",
			"+7\u202A999\u202C123\u206645\u206967",
			"+⑺⑼⑼⑼⑴⑵⑶⑷⑸⑹⑺",
			"+⒎⒐⒐⒐⒈⒉⒊⒋⒌⒍⒎",
			"\u200B+79991234567\u200C",
			"\u0301+79991234567\u20DD",
		]) {
			expectSingleOriginalSpan(`До ${candidate} после`, candidate);
		}
	});

	test("retains numeric controls but redacts phone context and arbitrary long numbers", () => {
		for (const control of [
			"Дело № 1234567, заявка # 7654321 и тикет N 2345678.",
			"Дата 10.08.2026, время 16:00, окно 09:00–16:00.",
			"События 10.08.2026 16:00, 10.08.2026T16:00 и 16:00 10.08.2026.",
			"Значение 1234567,89, доля 1234567%, диапазон 1000000-2000000.",
			"Обработано 12 500 заявок и 1 000 000 обращений.",
			"Дата １０．０８．２０２６, время １６：００, доля ３，１４％.",
		]) {
			expect(containsPhoneLikeText(control)).toBe(false);
		}
		expect(containsPhoneLikeText("Телефон 123 456 789")).toBe(true);
		expect(containsPhoneLikeText("1".repeat(16))).toBe(true);
	});

	test("fails closed on every bound or invalid UTF-16 condition", () => {
		expect(
			scanPhoneLikeText("1".repeat(PHONE_SCAN_MAX_INPUT_CODE_UNITS + 1))
				.overflow,
		).toBe(true);
		expect(scanPhoneLikeText("\uD800").overflow).toBe(true);
		// U+FDFA expands to eighteen code points under NFKC.
		expect(scanPhoneLikeText("ﷺ".repeat(4_000)).overflow).toBe(true);
		expect(
			scanPhoneLikeText(
				Array.from({ length: 257 }, () => "+12345678x").join(" "),
			).overflow,
		).toBe(true);
	});
});
