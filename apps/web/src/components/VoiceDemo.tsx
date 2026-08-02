import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { useRef } from "react";
import { TextChat } from "./TextChat";
import type {
	FinalTranscriptEntry,
	VoiceCaptureProgress,
	VoiceConsent,
	VoiceConversationProjection,
	VoiceUiState,
} from "./voiceTypes";

export type {
	FinalTranscriptEntry,
	TextSubmissionState,
	VoiceCaptureProgress,
	VoiceConsent,
	VoiceConversationProjection,
	VoiceUiState,
} from "./voiceTypes";

export interface VoiceDemoActions {
	onConsentChange: (consent: VoiceConsent) => void;
	onStart: () => void;
	onCommit: () => void;
	onRetryPermission: () => void;
	onToggleMute: () => void;
	onStop: () => void;
	onInterrupt: () => void;
	onReconnect: () => void;
	onRestart: () => void;
	onTextSubmit: (text: string) => boolean;
}

export interface VoiceDemoProps
	extends VoiceDemoActions,
		VoiceConversationProjection {
	state: VoiceUiState;
	consent: VoiceConsent;
	transcript: readonly FinalTranscriptEntry[];
	muted: boolean;
	captureProgress: VoiceCaptureProgress | null;
}

interface StatePresentation {
	label: string;
	detail: string;
	tone: "neutral" | "active" | "success" | "warning" | "danger";
}

export function getVoiceStatePresentation(
	state: VoiceUiState,
	muted: boolean,
): StatePresentation {
	switch (state.kind) {
		case "idle":
			return {
				label: "Готов к разговору",
				detail: "Сначала подтвердите условия — затем включим микрофон.",
				tone: "neutral",
			};
		case "connecting":
			return {
				label: "Подключаем разговор",
				detail: "Это обычно занимает несколько секунд.",
				tone: "active",
			};
		case "permission-denied":
			return {
				label: "Нет доступа к микрофону",
				detail:
					"Разрешите микрофон в настройках сайта и повторите попытку. Доступ можно отозвать в браузере.",
				tone: "danger",
			};
		case "listening":
			return muted
				? {
						label: "Микрофон выключен",
						detail: "Включите его, когда будете готовы продолжить.",
						tone: "warning",
					}
				: {
						label: "Слушаю вас",
						detail:
							"Говорите естественно. Когда закончите, реплика будет обработана целиком.",
						tone: "active",
					};
		case "processing":
			return {
				label: "Обрабатываю реплику",
				detail: "Покажем только финальный текст — без черновой расшифровки.",
				tone: "active",
			};
		case "thinking":
			return {
				label: "Подбираю релевантный сценарий",
				detail: "Связываю вашу задачу с подходящим процессом продаж.",
				tone: "active",
			};
		case "speaking":
			return {
				label: "AI-продавец отвечает",
				detail: "Ответ также остаётся текстом. Вы можете перебить агента.",
				tone: "active",
			};
		case "booked":
			return {
				label: "Следующий шаг записан",
				detail: "Контакт и договорённость сохранены для команды Botamin.",
				tone: "success",
			};
		case "qualification":
			return {
				label: "Уточняем контекст",
				detail:
					state.questionNumber && state.questionCount
						? `Необязательный вопрос ${state.questionNumber} из ${state.questionCount}. Можно остановиться в любой момент.`
						: "Два дополнительных вопроса необязательны. Можно остановиться в любой момент.",
				tone: "active",
			};
		case "complete":
			return state.bookingOutcome === "committed"
				? {
						label: "Разговор завершён",
						detail: "Спасибо. Лид и согласованный следующий шаг записаны.",
						tone: "success",
					}
				: {
						label: "Разговор завершён",
						detail: "Сессия остановлена. Лид и контакт не записывались.",
						tone: "neutral",
					};
		case "audio-error":
			return {
				label: "Продолжаем текстом",
				detail: "Звук ответа сейчас недоступен, но видимый текст остаётся.",
				tone: "warning",
			};
		case "disconnected":
			return {
				label: "Связь прервана",
				detail: "Можно попробовать восстановить этот разговор.",
				tone: "warning",
			};
		case "reconnecting":
			return {
				label: "Восстанавливаем связь",
				detail: state.attempt
					? `Попытка ${state.attempt}. Сохраняем контекст разговора.`
					: "Сохраняем контекст разговора.",
				tone: "active",
			};
		case "error":
			return {
				label: "Сервис разговора временно недоступен",
				detail: "Проверьте связь и попробуйте ещё раз.",
				tone: "danger",
			};
	}
}

const CADENCE_BARS = [
	{ id: "lead-in", height: 3 },
	{ id: "rise-one", height: 6 },
	{ id: "crest-one", height: 9 },
	{ id: "pause-one", height: 5 },
	{ id: "peak", height: 12 },
	{ id: "fall-one", height: 8 },
	{ id: "pause-two", height: 4 },
	{ id: "crest-two", height: 10 },
	{ id: "fall-two", height: 6 },
	{ id: "tail", height: 3 },
] as const;

const ACTIVE_STATES = new Set<VoiceUiState["kind"]>([
	"connecting",
	"listening",
	"processing",
	"thinking",
	"speaking",
	"booked",
	"qualification",
	"audio-error",
	"reconnecting",
]);

interface FocusableTarget {
	focus: () => void;
}

export function activateVoiceStart(
	onStart: () => void,
	status: FocusableTarget | null,
) {
	// Native buttons dispatch the same click path for Enter/Space. Run the action
	// first, then move focus before React removes the activating CTA.
	onStart();
	status?.focus();
}

export function handOffVoiceControlFocus(
	control: "interrupt" | "session",
	targets: {
		mute: FocusableTarget | null;
		status: FocusableTarget | null;
	},
) {
	if (control === "interrupt") {
		targets.mute?.focus();
		return;
	}
	targets.status?.focus();
}

export function hasCommittedBooking(state: VoiceUiState): boolean {
	return (
		state.kind === "booked" ||
		("bookingOutcome" in state && state.bookingOutcome === "committed")
	);
}

export function completeVoiceSession(
	state: VoiceUiState,
): Extract<VoiceUiState, { kind: "complete" }> {
	if (!hasCommittedBooking(state)) {
		return { kind: "complete", bookingOutcome: "none" };
	}
	if (state.kind === "complete") return state;
	return {
		kind: "complete",
		bookingOutcome: "committed",
		qualificationStatus: state.kind === "qualification" ? "partial" : "skipped",
	};
}

export function stopVoiceSession(
	state: VoiceUiState,
	transcript: readonly FinalTranscriptEntry[],
): {
	state: Extract<VoiceUiState, { kind: "complete" }>;
	transcript: readonly FinalTranscriptEntry[];
} {
	return {
		state: completeVoiceSession(state),
		transcript: hasCommittedBooking(state) ? transcript : [],
	};
}

function ControlButton({
	children,
	className = "",
	buttonRef,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	children: ReactNode;
	buttonRef?: Ref<HTMLButtonElement>;
}) {
	return (
		<button
			className={`voice-control ${className}`.trim()}
			ref={buttonRef}
			type="button"
			{...props}
		>
			{children}
		</button>
	);
}

function ConsentPanel({
	consent,
	onConsentChange,
}: Pick<VoiceDemoProps, "consent" | "onConsentChange">) {
	return (
		<fieldset className="consent-panel">
			<legend>Перед началом</legend>
			<label className="consent-option">
				<input
					type="checkbox"
					checked={consent.voiceProcessing}
					onChange={(event) =>
						onConsentChange({
							...consent,
							voiceProcessing: event.currentTarget.checked,
						})
					}
				/>
				<span>Я согласен на обработку голоса в рамках этого разговора.</span>
			</label>
			<label className="consent-option">
				<input
					type="checkbox"
					checked={consent.contactProcessing}
					onChange={(event) =>
						onConsentChange({
							...consent,
							contactProcessing: event.currentTarget.checked,
						})
					}
				/>
				<span>
					Я согласен на обработку контакта, только если решу оставить его.
				</span>
			</label>
			<p id="voice-consent-note" className="consent-note">
				Сырые аудиозаписи не сохраняются. Разговор можно завершить в любой
				момент.
			</p>
		</fieldset>
	);
}

export function getVoiceLiveStatusAnnouncement(
	state: VoiceUiState,
	muted: boolean,
): string {
	const presentation = getVoiceStatePresentation(state, muted);
	if (state.kind === "booked") {
		return "Лид и следующий шаг записаны. Это не календарная встреча.";
	}
	if (state.kind === "complete" && state.bookingOutcome === "committed") {
		const qualification =
			state.qualificationStatus === "complete"
				? "Квалификация завершена."
				: state.qualificationStatus === "partial"
					? "Квалификация завершена частично."
					: "Дополнительная квалификация пропущена.";
		return `${qualification} ${presentation.label}. ${presentation.detail}`;
	}
	return `${presentation.label}. ${presentation.detail}`;
}

export function getLatestFinalTranscriptAnnouncement(
	entries: readonly FinalTranscriptEntry[],
): string {
	const latest = entries.at(-1);
	if (!latest) return "";
	const speaker = latest.speaker === "agent" ? "Botamin" : "Вы";
	return `Финальная реплика, ${speaker}: ${latest.text}`;
}

export function getUtteranceCountdown(progress: VoiceCaptureProgress): {
	remainingSeconds: number;
	remainingRatio: number;
	warning: boolean;
} {
	const remainingMs = Math.max(
		0,
		progress.maxUtteranceMs - progress.durationMs,
	);
	const remainingSeconds = Math.ceil(remainingMs / 1_000);
	return {
		remainingSeconds,
		remainingRatio:
			progress.maxUtteranceMs > 0
				? Math.min(1, remainingMs / progress.maxUtteranceMs)
				: 0,
		warning: remainingSeconds <= 10,
	};
}

function UtteranceCountdown({ progress }: { progress: VoiceCaptureProgress }) {
	const countdown = getUtteranceCountdown(progress);
	return (
		<div
			className={`utterance-countdown${countdown.warning ? " is-warning" : ""}`}
			role="timer"
			aria-label={`Осталось времени на реплику: ${countdown.remainingSeconds} секунд.`}
			aria-live="off"
			data-countdown-warning={countdown.warning ? "true" : "false"}
		>
			<svg
				className="utterance-countdown-ring"
				viewBox="0 0 44 44"
				aria-hidden="true"
				focusable="false"
			>
				<circle className="utterance-countdown-track" cx="22" cy="22" r="18" />
				<circle
					className="utterance-countdown-progress"
					cx="22"
					cy="22"
					r="18"
					pathLength="100"
					style={{ strokeDashoffset: 100 - countdown.remainingRatio * 100 }}
				/>
			</svg>
			<span className="utterance-countdown-value" aria-hidden="true">
				<strong>{countdown.remainingSeconds}</strong>
				<small>сек</small>
			</span>
			<span className="utterance-countdown-label">Осталось на реплику</span>
		</div>
	);
}

function Transcript({ entries }: { entries: readonly FinalTranscriptEntry[] }) {
	return (
		<section className="transcript" aria-labelledby="transcript-title">
			<div className="transcript-heading">
				<h3 id="transcript-title">Текст разговора</h3>
				<span>только финальные реплики</span>
			</div>
			<div className="transcript-log">
				{entries.length === 0 ? (
					<p className="transcript-empty">
						Здесь появятся ваши завершённые реплики и ответы агента.
					</p>
				) : (
					<ol>
						{entries.map((entry) => (
							<li
								className={`transcript-entry is-${entry.speaker}`}
								key={entry.id}
							>
								<span>{entry.speaker === "agent" ? "Botamin" : "Вы"}</span>
								<p>{entry.text}</p>
							</li>
						))}
					</ol>
				)}
			</div>
		</section>
	);
}

function StateActions(props: VoiceDemoProps) {
	const { state } = props;
	if (state.kind === "idle") {
		const consentReady =
			props.consent.voiceProcessing && props.consent.contactProcessing;
		return (
			<button
				className="primary-voice-cta"
				type="button"
				disabled={!consentReady}
				aria-describedby="voice-consent-note mic-requirement"
				onClick={props.onStart}
			>
				<span aria-hidden="true" className="cta-mark">
					“
				</span>
				<span>Поговорить с AI-продавцом</span>
			</button>
		);
	}
	if (state.kind === "connecting") {
		return (
			<ControlButton onClick={props.onStop}>Отменить подключение</ControlButton>
		);
	}
	if (state.kind === "permission-denied") {
		return (
			<ControlButton
				className="is-emphasized"
				onClick={props.onRetryPermission}
			>
				Повторить запрос доступа
			</ControlButton>
		);
	}
	if (state.kind === "booked") {
		return (
			<div className="qualification-choice">
				<p id="qualification-offer">
					Лид уже записан. Два коротких дополнительных вопроса необязательны:
					можно отказаться до первого или остановиться после него.
				</p>
				<ControlButton onClick={props.onStop}>Завершить разговор</ControlButton>
			</div>
		);
	}
	if (state.kind === "reconnecting") {
		return (
			<ControlButton onClick={props.onStop}>Остановить попытку</ControlButton>
		);
	}
	if (state.kind === "disconnected") {
		return (
			<ControlButton className="is-emphasized" onClick={props.onReconnect}>
				Восстановить разговор
			</ControlButton>
		);
	}
	if (state.kind === "error" || state.kind === "complete") {
		return (
			<ControlButton className="is-emphasized" onClick={props.onRestart}>
				{state.kind === "error" ? "Повторить попытку" : "Начать новый разговор"}
			</ControlButton>
		);
	}
	return null;
}

export function VoiceDemo(props: VoiceDemoProps) {
	const presentation = getVoiceStatePresentation(props.state, props.muted);
	const isActive = ACTIVE_STATES.has(props.state.kind);
	const bookingCommitted = hasCommittedBooking(props.state);
	const showCountdown =
		(props.state.kind === "listening" ||
			props.state.kind === "qualification") &&
		props.captureProgress !== null;
	const showSessionControls =
		isActive &&
		props.state.kind !== "connecting" &&
		props.state.kind !== "reconnecting" &&
		props.state.kind !== "booked";
	const muteButtonRef = useRef<HTMLButtonElement>(null);
	const statusRef = useRef<HTMLDivElement>(null);
	const focusTargets = () => ({
		mute: muteButtonRef.current,
		status: statusRef.current,
	});
	const handOffSessionFocus = () =>
		handOffVoiceControlFocus("session", focusTargets());
	const stateActions: VoiceDemoProps = {
		...props,
		onStart: () => activateVoiceStart(props.onStart, statusRef.current),
		onRetryPermission: () => {
			handOffSessionFocus();
			props.onRetryPermission();
		},
		onStop: () => {
			handOffSessionFocus();
			props.onStop();
		},
		onReconnect: () => {
			handOffSessionFocus();
			props.onReconnect();
		},
		onRestart: () => {
			handOffSessionFocus();
			props.onRestart();
		},
	};

	return (
		<section
			className={`voice-demo state-${props.state.kind}`}
			aria-labelledby="voice-demo-title"
			data-voice-state={props.state.kind}
		>
			<div
				className="visually-hidden"
				data-voice-live-region="true"
				role="status"
				aria-live="polite"
				aria-atomic="false"
			>
				<span data-voice-live-status="true">
					{getVoiceLiveStatusAnnouncement(props.state, props.muted)}
				</span>
				<span data-voice-live-transcript="true">
					{getLatestFinalTranscriptAnnouncement(props.transcript)}
				</span>
			</div>

			<header className="voice-demo-header">
				<div>
					<p className="eyebrow">Живой демо-разговор · около 4 минут</p>
					<h2 id="voice-demo-title">Проверьте на своей задаче</h2>
				</div>
				<span className="demo-badge">AI-продавец</span>
			</header>

			<div
				className={`voice-status tone-${presentation.tone}`}
				ref={statusRef}
				tabIndex={-1}
			>
				{showCountdown && props.captureProgress ? (
					<UtteranceCountdown progress={props.captureProgress} />
				) : (
					<div className="status-orbit" aria-hidden="true">
						<span />
					</div>
				)}
				<div className="status-copy">
					<strong>{presentation.label}</strong>
					<p>{presentation.detail}</p>
				</div>
				<div className="cadence" aria-hidden="true">
					{CADENCE_BARS.map((bar) => (
						<span
							key={bar.id}
							style={{ blockSize: `${bar.height + (isActive ? 4 : 0)}px` }}
						/>
					))}
				</div>
			</div>

			{props.state.kind === "idle" ? (
				<ConsentPanel
					consent={props.consent}
					onConsentChange={props.onConsentChange}
				/>
			) : null}

			{bookingCommitted ? (
				<div className="booking-confirmation">
					<strong>Лид и следующий шаг записаны</strong>
					<p>
						Это не календарная встреча. Команда Botamin получила договорённость
						и свяжется по оставленному контакту.
					</p>
				</div>
			) : null}

			<Transcript entries={props.transcript} />

			<TextChat
				conversationStage={props.conversationStage}
				textInputAvailable={props.textInputAvailable}
				textSubmission={props.textSubmission}
				onTextSubmit={props.onTextSubmit}
			/>

			<div className="voice-actions">
				<StateActions {...stateActions} />
				{showSessionControls ? (
					<fieldset className="session-controls">
						<legend className="visually-hidden">Управление разговором</legend>
						{props.state.kind === "listening" ||
						props.state.kind === "qualification" ? (
							<ControlButton className="is-emphasized" onClick={props.onCommit}>
								<span className="control-icon" aria-hidden="true">
									✓
								</span>
								Завершить реплику
							</ControlButton>
						) : null}
						<ControlButton
							buttonRef={muteButtonRef}
							aria-label="Отключение микрофона"
							aria-pressed={props.muted}
							onClick={props.onToggleMute}
						>
							<span aria-hidden="true">
								<span className="control-icon">{props.muted ? "×" : "│"}</span>
								{props.muted ? "Включить микрофон" : "Выключить микрофон"}
							</span>
						</ControlButton>
						{props.state.kind === "speaking" ? (
							<ControlButton
								className="is-interrupt"
								onClick={() => {
									handOffVoiceControlFocus("interrupt", focusTargets());
									props.onInterrupt();
								}}
							>
								<span className="control-icon" aria-hidden="true">
									↳
								</span>
								Перебить агента
							</ControlButton>
						) : null}
						<ControlButton className="is-stop" onClick={stateActions.onStop}>
							<span className="control-icon" aria-hidden="true">
								■
							</span>
							Завершить
						</ControlButton>
					</fieldset>
				) : null}
			</div>

			<p id="mic-requirement" className="mic-note">
				Нужен микрофон. Разговор можно завершить в любой момент.
			</p>
		</section>
	);
}
