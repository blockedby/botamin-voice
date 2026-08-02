import { describe, expect, test } from "bun:test";
import {
	type ConversationFactField,
	type ConversationFactProposal,
	extractConversationFacts,
	MAX_ACCEPTED_VISITOR_TEXT_LENGTH,
	summarizeFactFields,
} from "./index";

function extract(
	text: string,
	context?: {
		expectedField?: ConversationFactField;
		pendingConfirmation?: true;
		correctionExpected?: true;
	},
) {
	const result = extractConversationFacts({
		source: "visitor",
		accepted: true,
		text,
		...(context ? { context } : {}),
	});
	if (result.kind !== "extracted") throw new Error("Expected extracted result");
	return result;
}

function proposalsFor<Field extends ConversationFactProposal["field"]>(
	text: string,
	field: Field,
	context?: Parameters<typeof extract>[1],
) {
	return extract(text, context).proposals.filter(
		(
			proposal,
		): proposal is Extract<ConversationFactProposal, { field: Field }> =>
			proposal.field === field,
	);
}

describe("accepted visitor boundary and safe output", () => {
	test("rejects assistant/model envelopes and overlong visitor input", () => {
		expect(
			extractConversationFacts({
				source: "assistant",
				accepted: true,
				text: "Email: stolen@example.com",
			}),
		).toMatchObject({
			kind: "rejected",
			reason: "invalid_input",
			proposals: [],
		});
		expect(
			extractConversationFacts({
				source: "visitor",
				accepted: true,
				text: "x".repeat(MAX_ACCEPTED_VISITOR_TEXT_LENGTH + 1),
			}),
		).toMatchObject({
			kind: "rejected",
			reason: "input_too_long",
			proposals: [],
		});
		expect(
			extract("x".repeat(MAX_ACCEPTED_VISITOR_TEXT_LENGTH)).proposals,
		).toEqual([]);
	});

	test("returns a field-name-only safe summary", () => {
		const result = extract(
			"Пишите на Secret.Person+deal@example.com или +7 999 123-45-67",
		);
		expect(summarizeFactFields(result)).toEqual({
			fields: ["email", "phone"],
		});
		expect(JSON.stringify(summarizeFactFields(result))).not.toContain("Secret");
		expect(JSON.stringify(summarizeFactFields(result))).not.toContain("999");
	});
});

describe("contacts and labelled form lines", () => {
	test("normalizes Gmail aliases and accepts personal or IDN domains", () => {
		const emails = proposalsFor(
			"Jane.Doe+demo@GoogleMail.com, owner@ya.ru и Sales@пример.рф",
			"email",
		);
		expect(emails.map(({ value }) => value)).toEqual([
			"janedoe@gmail.com",
			"owner@ya.ru",
			"sales@xn--e1afmkfd.xn--p1ai",
		]);
		expect(emails[0]?.source).toEqual({
			start: 0,
			end: "Jane.Doe+demo@GoogleMail.com".length,
			evidence: "Jane.Doe+demo@GoogleMail.com",
		});
	});

	test("normalizes +7 and trunk-8 Russian phones, including Unicode digits", () => {
		const phones = proposalsFor(
			"+7 (999) 123-45-67; 8\u00a0495\u2007123 45 67; +٧ (٩٢٥) ١٢٣-٤٥-٦٧",
			"phone",
		);
		expect(phones.map(({ value }) => value)).toEqual([
			"+79991234567",
			"+74951234567",
			"+79251234567",
		]);
	});

	test("accepts only strict Telegram handles and t.me paths", () => {
		const telegram = proposalsFor(
			"@Valid_User9, https://t.me/AnotherUser; bad @four, t.me/name/path, person@example.com",
			"telegram",
		);
		expect(telegram.map(({ value }) => value)).toEqual([
			"@valid_user9",
			"@anotheruser",
		]);
	});

	test("extracts labelled Russian and English form lines", () => {
		const text = [
			"Имя: Анна-Мария Орлова",
			"Company — ООО «Ромашка 24»",
			"Рабочий email: anna@gmail.com",
			"Телефон: 8 (812) 555-44-33",
			"Telegram: t.me/Anna_Orlova",
		].join("\n");
		expect(
			extract(text).proposals.map(({ field, value }) => ({ field, value })),
		).toEqual([
			{ field: "name", value: "Анна-Мария Орлова" },
			{ field: "company", value: "ООО «Ромашка 24»" },
			{ field: "email", value: "anna@gmail.com" },
			{ field: "phone", value: "+78125554433" },
			{ field: "telegram", value: "@anna_orlova" },
		]);
	});

	test("deduplicates normalized repeats but retains conflicting contacts", () => {
		const result = extract(
			"A.B+one@gmail.com, ab@gmail.com, first@example.com, second@example.com; +7 999 111-22-33, 8 999 111 22 33, +7 999 444-55-66",
		);
		expect(
			result.proposals
				.filter(({ field }) => field === "email")
				.map(({ value }) => value),
		).toEqual(["ab@gmail.com", "first@example.com", "second@example.com"]);
		expect(
			result.proposals
				.filter(({ field }) => field === "phone")
				.map(({ value }) => value),
		).toEqual(["+79991112233", "+79994445566"]);
	});

	test("rejects malformed and overlong contact or identity values", () => {
		const result = extract(
			[
				"Имя: https://example.com/person",
				"Компания: boss@example.com",
				`Name: ${"А".repeat(121)}`,
				"bad..dots@example.com x@y @four +7 123 456-78-90",
			].join("\n"),
		);
		expect(
			result.proposals.map(({ field, value }) => ({ field, value })),
		).toEqual([{ field: "email", value: "boss@example.com" }]);
	});
});

describe("explicit identity text", () => {
	test("extracts the exact natural Russian scenario with UTF-16 spans", () => {
		const text = "🙂 меня зовут Алексей Пятов, компания Россельхозторг";
		const result = extract(text);
		expect(
			result.proposals.map(({ field, value }) => ({ field, value })),
		).toEqual([
			{ field: "name", value: "Алексей Пятов" },
			{ field: "company", value: "Россельхозторг" },
		]);
		for (const proposal of result.proposals) {
			expect(text.slice(proposal.source.start, proposal.source.end)).toBe(
				proposal.source.evidence,
			);
		}
		expect(result.proposals[0]?.source.start).toBe(text.indexOf("Алексей"));
	});

	test("does not guess unlabelled capitalized text", () => {
		expect(
			extract("Алексей Пятов работает в Россельхозторг").proposals,
		).toEqual([]);
	});
});

describe("sales team size", () => {
	test("extracts only explicit bounded sales-team counts", () => {
		for (const [text, expected] of [
			["В отделе продаж работает около 10 человек", 10],
			["У нас 12 менеджеров по продажам", 12],
			["В нашей команде продаж есть ٤ сотрудника", 4],
		] as const) {
			expect(
				proposalsFor(text, "salesManagerCount").map(({ value }) => value),
			).toEqual([expected]);
		}
	});

	test("uses expectedField for a bounded answer-only team count", () => {
		expect(
			proposalsFor("работает около 10 человек", "salesManagerCount", {
				expectedField: "salesManagerCount",
			}).map(({ value }) => value),
		).toEqual([10]);
		expect(
			proposalsFor("работает около 10 человек", "salesManagerCount"),
		).toEqual([]);
	});

	test("does not confuse unrelated numbers or ambiguous external teams", () => {
		for (const text of [
			"Встреча 10.08.2026 в 12:30 на 20 минут",
			"У нас 10 лидов и 25 заявок в месяц",
			"Телефон +7 999 123-45-67",
			"В аутсорсинговом колл-центре подрядчика 30 менеджеров по продажам",
			"Колл-центр внешний, в отделе продаж работает 18 человек",
		]) {
			expect(proposalsFor(text, "salesManagerCount")).toEqual([]);
		}
	});
});

describe("structured monthly lead volume", () => {
	test("extracts explicit monthly integers and ranges", () => {
		const result = extract(
			"Обычно 200 лидов в месяц, сезонный диапазон от 300 до 450 заявок за месяц",
		);
		expect(
			result.proposals
				.filter(({ field }) => field === "monthlyLeadVolume")
				.map(({ value }) => value),
		).toEqual([
			{
				kind: "monthly",
				amount: { kind: "integer", value: 200 },
			},
			{
				kind: "monthly",
				amount: { kind: "range", min: 300, max: 450 },
			},
		]);
	});

	test("keeps daily basis structured and generic basis pending", () => {
		const result = extract(
			"10 лидов в день, 20 заявок в рабочий день, 30 обращений в календарный день",
		);
		expect(
			result.proposals
				.filter(({ field }) => field === "monthlyLeadVolume")
				.map(({ value }) => value),
		).toEqual([
			{
				kind: "daily_rate",
				amount: { kind: "integer", value: 10 },
				basis: "generic_day",
				basisStatus: "pending",
			},
			{
				kind: "daily_rate",
				amount: { kind: "integer", value: 20 },
				basis: "business_day",
				basisStatus: "explicit",
			},
			{
				kind: "daily_rate",
				amount: { kind: "integer", value: 30 },
				basis: "calendar_day",
				basisStatus: "explicit",
			},
		]);
	});

	test("accepts answer-only daily rate only for the expected lead field", () => {
		expect(proposalsFor("10 в день", "monthlyLeadVolume")).toEqual([]);
		expect(
			proposalsFor("10 в день", "monthlyLeadVolume", {
				expectedField: "monthlyLeadVolume",
			}).map(({ value }) => value),
		).toEqual([
			{
				kind: "daily_rate",
				amount: { kind: "integer", value: 10 },
				basis: "generic_day",
				basisStatus: "pending",
			},
		]);
	});

	test("normalizes Unicode digits and whitespace without converting rates", () => {
		const proposal = proposalsFor(
			"От １２\u00a0до\u2007２０ лидов в месяц",
			"monthlyLeadVolume",
		)[0];
		expect(proposal?.value).toEqual({
			kind: "monthly",
			amount: { kind: "range", min: 12, max: 20 },
		});
		expect(proposal?.source.evidence).toBe(
			"От １２\u00a0до\u2007２０ лидов в месяц",
		);
	});

	test("rejects reversed, oversized, date, phone, duration, and bare counts", () => {
		for (const text of [
			"от 500 до 100 лидов в месяц",
			"10000001 лидов в месяц",
			"10.08.2026",
			"+7 999 123-45-67",
			"встреча на 20 минут",
			"10 в день",
			"работает около 10 человек",
		]) {
			expect(proposalsFor(text, "monthlyLeadVolume")).toEqual([]);
		}
	});
});

describe("context-gated intent indicators", () => {
	test("does not treat generic yes/no or corrections as intent without context", () => {
		expect(extract("да").intents).toEqual({
			correction: false,
			confirmation: null,
			alreadyAnswered: false,
		});
		expect(extract("Нет, точнее другой email").intents).toEqual({
			correction: false,
			confirmation: null,
			alreadyAnswered: false,
		});
	});

	test("flags conservative confirmation and decline only while pending", () => {
		expect(
			extract("Да", { pendingConfirmation: true }).intents.confirmation,
		).toBe("confirmed");
		expect(
			extract("Не подтверждаю", { pendingConfirmation: true }).intents
				.confirmation,
		).toBe("declined");
		expect(
			extract("да, но нужно подумать", { pendingConfirmation: true }).intents
				.confirmation,
		).toBeNull();
	});

	test("flags explicit correction and `Я уже отвечал` meta intent in context", () => {
		expect(
			extract("Нет, точнее alex@example.com", {
				expectedField: "email",
			}).intents.correction,
		).toBe(true);
		expect(
			extract("Я уже отвечал", { expectedField: "company" }).intents
				.alreadyAnswered,
		).toBe(true);
		expect(extract("Я уже отвечал").intents.alreadyAnswered).toBe(false);
	});
});
