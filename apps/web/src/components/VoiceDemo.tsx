import type { ButtonHTMLAttributes, ReactNode } from "react";

export type VoiceUiState =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "permission-denied" }
	| { kind: "listening" }
	| { kind: "processing" }
	| { kind: "thinking" }
	| { kind: "speaking" }
	| { kind: "booked" }
	| { kind: "qualification"; questionNumber: number; questionCount: number }
	| {
			kind: "complete";
			qualificationStatus?: "complete" | "partial" | "skipped";
	  }
	| { kind: "audio-error" }
	| { kind: "disconnected" }
	| { kind: "reconnecting"; attempt?: number }
	| { kind: "error" };

export interface FinalTranscriptEntry {
	id: string;
	speaker: "visitor" | "agent";
	/** Only committed user transcripts and visible assistant responses belong here. */
	text: string;
}

export interface VoiceConsent {
	voiceProcessing: boolean;
	contactProcessing: boolean;
}

export interface VoiceDemoActions {
	onConsentChange: (consent: VoiceConsent) => void;
	onStart: () => void;
	onRetryPermission: () => void;
	onToggleMute: () => void;
	onStop: () => void;
	onInterrupt: () => void;
	onReconnect: () => void;
	onRestart: () => void;
	onQualificationChoice: (accepted: boolean) => void;
}

export interface VoiceDemoProps extends VoiceDemoActions {
	state: VoiceUiState;
	consent: VoiceConsent;
	transcript: readonly FinalTranscriptEntry[];
	muted: boolean;
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
				detail: `Дополнительный вопрос ${state.questionNumber} из ${state.questionCount}. Можно остановиться в любой момент.`,
				tone: "active",
			};
		case "complete":
			return {
				label: "Разговор завершён",
				detail: "Спасибо. Лид и согласованный следующий шаг записаны.",
				tone: "success",
			};
		case "audio-error":
			return {
				label: "Продолжаем текстом",
				detail:
					"Звук ответа сейчас недоступен, но текст и уже записанный следующий шаг сохраняются.",
				tone: "warning",
			};
		case "disconnected":
			return {
				label: "Связь прервана",
				detail: "Можно восстановить этот разговор без повторной записи лида.",
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
				label: "Разговор не удалось продолжить",
				detail:
					"Попробуйте начать заново. Если лид уже был записан, он останется у команды.",
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

function ControlButton({
	children,
	className = "",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	children: ReactNode;
}) {
	return (
		<button
			className={`voice-control ${className}`.trim()}
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

function Transcript({ entries }: { entries: readonly FinalTranscriptEntry[] }) {
	return (
		<section className="transcript" aria-labelledby="transcript-title">
			<div className="transcript-heading">
				<h3 id="transcript-title">Текст разговора</h3>
				<span>только финальные реплики</span>
			</div>
			<div className="transcript-log" aria-live="polite" aria-atomic="false">
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
			<fieldset className="qualification-choice">
				<legend id="qualification-offer">
					Лид уже записан. Можно задать ещё 3–5 необязательных вопросов, чтобы
					команда лучше подготовила следующий шаг?
				</legend>
				<div>
					<ControlButton
						className="is-emphasized"
						onClick={() => props.onQualificationChoice(true)}
					>
						Да, продолжить
					</ControlButton>
					<ControlButton onClick={() => props.onQualificationChoice(false)}>
						Нет, завершить
					</ControlButton>
				</div>
			</fieldset>
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
				Начать новый разговор
			</ControlButton>
		);
	}
	return null;
}

export function VoiceDemo(props: VoiceDemoProps) {
	const presentation = getVoiceStatePresentation(props.state, props.muted);
	const isActive = ACTIVE_STATES.has(props.state.kind);
	const showSessionControls =
		isActive &&
		props.state.kind !== "connecting" &&
		props.state.kind !== "reconnecting" &&
		props.state.kind !== "booked";

	return (
		<section
			className={`voice-demo state-${props.state.kind}`}
			aria-labelledby="voice-demo-title"
			data-voice-state={props.state.kind}
		>
			<header className="voice-demo-header">
				<div>
					<p className="eyebrow">Живой демо-разговор · около 4 минут</p>
					<h2 id="voice-demo-title">Проверьте на своей задаче</h2>
				</div>
				<span className="demo-badge">AI-продавец</span>
			</header>

			<div
				className={`voice-status tone-${presentation.tone}`}
				role="status"
				aria-live="polite"
			>
				<div className="status-orbit" aria-hidden="true">
					<span />
				</div>
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

			{props.state.kind === "booked" || props.state.kind === "complete" ? (
				<div className="booking-confirmation" role="status">
					<strong>Лид и следующий шаг записаны</strong>
					<p>
						Это не календарная встреча. Команда Botamin получила договорённость
						и свяжется по оставленному контакту.
					</p>
				</div>
			) : null}

			<Transcript entries={props.transcript} />

			<div className="voice-actions">
				<StateActions {...props} />
				{showSessionControls ? (
					<fieldset className="session-controls">
						<legend className="visually-hidden">Управление разговором</legend>
						<ControlButton
							aria-pressed={props.muted}
							onClick={props.onToggleMute}
						>
							<span className="control-icon" aria-hidden="true">
								{props.muted ? "×" : "│"}
							</span>
							{props.muted ? "Включить микрофон" : "Выключить микрофон"}
						</ControlButton>
						{props.state.kind === "speaking" ? (
							<ControlButton
								className="is-interrupt"
								onClick={props.onInterrupt}
							>
								<span className="control-icon" aria-hidden="true">
									↳
								</span>
								Перебить агента
							</ControlButton>
						) : null}
						<ControlButton className="is-stop" onClick={props.onStop}>
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
