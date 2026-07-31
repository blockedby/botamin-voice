/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceDemoProps } from "../components/VoiceDemo";
import { LandingPage } from "./LandingPage";

const noop = () => undefined;

const idleVoice: VoiceDemoProps = {
	state: { kind: "idle" },
	consent: { voiceProcessing: true, contactProcessing: true },
	transcript: [],
	muted: false,
	onConsentChange: noop,
	onStart: noop,
	onRetryPermission: noop,
	onToggleMute: noop,
	onStop: noop,
	onInterrupt: noop,
	onReconnect: noop,
	onRestart: noop,
	onQualificationChoice: noop,
};

describe("Botamin landing narrative", () => {
	const html = renderToStaticMarkup(<LandingPage voice={idleVoice} />);

	test("renders the exact hero and one dominant conversation CTA", () => {
		expect(html).toContain(
			"AI-продавец, который сам покажет, как перестать терять лиды",
		);
		expect(html).toContain(
			"Поговорите с голосовым агентом Botamin. Он разберёт ваш процесс, покажет релевантный сценарий и зафиксирует следующий шаг.",
		);
		expect(html.match(/Поговорить с AI-продавцом/g)?.length).toBe(1);
	});

	test("keeps scenarios and the full handoff process in source order", () => {
		const narrative = [
			"Обрабатывать входящие 24/7",
			"Квалифицировать и передавать только целевые лиды",
			"Реактивировать недозвоны и холодные базы",
			"Источник",
			"AI-первая линия",
			"Квалификация",
			"Структурированный handoff",
			"Менеджер",
		];
		let cursor = -1;
		for (const phrase of narrative) {
			const next = html.indexOf(phrase, cursor + 1);
			expect(next).toBeGreaterThan(cursor);
			cursor = next;
		}
	});

	test("attributes public case claims and explicitly rejects guarantees", () => {
		expect(html).toContain("«Главтрассы» · голосовой outbound");
		expect(html).toContain("РоллПроф · входящий поток и follow-up");
		expect(html).toContain("Продавец утеплительной пены · Авито");
		expect(html).toContain("публичная Telegram-лента Botamin");
		expect(html).toContain("не гарантия результата для нового проекта");
	});

	test("states privacy, stop and no-calendar limits", () => {
		expect(html).toContain("Ваши данные не публикуются в открытом разговоре");
		expect(html).toContain("Микрофон и разговор выключаются в любой момент");
		expect(html).toContain("Реальная встреча в этом демо не создаётся");
		expect(html).toContain("фиксируются лид и следующий шаг");
	});
});
