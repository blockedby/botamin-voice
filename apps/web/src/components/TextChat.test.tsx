/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserBookingDraft } from "../testFixtures/rc4";
import { isComposerSubmitKey, TextChat, type TextChatProps } from "./TextChat";

const noopSubmit = () => false;

function props(
	conversationStage: TextChatProps["conversationStage"],
): TextChatProps {
	return {
		conversationStage,
		textInputAvailable:
			conversationStage === "GREETING" ||
			conversationStage === "COLLECT_BOOKING",
		textSubmission: { status: "idle" },
		bookingDraft: createBrowserBookingDraft(),
		bookingSubmission: { status: "idle" },
		bookingInputAvailable: conversationStage === "COLLECT_BOOKING",
		onTextSubmit: noopSubmit,
		onBookingSubmit: noopSubmit,
		onBookingConflictResolve: noopSubmit,
	};
}

function render(stage: TextChatProps["conversationStage"]) {
	return renderToStaticMarkup(<TextChat {...props(stage)} />);
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
	});

	test("hides chat outside server-owned visitor-turn stages", () => {
		expect(render(null)).toBe("");
		expect(render("CONNECTING")).toBe("");
		expect(render("COMPLETE")).toBe("");
	});
});

describe("in-chat booking form", () => {
	test("renders only at server COLLECT_BOOKING with five fields and two server candidates", () => {
		for (const stage of ["GREETING", "BOOKING_OFFER", "BOOKED"] as const) {
			expect(render(stage)).not.toContain("booking-details-title");
		}
		const html = render("COLLECT_BOOKING");
		expect(html).toContain("booking-details-title");
		for (const label of [
			"Имя",
			"Компания",
			"Рабочий email",
			"Телефон",
			"Telegram",
		]) {
			expect(html).toContain(label);
		}
		expect(html.match(/name="meetingCandidate"/g)?.length).toBe(2);
		expect(html).toContain("Подтвердить и создать встречу");
		expect(html).not.toContain("Запись создана");
	});

	test("disables both submit paths while booking details are pending", () => {
		const value = props("COLLECT_BOOKING");
		value.bookingSubmission = {
			status: "details-pending",
			requestId: "01J00000000000000000000020",
			baseRevision: 1,
		};
		value.bookingInputAvailable = false;
		value.textInputAvailable = false;
		const html = renderToStaticMarkup(<TextChat {...value} />);
		expect(html).toContain("Подтверждаем…");
		expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(8);
	});
});
