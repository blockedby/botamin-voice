/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	isComposerSubmitKey,
	serializeBookingDetails,
	TextChat,
	validateBookingDetails,
} from "./TextChat";

const noopSubmit = () => false;

function render(stage: Parameters<typeof TextChat>[0]["conversationStage"]) {
	return renderToStaticMarkup(
		<TextChat
			conversationStage={stage}
			textInputAvailable={stage === "GREETING" || stage === "COLLECT_BOOKING"}
			textSubmission={{ status: "idle" }}
			onTextSubmit={noopSubmit}
		/>,
	);
}

describe("typed chat composer", () => {
	test("uses a labeled multiline native composer with mobile and keyboard-safe semantics", () => {
		const html = render("GREETING");
		expect(html).toContain(
			'<label for="visitor-message">Напишите сообщение</label>',
		);
		expect(html).toContain('name="visitorMessage"');
		expect(html).toContain('enterKeyHint="send"');
		expect(html).toContain('autoComplete="off"');
		expect(html).toContain("Enter — отправить, Shift+Enter — новая строка");
		expect(html).toContain('type="submit"');
	});

	test("Enter submits, Shift+Enter inserts a newline, and composition is preserved", () => {
		expect(
			isComposerSubmitKey({
				key: "Enter",
				shiftKey: false,
				isComposing: false,
			}),
		).toBe(true);
		expect(
			isComposerSubmitKey({ key: "Enter", shiftKey: true, isComposing: false }),
		).toBe(false);
		expect(
			isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: true }),
		).toBe(false);
		expect(
			isComposerSubmitKey({ key: "a", shiftKey: false, isComposing: false }),
		).toBe(false);
	});

	test("hides chat outside server-owned visitor-turn stages", () => {
		expect(render(null)).toBe("");
		expect(render("CONNECTING")).toBe("");
		expect(render("COMPLETE")).toBe("");
	});
});

describe("in-chat booking details", () => {
	test("reveals the form only at server-owned COLLECT_BOOKING", () => {
		for (const stage of ["GREETING", "BOOKING_OFFER", "BOOKED"] as const) {
			expect(render(stage)).not.toContain("booking-details-title");
		}
		const html = render("COLLECT_BOOKING");
		expect(html).toContain("booking-details-title");
		expect(html).toContain("Имя");
		expect(html).toContain("Компания");
		expect(html).toContain("Рабочий email");
		expect(html).toContain("Телефон");
		expect(html).toContain("Telegram");
		expect(html).toContain("Форма не подтверждает встречу");
		expect(html).not.toContain("Запись создана");
	});

	test("validates required details and one alternate contact", () => {
		expect(
			validateBookingDetails({
				name: "",
				company: "",
				email: "invalid",
				contactChannel: "",
				contactValue: "",
			}),
		).toMatchObject({
			name: expect.any(String),
			company: expect.any(String),
			email: expect.any(String),
			contactChannel: expect.any(String),
		});
		expect(
			validateBookingDetails({
				name: "Анна",
				company: "Пример",
				email: "anna@example.com",
				contactChannel: "telegram",
				contactValue: "@anna",
			}),
		).toEqual({});
	});

	test("serializes fields as visitor text without tool invocation or success claims", () => {
		const text = serializeBookingDetails({
			name: " Анна ",
			company: " Пример ",
			email: " anna@example.com ",
			contactChannel: "phone",
			contactValue: " +7 999 123-45-67 ",
		});
		expect(text).toContain("Имя: Анна");
		expect(text).toContain("Компания: Пример");
		expect(text).toContain("Рабочий email: anna@example.com");
		expect(text).toContain("Телефон: +7 999 123-45-67");
		expect(text).not.toMatch(
			/create_booking|booking\.created|успешно|создана/u,
		);
	});

	test("disables both submit paths while one typed turn is pending", () => {
		const html = renderToStaticMarkup(
			<TextChat
				conversationStage="COLLECT_BOOKING"
				textInputAvailable={false}
				textSubmission={{ status: "pending" }}
				onTextSubmit={noopSubmit}
			/>,
		);
		expect(html).toContain("Передаём данные…");
		expect(html).toContain("Отправляем…");
		expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
	});
});
