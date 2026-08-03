import { describe, expect, test } from "bun:test";
import {
	chunkSpeech,
	prepareSpeech,
	SpeechBudgetGuard,
	SpeechPrefetchCoordinator,
	StreamingSentenceChunker,
	sanitizeSpeech,
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

	test("rejects complete nested JSON envelopes regardless of key order", () => {
		const envelope =
			'До конверта. {"metadata":{"company":"Секрет ООО. Очень длинное закрытое название компании, которое не должно попасть в синтез речи даже после жёсткой границы сегмента, включая продолжение названия Секрет Холдинг.","contact":"private@example.com","ids":{"bookingId":"01J00000000000000000000001"}},"speech":"Не озвучивать Анну. Совсем не озвучивать.","action":{"payload":{"name":"Анна","phone":"+7 999 123-45-67"},"type":"create_booking"}} После конверта.';
		const spoken = sanitizeSpeech(envelope);
		expect(spoken).toBe("До конверта. После конверта.");
		expect(spoken).not.toMatch(
			/Секрет|private|01J|Анн|999|create_booking|payload/u,
		);
		const streamed = chunkSpeech(envelope).map(sanitizeSpeech).filter(Boolean);
		expect(streamed).toEqual(["До конверта.", "После конверта."]);
	});

	test("redacts phone, email, and Telegram before provider speech", () => {
		const source =
			"Пишите name.surname+sales@example.com, @private_sales или +7 (999) 123-45-67.";
		const spoken = sanitizeSpeech(source);
		expect(spoken).toContain("контакт скрыт");
		expect(spoken).not.toMatch(/@|example\.com|999|123-45/u);
		expect(source).toContain("name.surname+sales@example.com");
		for (const mutation of [
			"+７：９９９：１２３：４５：６７",
			"＋٧∶９９９；١٢٣・٤٥•６７",
			"+⁷⁹⁹⁹¹²³⁴⁵⁶⁷",
			"+₇₉₉₉₁₂₃₄₅₆₇",
			"+⑦⑨⑨⑨①②③④⑤⑥⑦",
			"+7;999;123;45;67",
		]) {
			expect(sanitizeSpeech(`Номер ${mutation}`)).toBe("Номер контакт скрыт");
		}
	});

	test("fails closed within a fixed phone scan bound", () => {
		expect(sanitizeSpeech(`Текст ${"1".repeat(16_385)}`)).toBe("контакт скрыт");
	});

	test("never returns punctuation-only or empty segments", () => {
		expect(sanitizeSpeech(" ** --- ... ")).toBe("");
		expect(sanitizeSpeech("```json\n{}\n```")).toBe("");
	});
});

describe("approved contact speech", () => {
	const gmail = {
		channel: "email",
		value: "RosSelGosTorg@gmail.com",
	} as const;
	const phone = { channel: "phone", value: "+79555678955" } as const;
	const telegram = { channel: "telegram", value: "@Sales_Bot" } as const;

	test("speaks an exact approved Gmail address with punctuation words", () => {
		const prepared = prepareSpeech("Почта: RosSelGosTorg@GMAIL.com.", {
			contactProcessing: true,
			approvedContacts: [gmail],
		});
		expect(prepared).toEqual({
			spokenText: "Почта: RosSelGosTorg собака GMAIL точка com.",
			metadata: { forwardedChannels: ["email"], forwardedCount: 1 },
		});
	});

	test("formats every supported email separator naturally", () => {
		const approved = {
			channel: "email",
			value: "name.surname+sales-test_box@example-domain.com",
		} as const;
		const prepared = prepareSpeech(`Пишите ${approved.value}`, {
			contactProcessing: true,
			approvedContacts: [approved],
		});
		expect(prepared.spokenText).toBe(
			"Пишите name точка surname плюс sales дефис test подчёркивание box собака example дефис domain точка com",
		);
	});

	test("canonical-matches +7 display forms and speaks familiar Russian groups", () => {
		for (const detected of ["+7 (955) 567-89-55", "+7 955 567 89 55"]) {
			const prepared = prepareSpeech(`Телефон ${detected}`, {
				contactProcessing: true,
				approvedContacts: [phone],
			});
			expect(prepared.spokenText).toBe(
				"Телефон плюс семь, девятьсот пятьдесят пять, пятьсот шестьдесят семь, восемьдесят девять, пятьдесят пять",
			);
			expect(prepared.metadata).toEqual({
				forwardedChannels: ["phone"],
				forwardedCount: 1,
			});
		}
	});

	test("speaks exact approved +1 and +44 contacts in natural groups", () => {
		const cases = [
			{
				value: "+12025550101",
				detected: "+1 202-555-0101",
				spoken:
					"Телефон плюс один, двести два, пятьсот пятьдесят пять, ноль один, ноль один",
			},
			{
				value: "+442079460958",
				detected: "+44 20 7946 0958",
				spoken:
					"Телефон плюс сорок четыре, двести семь, девятьсот сорок шесть, ноль девять, пятьдесят восемь",
			},
		] as const;
		for (const testCase of cases) {
			const prepared = prepareSpeech(`Телефон ${testCase.detected}`, {
				contactProcessing: true,
				approvedContacts: [{ channel: "phone", value: testCase.value }],
			});
			expect(prepared.spokenText).toBe(testCase.spoken);
			expect(prepared.metadata).toEqual({
				forwardedChannels: ["phone"],
				forwardedCount: 1,
			});
		}
	});

	test("rejects international near-matches and malformed display mutations", () => {
		const approved = [
			{ channel: "phone", value: "+12025550101" },
			{ channel: "phone", value: "+442079460958" },
		] as const;
		for (const detected of [
			"+1/202/555/0101",
			"+1 202--555-0101",
			"+1 202-555-0101x",
			"+1 202-555-0102",
			"+1 (202)) 555-0101",
			"+１ ２０２-５５５-０１０１",
			"+44,20,7946,0958",
			"+44 20 7946 0959",
		]) {
			const prepared = prepareSpeech(`Телефон ${detected}`, {
				contactProcessing: true,
				approvedContacts: approved,
			});
			expect(prepared.spokenText).toBe("Телефон контакт скрыт");
			expect(prepared.metadata.forwardedCount).toBe(0);
		}
	});

	test("does not forward normalized mutations of an exact approved phone", () => {
		for (const detected of [
			"+７（９５５）５６７–８９–５５",
			"+⁷⁹⁵⁵⁵⁶⁷⁸⁹⁵⁵",
			"+₇₉₅₅₅₆₇₈₉₅₅",
			"+⑦⑨⑤⑤⑤⑥⑦⑧⑨⑤⑤",
			"+7;955;567;89;55",
			"\u200B+79555678955",
			"+79555678955\u200B",
			"\u0301+79555678955\u20DD",
		]) {
			const prepared = prepareSpeech(`Телефон ${detected}`, {
				contactProcessing: true,
				approvedContacts: [phone],
			});
			expect(prepared).toEqual({
				spokenText: "Телефон контакт скрыт",
				metadata: { forwardedChannels: [], forwardedCount: 0 },
			});
		}
	});

	test("redacts conservative phone mutations with either contact-processing mode", () => {
		for (const detected of [
			"+7:999:123:45:67",
			"+7;999;123;45;67",
			"+7•999·123‣45∙67",
			"+7/999/123/45/67",
			"+7,999,123,45,67",
			"+7\u200B999\u200C123\u206045\uFEFF67",
			"+7\u00A0999\u2007123\u202F45\u300067",
			"+٧/٩٩٩/١٢٣/٤٥/٦٧",
			"+٧∶９９９：١٢٣；٤٥．６７",
			"+７：９９９：１２３：４５：６７",
			"＋７∶999；١٢٣・45•６７",
			"+7（999）123−45—67",
			"+7 (999)/123,45\u200B67",
			"+7:999•123/45,67",
			"+7 )999( 123-45-67",
			"+7 ((999)) 123-45-67",
			"+7  999 123-45-67",
			"+1 (202 555-0101",
		]) {
			for (const contactProcessing of [false, true]) {
				const prepared = prepareSpeech(`Телефон ${detected}`, {
					contactProcessing,
					approvedContacts: [phone],
				});
				expect(prepared.spokenText).toBe("Телефон контакт скрыт");
				expect(prepared.metadata).toEqual({
					forwardedChannels: [],
					forwardedCount: 0,
				});
			}
		}
	});

	test("redacts phone suffixes and near-matches without relaxing approval", () => {
		for (const detected of [
			"5556789",
			"55567895",
			"555678955",
			"+79555678956",
			"+7/955/567/89/55",
			"+79555678955x",
			"+79555678955 доб. 12",
			"+1202555010100000",
		]) {
			const prepared = prepareSpeech(`Контакт ${detected}.`, {
				contactProcessing: true,
				approvedContacts: [phone],
			});
			expect(prepared.spokenText).toBe("Контакт контакт скрыт.");
			expect(prepared.metadata.forwardedCount).toBe(0);
		}
	});

	test("preserves case numbers, dates, times, decimals, percentages, ranges, and grouped counts", () => {
		const controls = [
			"Кейс: 12 500 заявок, выручка 1 000 000, рост 3,14%, дата 10.08.2026, время 16:00.",
			"Дело № 1234567, заявка # 7654321 и тикет N 2345678.",
			"Период 10.08.2026—12.08.2026, окно 09:00–16:00.",
			"События 10.08.2026 16:00, 10.08.2026T16:00 и 16:00 10.08.2026.",
			"Значение 1234567,89, доля 1234567%, диапазон 1000000-2000000.",
			"Обработано 12\u00A0500 заявок и 1\u202F000\u202F000 обращений.",
			"Дата １０．０８．２０２６, время １６：００, доля ３，１４％ и １２３４５６７％.",
		];
		for (const source of controls) {
			for (const contactProcessing of [false, true]) {
				const prepared = prepareSpeech(source, {
					contactProcessing,
					approvedContacts: [phone],
				});
				expect(prepared.spokenText).toBe(source.replace(/\s+/gu, " "));
				expect(prepared.metadata.forwardedCount).toBe(0);
			}
		}
	});

	test("normalizes strict Telegram mentions and t.me URLs case-insensitively", () => {
		for (const detected of ["@sales_bot", "https://t.me/SALES_BOT/"]) {
			const prepared = prepareSpeech(`Телеграм ${detected}.`, {
				contactProcessing: true,
				approvedContacts: [telegram],
			});
			expect(prepared.spokenText).toMatch(
				/^Телеграм собака SALES_BOT\.$|^Телеграм собака sales_bot\.$/u,
			);
			expect(prepared.metadata).toEqual({
				forwardedChannels: ["telegram"],
				forwardedCount: 1,
			});
		}
	});

	test("redacts exact contacts without contact-processing consent", () => {
		const prepared = prepareSpeech(
			"Контакты RosSelGosTorg@gmail.com, +79555678955, @Sales_Bot.",
			{
				contactProcessing: false,
				approvedContacts: [gmail, phone, telegram],
			},
		);
		expect(prepared.spokenText).toBe("Контакты контакт скрыт");
		expect(prepared.metadata).toEqual({
			forwardedChannels: [],
			forwardedCount: 0,
		});
	});

	test("redacts near, different-local, domain-only, and phone-suffix values", () => {
		for (const detected of [
			"RosSelGosTorg+sales@gmail.com",
			"OtherLocal@gmail.com",
			"rosselgostorg@gmail.com",
			"gmail.com",
			"555678955",
		]) {
			const prepared = prepareSpeech(`Контакт ${detected}.`, {
				contactProcessing: true,
				approvedContacts: [gmail, phone],
			});
			expect(prepared.spokenText).toBe("Контакт контакт скрыт.");
			expect(prepared.metadata.forwardedCount).toBe(0);
		}
	});

	test("forwards only exact approved values among multiple contacts", () => {
		const prepared = prepareSpeech(
			"Почты other@example.com и RosSelGosTorg@gmail.com, телефон +7 999 123-45-67.",
			{ contactProcessing: true, approvedContacts: [gmail] },
		);
		expect(prepared.spokenText).toBe(
			"Почты контакт скрыт и RosSelGosTorg собака gmail точка com, телефон контакт скрыт.",
		);
		expect(prepared.metadata).toEqual({
			forwardedChannels: ["email"],
			forwardedCount: 1,
		});
	});

	test("normalizes Unicode email forms before conservative matching", () => {
		const prepared = prepareSpeech("Café@EXAMPLE.com", {
			contactProcessing: true,
			approvedContacts: [{ channel: "email", value: "Café@example.com" }],
		});
		expect(prepared.spokenText).toBe("Café собака EXAMPLE точка com");
		expect(prepared.metadata.forwardedCount).toBe(1);
	});

	test("never forwards approved contacts from JSON, tool envelopes, or hidden Markdown URLs", () => {
		const prepared = prepareSpeech(
			'До. {"email":"RosSelGosTorg@gmail.com"} <tool_call>https://t.me/Sales_Bot</tool_call> [профиль](https://t.me/Sales_Bot) После.',
			{ contactProcessing: true, approvedContacts: [gmail, telegram] },
		);
		expect(prepared.spokenText).toBe("До. профиль После.");
		expect(prepared.metadata.forwardedCount).toBe(0);
	});

	test("redacts unknown or invalid strict Telegram contacts", () => {
		for (const value of [
			"https://t.me/Other_Bot",
			"t.me/Sales_Bot?start=secret",
		]) {
			const unknown = prepareSpeech(`Телеграм ${value}`, {
				contactProcessing: true,
				approvedContacts: [telegram],
			});
			expect(unknown.spokenText).toBe("Телеграм контакт скрыт");
			expect(unknown.metadata.forwardedCount).toBe(0);
		}

		const invalid = prepareSpeech("Телеграм @Sales__Bot", {
			contactProcessing: true,
			approvedContacts: [{ channel: "telegram", value: "@Sales__Bot" }],
		});
		expect(invalid.spokenText).toBe("Телеграм контакт скрыт");
		expect(invalid.metadata.forwardedCount).toBe(0);
	});

	test("fails closed when the approved list exceeds its booking bound", () => {
		const prepared = prepareSpeech("RosSelGosTorg@gmail.com", {
			contactProcessing: true,
			approvedContacts: [
				gmail,
				phone,
				telegram,
				{ channel: "email", value: "fourth@example.com" },
			],
		});
		expect(prepared.spokenText).toBe("контакт скрыт");
		expect(prepared.metadata.forwardedCount).toBe(0);
	});

	test("metadata never contains raw or formatted contact values", () => {
		const prepared = prepareSpeech(
			"RosSelGosTorg@gmail.com +79555678955 @Sales_Bot",
			{
				contactProcessing: true,
				approvedContacts: [gmail, phone, telegram],
			},
		);
		const metadata = JSON.stringify(prepared.metadata);
		expect(prepared.metadata.forwardedCount).toBe(3);
		expect(metadata).not.toMatch(/RosSel|gmail|7955|Sales_Bot|собака/u);
	});

	test("expanded speech can be re-chunked under the 240-character ceiling", () => {
		const prepared = prepareSpeech(
			`Повтор: ${gmail.value}. Ещё раз: ${gmail.value}. И снова: ${gmail.value}.`,
			{ contactProcessing: true, approvedContacts: [gmail] },
		);
		const chunks = chunkSpeech(prepared.spokenText);
		expect(chunks.length).toBeGreaterThan(0);
		for (const chunk of chunks) {
			expect([...chunk].length).toBeLessThanOrEqual(240);
			expect(chunk).not.toMatch(/^[\p{P}\p{S}\s]*$/u);
		}
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

	test("holds Unicode phone prefixes across punctuation deltas and idle flushes", () => {
		const source = "Телефон +⁷.⁹⁹⁹.¹²³.⁴⁵.⁶⁷";
		const chunker = new StreamingSentenceChunker({
			firstMinimum: 1,
			firstTarget: 20,
			softTarget: 120,
			hardLimit: 120,
			idleFlushMs: 1,
		});
		const providerBound: string[] = [];
		for (const delta of ["Телефон +⁷.", "⁹⁹⁹.", "¹²³.", "⁴⁵.", "⁶⁷"]) {
			providerBound.push(...chunker.push(delta).map(sanitizeSpeech));
			providerBound.push(...chunker.flushIdle(1).map(sanitizeSpeech));
		}
		providerBound.push(...chunker.flush().map(sanitizeSpeech));
		const concatenated = providerBound.filter(Boolean).join(" ");
		expect(concatenated).toBe("Телефон контакт скрыт");
		expect(concatenated).not.toContain(source);
		expect(concatenated.normalize("NFKC").replace(/\D/gu, "")).not.toMatch(
			/\d{8}/u,
		);
	});

	test("releases an exact approved phone only as one natural marker-allowlisted phrase", () => {
		const chunker = new StreamingSentenceChunker({
			firstMinimum: 1,
			firstTarget: 20,
			softTarget: 120,
			hardLimit: 120,
		});
		const chunks: string[] = [];
		for (const delta of ["Телефон +7 ", "955 ", "567-", "89-", "55"]) {
			chunks.push(...chunker.push(delta));
		}
		chunks.push(...chunker.flush());
		expect(chunks).toEqual(["Телефон", "+7 955 567-89-55"]);
		expect(
			chunks
				.map(
					(chunk) =>
						prepareSpeech(chunk, {
							contactProcessing: true,
							approvedContacts: [{ channel: "phone", value: "+79555678955" }],
						}).spokenText,
				)
				.join(" "),
		).toBe(
			"Телефон плюс семь, девятьсот пятьдесят пять, пятьсот шестьдесят семь, восемьдесят девять, пятьдесят пять",
		);
	});

	test("protects the shared Unicode separator corpus at target and hard boundaries", () => {
		for (const separator of [
			".",
			":",
			";",
			"•",
			"∶",
			"·",
			"–",
			"\u00a0",
			"\u2007",
			"\u200b",
		]) {
			const candidate = `+７${separator}⁹٩９${separator}¹۲３${separator}⁴٥${separator}６⁷`;
			const source = `${"Обычная вводная фраза ".repeat(5)}телефон ${candidate}. Продолжим.`;
			const chunks = chunkSpeech(source, {
				firstMinimum: 40,
				firstTarget: 80,
				softTarget: 120,
				hardLimit: 120,
			});
			const providerBound = chunks
				.map(sanitizeSpeech)
				.filter(Boolean)
				.join(" ");
			expect(chunks.every((chunk) => [...chunk].length <= 120)).toBe(true);
			expect(chunks.join(" ")).toBe(source);
			expect(providerBound).toContain("Продолжим.");
			expect(providerBound).not.toContain(candidate);
			expect(providerBound.normalize("NFKC").replace(/\D/gu, "")).not.toMatch(
				/79991234567/u,
			);
		}
	});

	test("fails closed without unbounded buffering for an overlong numeric run", () => {
		const chunker = new StreamingSentenceChunker({
			firstMinimum: 1,
			firstTarget: 20,
			softTarget: 120,
			hardLimit: 120,
			idleFlushMs: 1,
		});
		const chunks = chunker.push(`+${"⁷·".repeat(200)}`);
		expect(chunks).toEqual(["контакт скрыт"]);
		expect(chunker.pending.length).toBeLessThanOrEqual(120);
		expect(chunker.flushIdle(1)).toEqual([]);
		expect(chunker.push("⁹⁹⁹ продолжение обычного ответа.")).toEqual([
			"продолжение обычного ответа.",
		]);
		expect(chunker.flush()).toEqual([]);
	});

	test("retains completed ordinary numeric controls", () => {
		const source =
			"Рост 3.14 процента. Дело № 1234567. Время 16:00. Обработано 12 500 заявок.";
		const chunks = chunkSpeech(source, {
			firstMinimum: 20,
			firstTarget: 60,
			softTarget: 120,
			hardLimit: 120,
		});
		expect(chunks.map(sanitizeSpeech).join(" ")).toBe(source);
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
		expect(window.inFlight).toBe(2);
		window.finish("two");
		window.finish("three");
		expect(window.inFlight).toBe(0);
	});
});
