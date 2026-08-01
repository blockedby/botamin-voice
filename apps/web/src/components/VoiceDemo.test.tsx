/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	FinalTranscriptEntry,
	VoiceDemoProps,
	VoiceUiState,
} from "./VoiceDemo";
import {
	activateVoiceStart,
	completeVoiceSession,
	getUtteranceCountdown,
	handOffVoiceControlFocus,
	stopVoiceSession,
	VoiceDemo,
} from "./VoiceDemo";

const noop = () => undefined;

function liveRegionContent(html: string): string {
	const region = html.match(
		/<div class="visually-hidden" data-voice-live-region="true"[\s\S]*?<\/div>/,
	)?.[0];
	expect(region).toBeDefined();
	return region ?? "";
}

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
			captureProgress={null}
			conversationStage={null}
			textInputAvailable={false}
			textSubmission={{ status: "idle" }}
			onConsentChange={noop}
			onStart={noop}
			onCommit={noop}
			onRetryPermission={noop}
			onToggleMute={noop}
			onStop={noop}
			onInterrupt={noop}
			onReconnect={noop}
			onRestart={noop}
			onTextSubmit={() => false}
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
			{
				kind: "qualification",
				bookingOutcome: "committed",
				questionNumber: 2,
				questionCount: 5,
			},
			"Дополнительный вопрос 2 из 5",
		],
		[
			{
				kind: "complete",
				bookingOutcome: "committed",
				qualificationStatus: "partial",
			},
			"Разговор завершён",
		],
		[{ kind: "audio-error" }, "Продолжаем текстом"],
		[{ kind: "disconnected" }, "Связь прервана"],
		[{ kind: "reconnecting", attempt: 3 }, "Попытка 3"],
		[{ kind: "error" }, "Сервис разговора временно недоступен"],
	];

	for (const [state, expectedLabel] of cases) {
		test(`renders ${state.kind}`, () => {
			const html = renderVoice(state);
			expect(html).toContain(`data-voice-state="${state.kind}"`);
			expect(html).toContain(expectedLabel);
			expect(html.match(/role="status"/g)?.length).toBe(1);
			expect(html.match(/aria-live="polite"/g)?.length).toBe(1);
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

	test("listening can commit while speaking exposes mute, stop and interrupt controls", () => {
		expect(renderVoice({ kind: "listening" })).toContain("Завершить реплику");
		const html = renderVoice({ kind: "speaking" });
		expect(html).toContain("Выключить микрофон");
		expect(html).toContain("Перебить агента");
		expect(html).toContain("Завершить");
		expect(html).toContain("Управление разговором");
	});

	test("renders a stable, non-live circular countdown only for active capture states", () => {
		const initial = {
			acceptedPcmBytes: 0,
			durationMs: 0,
			maxUtteranceMs: 60_000,
		};
		const listening = renderVoice(
			{ kind: "listening" },
			{ captureProgress: initial },
		);
		expect(listening).toContain('role="timer"');
		expect(listening).toContain("Осталось на реплику");
		expect(listening).toContain(
			'aria-label="Осталось времени на реплику: 60 секунд."',
		);
		expect(listening).toContain('aria-live="off"');
		expect(liveRegionContent(listening)).not.toContain("Осталось");

		const qualification = renderVoice(
			{ kind: "qualification", bookingOutcome: "committed" },
			{
				captureProgress: {
					acceptedPcmBytes: 1_600_000,
					durationMs: 50_000,
					maxUtteranceMs: 60_000,
				},
			},
		);
		expect(qualification).toContain('data-countdown-warning="true"');
		expect(qualification).toContain(
			'aria-label="Осталось времени на реплику: 10 секунд."',
		);

		const processing = renderVoice(
			{ kind: "processing" },
			{ captureProgress: initial },
		);
		expect(processing).not.toContain('role="timer"');
		expect(processing).toContain("status-orbit");
		expect(
			getUtteranceCountdown({ ...initial, durationMs: 49_001 }),
		).toMatchObject({ remainingSeconds: 11, warning: false });
	});

	test("mute exposes one stable name whose pressed state means muting is active", () => {
		const unmuted = renderVoice({ kind: "listening" }, { muted: false });
		const muted = renderVoice({ kind: "listening" }, { muted: true });
		for (const html of [unmuted, muted]) {
			expect(html.match(/aria-label="Отключение микрофона"/g)?.length).toBe(1);
		}
		const mutedWithTimer = renderVoice(
			{ kind: "listening" },
			{
				muted: true,
				captureProgress: {
					acceptedPcmBytes: 320_000,
					durationMs: 10_000,
					maxUtteranceMs: 60_000,
				},
			},
		);
		expect(mutedWithTimer).toContain(
			'aria-label="Осталось времени на реплику: 50 секунд."',
		);
		expect(unmuted).toContain('aria-pressed="false"');
		expect(muted).toContain('aria-pressed="true"');
	});

	test("Enter start activation focuses stable status after the CTA unmounts, including microphone denial", () => {
		for (const nextState of ["connecting", "permission-denied"] as const) {
			const events: string[] = [];
			let state: VoiceUiState = { kind: "idle" };
			const stableStatus = {
				focus: () => events.push(`focus:${state.kind}`),
			};

			activateVoiceStart(() => {
				events.push("start");
				state = { kind: nextState };
			}, stableStatus);

			expect(events).toEqual(["start", `focus:${nextState}`]);
			const changed = renderVoice(state);
			expect(changed).not.toContain("primary-voice-cta");
			expect(changed).toContain('class="voice-status');
			expect(changed).toContain('tabindex="-1"');
		}
	});

	test("hands focus from controls that disappear to a stable exact target", () => {
		const focused: string[] = [];
		const targets = {
			mute: { focus: () => focused.push("mute") },
			status: { focus: () => focused.push("status") },
		};
		handOffVoiceControlFocus("interrupt", targets);
		handOffVoiceControlFocus("session", targets);
		expect(focused).toEqual(["mute", "status"]);
	});

	test("only a committed booking state can produce a booked completion", () => {
		expect(completeVoiceSession({ kind: "connecting" })).toEqual({
			kind: "complete",
			bookingOutcome: "none",
		});
		expect(completeVoiceSession({ kind: "listening" })).toEqual({
			kind: "complete",
			bookingOutcome: "none",
		});
		expect(completeVoiceSession({ kind: "booked" })).toEqual({
			kind: "complete",
			bookingOutcome: "committed",
			qualificationStatus: "skipped",
		});
		expect(
			completeVoiceSession({
				kind: "qualification",
				bookingOutcome: "committed",
				questionNumber: 2,
				questionCount: 4,
			}),
		).toEqual({
			kind: "complete",
			bookingOutcome: "committed",
			qualificationStatus: "partial",
		});
	});

	test("stopping before booking clears even supplied transcript history", () => {
		const fabricated: readonly FinalTranscriptEntry[] = [
			{ id: "fixture", speaker: "agent", text: "fixture history" },
		];
		expect(stopVoiceSession({ kind: "speaking" }, fabricated)).toEqual({
			state: { kind: "complete", bookingOutcome: "none" },
			transcript: [],
		});
		expect(stopVoiceSession({ kind: "booked" }, fabricated)).toEqual({
			state: {
				kind: "complete",
				bookingOutcome: "committed",
				qualificationStatus: "skipped",
			},
			transcript: fabricated,
		});
	});

	test("derives booking form visibility from projected server stage, not transcript wording", () => {
		const suggestiveTranscript = [
			{
				id: "agent-suggestion",
				speaker: "agent" as const,
				text: "Оставьте имя, компанию, email и телефон.",
			},
		];
		expect(
			renderVoice(
				{ kind: "listening" },
				{
					transcript: suggestiveTranscript,
					conversationStage: "BOOKING_OFFER",
				},
			),
		).not.toContain("booking-details-title");
		expect(
			renderVoice(
				{ kind: "thinking" },
				{
					transcript: [],
					conversationStage: "COLLECT_BOOKING",
				},
			),
		).toContain("booking-details-title");
	});

	test("booked confirms only the recorded lead and makes qualification optional", () => {
		const html = renderVoice({ kind: "booked" });
		expect(html).toContain("Лид и следующий шаг записаны");
		expect(html).toContain("Это не календарная встреча");
		expect(html).toContain("дополнительные вопросы");
		expect(html).toContain("необязательными");
		expect(html).toContain("Завершить разговор");
	});

	test("keeps one consolidated polite live region with changing post-booking updates", () => {
		const transcript = [
			{
				id: "committed",
				speaker: "agent" as const,
				text: "Контакт и следующий шаг записаны.",
			},
		];
		const html = renderVoice({ kind: "booked" }, { transcript });
		const qualification = renderVoice(
			{
				kind: "qualification",
				bookingOutcome: "committed",
				questionNumber: 2,
				questionCount: 4,
			},
			{ transcript },
		);
		const disconnected = renderVoice(
			{ kind: "disconnected", bookingOutcome: "committed" },
			{ transcript },
		);
		const audioError = renderVoice(
			{ kind: "audio-error", bookingOutcome: "committed" },
			{
				transcript: [
					...transcript,
					{
						id: "final-audio-fallback",
						speaker: "agent",
						text: "Продолжим по видимому тексту.",
					},
				],
			},
		);

		for (const rendered of [html, qualification, disconnected, audioError]) {
			expect(rendered.match(/role="status"/g)?.length).toBe(1);
			expect(rendered.match(/aria-live="polite"/g)?.length).toBe(1);
		}
		const bookedLive = liveRegionContent(html);
		expect(bookedLive.match(/Лид и следующий шаг записаны/g)?.length).toBe(1);
		expect(bookedLive).toContain("Это не календарная встреча");
		expect(liveRegionContent(qualification)).toContain(
			"Дополнительный вопрос 2 из 4",
		);
		expect(liveRegionContent(disconnected)).toContain("Связь прервана");
		expect(liveRegionContent(audioError)).toContain("Продолжаем текстом");
		expect(liveRegionContent(audioError)).toContain(
			"Финальная реплика, Botamin: Продолжим по видимому тексту.",
		);
	});

	test("keeps visual booking status and transcript outside the sole live region", () => {
		const html = renderVoice(
			{ kind: "booked" },
			{
				transcript: [
					{
						id: "committed",
						speaker: "agent",
						text: "Контакт и следующий шаг записаны.",
					},
				],
			},
		);
		expect(html.match(/role="status"/g)?.length).toBe(1);
		expect(html.match(/aria-live="polite"/g)?.length).toBe(1);
		expect(html).toContain("Следующий шаг записан");
		expect(html).toContain("Контакт и следующий шаг записаны.");
	});

	test("pre-booking completion is neutral and makes no saved-data claim", () => {
		const html = renderVoice({ kind: "complete", bookingOutcome: "none" });
		expect(html).toContain("Сессия остановлена");
		expect(html).toContain("Лид и контакт не записывались");
		expect(html).not.toContain("Лид и следующий шаг записаны");
		expect(html).not.toContain("Это не календарная встреча");
	});

	test("committed completion keeps the no-calendar confirmation", () => {
		const html = renderVoice({
			kind: "complete",
			bookingOutcome: "committed",
			qualificationStatus: "skipped",
		});
		expect(html).toContain("Лид и следующий шаг записаны");
		expect(html).toContain("Это не календарная встреча");
		expect(html).not.toContain("Лид и контакт не записывались");
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
		expect(html).not.toContain("уже записанный следующий шаг");
	});
});
