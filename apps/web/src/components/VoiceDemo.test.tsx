/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceDemoProps, VoiceUiState } from "./VoiceDemo";
import { VoiceDemo } from "./VoiceDemo";

const noop = () => undefined;

function renderVoice(
	state: VoiceUiState,
	overrides: Partial<VoiceDemoProps> = {},
): string {
	return renderToStaticMarkup(
		<VoiceDemo
			state={state}
			consent={{ voiceProcessing: true, contactProcessing: true }}
			transcript={[]}
			muted={false}
			onConsentChange={noop}
			onStart={noop}
			onRetryPermission={noop}
			onToggleMute={noop}
			onStop={noop}
			onInterrupt={noop}
			onReconnect={noop}
			onRestart={noop}
			onQualificationChoice={noop}
			{...overrides}
		/>,
	);
}

describe("VoiceDemo state semantics", () => {
	const cases: readonly [VoiceUiState, string][] = [
		[{ kind: "idle" }, "Готов к разговору"],
		[{ kind: "connecting" }, "Подключаем разговор"],
		[{ kind: "permission-denied" }, "Нет доступа к микрофону"],
		[{ kind: "listening" }, "Слушаю вас"],
		[{ kind: "processing" }, "Обрабатываю реплику"],
		[{ kind: "thinking" }, "Подбираю релевантный сценарий"],
		[{ kind: "speaking" }, "AI-продавец отвечает"],
		[{ kind: "booked" }, "Следующий шаг записан"],
		[
			{ kind: "qualification", questionNumber: 2, questionCount: 5 },
			"Дополнительный вопрос 2 из 5",
		],
		[{ kind: "complete", qualificationStatus: "partial" }, "Разговор завершён"],
		[{ kind: "audio-error" }, "Продолжаем текстом"],
		[{ kind: "disconnected" }, "Связь прервана"],
		[{ kind: "reconnecting", attempt: 3 }, "Попытка 3"],
		[{ kind: "error" }, "Разговор не удалось продолжить"],
	];

	for (const [state, expectedLabel] of cases) {
		test(`renders ${state.kind}`, () => {
			const html = renderVoice(state);
			expect(html).toContain(`data-voice-state="${state.kind}"`);
			expect(html).toContain(expectedLabel);
			expect(html).toContain('role="status"');
			expect(html).not.toContain("stack trace");
			expect(html).not.toContain("OpenRouter");
			expect(html).not.toContain("Codex");
		});
	}
});

describe("VoiceDemo controls and transcript", () => {
	test("requires both consents before enabling the single start action", () => {
		const blocked = renderVoice(
			{ kind: "idle" },
			{
				consent: { voiceProcessing: true, contactProcessing: false },
			},
		);
		expect(blocked.match(/type="checkbox"/g)?.length).toBe(2);
		expect(blocked).toContain("Поговорить с AI-продавцом");
		expect(blocked).toContain("disabled");

		const ready = renderVoice({ kind: "idle" });
		const startButton = ready.match(
			/<button class="primary-voice-cta"[\s\S]*?<\/button>/,
		)?.[0];
		expect(startButton).toBeDefined();
		expect(startButton).not.toContain("disabled");
	});

	test("processing shows no draft transcript while committed long Russian content remains intact", () => {
		const longFinal =
			"Финальная реплика: у нас распределённый отдел продаж, длинный цикл сделки и несколько источников входящих обращений — сайт, рекомендации и повторные запросы существующих клиентов.";
		const html = renderVoice(
			{ kind: "processing" },
			{
				transcript: [{ id: "final-long", speaker: "visitor", text: longFinal }],
			},
		);
		expect(html).toContain(longFinal);
		expect(html).toContain("только финальные реплики");
		expect(html).toContain("без черновой расшифровки");
	});

	test("connecting and reconnecting attempts remain cancellable", () => {
		expect(renderVoice({ kind: "connecting" })).toContain(
			"Отменить подключение",
		);
		expect(renderVoice({ kind: "reconnecting", attempt: 2 })).toContain(
			"Остановить попытку",
		);
	});

	test("speaking exposes mute, stop and interrupt controls", () => {
		const html = renderVoice({ kind: "speaking" });
		expect(html).toContain("Выключить микрофон");
		expect(html).toContain("Перебить агента");
		expect(html).toContain("Завершить");
		expect(html).toContain("Управление разговором");
	});

	test("booked confirms only the recorded lead and makes qualification optional", () => {
		const html = renderVoice({ kind: "booked" });
		expect(html).toContain("Лид и следующий шаг записаны");
		expect(html).toContain("Это не календарная встреча");
		expect(html).toContain("3–5 необязательных вопросов");
		expect(html).toContain("Да, продолжить");
		expect(html).toContain("Нет, завершить");
	});

	test("audio failure preserves text-only output", () => {
		const answer =
			"Текст ответа остаётся доступен, даже когда звук не воспроизводится.";
		const html = renderVoice(
			{ kind: "audio-error" },
			{
				transcript: [{ id: "answer", speaker: "agent", text: answer }],
			},
		);
		expect(html).toContain(answer);
		expect(html).toContain("Звук ответа сейчас недоступен");
	});
});
