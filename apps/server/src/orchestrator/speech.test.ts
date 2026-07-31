import { describe, expect, test } from "bun:test";
import {
	chunkSpeech,
	sanitizeSpeech,
	SpeechBudgetGuard,
	SpeechPrefetchCoordinator,
	StreamingSentenceChunker,
} from "./speech";

describe("speech sanitizer", () => {
	test("removes Markdown, code, raw URLs, tool envelopes, and hidden IDs", () => {
		const sanitized = sanitizeSpeech(`
# Заголовок
- Напишите [нам](https://botamin.example/contact).
- Сайт: https://botamin.example/path?q=1
\`\`\`json
{"tool":"create_booking","bookingId":"01J00000000000000000000001"}
\`\`\`
generationId=01J00000000000000000000002
**Готово**
`);
		expect(sanitized).toBe("Заголовок Напишите нам. Сайт: Готово");
		expect(sanitized).not.toMatch(
			/https|create_booking|generationId|01J|[*#`{}]/u,
		);
	});

	test("removes inline tool payloads and prefixed hidden IDs", () => {
		const spoken = sanitizeSpeech(
			'Готово. {"tool":"create_booking","args":{"name":"Анна"}} bkg_private_123',
		);
		expect(spoken).toBe("Готово.");
		expect(spoken).not.toMatch(/create_booking|Анна|bkg_/u);
	});

	test("redacts phone, email, and Telegram before provider speech", () => {
		const source =
			"Пишите name.surname+sales@example.com, @private_sales или +7 (999) 123-45-67.";
		const spoken = sanitizeSpeech(source);
		expect(spoken).toContain("контакт скрыт");
		expect(spoken).not.toMatch(/@|example\.com|999|123-45/u);
		expect(source).toContain("name.surname+sales@example.com");
	});

	test("never returns punctuation-only or empty segments", () => {
		expect(sanitizeSpeech(" ** --- ... ")).toBe("");
		expect(sanitizeSpeech("```json\n{}\n```")).toBe("");
	});
});

describe("bounded streaming phrase chunker", () => {
	test("releases a 60-120 character first phrase before completion", () => {
		const chunker = new StreamingSentenceChunker();
		const first =
			"Покажу подходящий сценарий для ночных заявок и коротко объясню следующий шаг.";
		expect(first.length).toBeGreaterThanOrEqual(60);
		expect(first.length).toBeLessThanOrEqual(120);
		expect(chunker.push(first)).toEqual([first]);
		expect(chunker.push(" Вторая часть ещё генерируется")).toEqual([]);
	});

	test("uses punctuation and idle flush without empty output", () => {
		const chunker = new StreamingSentenceChunker({ idleFlushMs: 350 });
		expect(chunker.push("Короткий ответ без завершения")).toEqual([]);
		expect(chunker.flushIdle(349)).toEqual([]);
		expect(chunker.flushIdle(350)).toEqual(["Короткий ответ без завершения"]);
		expect(chunker.flush()).toEqual([]);
	});

	test("keeps every segment within hard 240 and splits on safe word boundaries", () => {
		const text = `${"длинное слово компании ".repeat(30)}Завершение.`;
		const chunks = chunkSpeech(text);
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) {
			expect([...chunk].length).toBeLessThanOrEqual(240);
			expect(chunk.trim()).toBe(chunk);
			expect(chunk).not.toBe("");
		}
	});

	test("does not split decimal, phone-like number, abbreviation, or company token where feasible", () => {
		const text =
			"Компания ООО РоллПроф обрабатывает 12 500 заявок, рост 3.14 процента. См. подробности в отчёте. Дальше обсудим процесс и подходящий сценарий внедрения.";
		const chunks = chunkSpeech(text, {
			firstMinimum: 40,
			firstTarget: 100,
			softTarget: 120,
			hardLimit: 180,
		});
		expect(chunks.join(" ")).toContain("12 500");
		expect(chunks.join(" ")).toContain("3.14");
		expect(chunks.join(" ")).toContain("См. подробности");
		expect(chunks.every((chunk) => !chunk.endsWith("ООО"))).toBe(true);
	});
});

describe("TTS budgets and prefetch coordination", () => {
	test("charges segment, turn, and session budgets once", () => {
		const guard = new SpeechBudgetGuard({
			maxCharsPerSegment: 10,
			maxCharsPerTurn: 15,
			maxCharsPerSession: 20,
		});
		expect(guard.reserve("12345678901")).toEqual({
			ok: false,
			reason: "segment",
		});
		expect(guard.reserve("1234567890").ok).toBe(true);
		expect(guard.reserve("123456")).toEqual({ ok: false, reason: "turn" });
		guard.startTurn();
		expect(guard.reserve("1234567890").ok).toBe(true);
		guard.startTurn();
		expect(guard.reserve("1")).toEqual({ ok: false, reason: "session" });
	});

	test("allows only one current synthesis plus one prefetch", () => {
		const window = new SpeechPrefetchCoordinator();
		expect(window.tryStart("one")).toBe(true);
		expect(window.tryStart("two")).toBe(true);
		expect(window.tryStart("three")).toBe(false);
		expect(window.inFlight).toBe(2);
		window.finish("one");
		expect(window.tryStart("three")).toBe(true);
		window.abortAll();
		expect(window.inFlight).toBe(0);
	});
});
