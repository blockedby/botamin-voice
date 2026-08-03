import type {
	BookingRevisionConfirmation,
	BookingService,
	BookingSnapshot,
	BrainDelta,
	BrainPort,
	BrainTurnInput,
	BrowserBookingDraft,
	Contact,
	CreateBookingInput,
	KnownFacts,
	LunaFactProposal,
	MeetingSlot,
	MeetingTimeBand,
	MeetingTimePreference,
	QualificationField,
	SafeErrorCode,
	SttPort,
	SttTranscriptionResult,
	ToolRequest,
	TtsAudioSegment,
	TtsPort,
} from "@botamin/contracts";
import {
	collectedQualificationFields,
	deriveBrowserBookingDraft,
	TtsAudioSegmentSchema,
} from "@botamin/contracts";
import {
	parseConcreteMeetingRequest,
	parseMeetingTimePreference,
} from "../domain/booking";
import {
	BookingDraftError,
	type BookingDraftStore,
} from "../domain/booking-draft/store";
import {
	type CountAmount,
	extractConversationFacts,
	type MonthlyLeadVolume,
} from "../domain/facts";
import type { ObservabilityMetrics } from "../observability";
import {
	type BookingSelectionResolution,
	resolveCurrentBookingCandidate,
} from "./booking-selection";
import { buildBrainContext } from "./context";
import { GenerationCoordinator } from "./generation";
import {
	allowedActions,
	BookingToolExecutor,
	type SafeToolExecution,
} from "./policy";
import { AtomicSttTurnGate } from "./reliability";
import {
	chunkPreparedSpeech,
	prepareSpeech,
	renderPreparedSpeech,
	SpeechBudgetGuard,
	type SpeechBudgetOptions,
	type SpeechChunkerOptions,
	SpeechPrefetchCoordinator,
	StreamingSentenceChunker,
} from "./speech";
import {
	type ConversationEvent,
	type ConversationState,
	createInitialConversationState,
	type TransitionResult,
	transition,
} from "./state";

export type OrchestratorEvent =
	| { type: "transcript.final"; turnId: string; text: string }
	| {
			type: "state.changed";
			generationId: string;
			from: ConversationState["stage"];
			to: ConversationState["stage"];
			reason: string;
			errorCode?: SafeErrorCode;
	  }
	| {
			type: "booking.draft.updated";
			generationId: string;
			requestId: string | null;
			bookingDraft: BrowserBookingDraft;
	  }
	| {
			type: "booking.committed";
			generationId: string;
			bookingId: string;
			created: boolean;
	  }
	| {
			type: "booking.updated";
			generationId: string;
			bookingId: string;
			qualificationStatus: "partial" | "complete" | "skipped";
			updatedFields: QualificationField[];
			qualificationFields: QualificationField[];
			updatedAt: string;
	  }
	| {
			type: "tool.result";
			generationId: string;
			callId: string | null;
			name?: "create_booking" | "append_booking_qualification";
			ok: boolean;
			replayedCall?: boolean;
			code?: SafeErrorCode;
	  }
	| { type: "text.delta"; generationId: string; text: string }
	| { type: "text.done"; generationId: string; text: string }
	| {
			type: "audio.segment";
			generationId: string;
			segmentId: string;
			sequence: number;
			contentType: TtsAudioSegment["contentType"];
			bytes: Uint8Array;
			final: true;
	  }
	| { type: "audio.done"; generationId: string }
	| { type: "assistant.interrupted"; generationId: string }
	| {
			type: "degraded";
			generationId: string;
			provider: "stt" | "brain" | "tts";
			code: SafeErrorCode;
			textFallback: string;
	  }
	| {
			type: "ignored";
			generationId: string;
			source:
				| "audio.commit"
				| "visitor.text.submit"
				| "stt"
				| "brain"
				| "tts"
				| "generation";
	  };

export interface ConversationOrchestratorOptions {
	conversationId: string;
	promptVersion: string;
	stt: SttPort;
	brain: BrainPort;
	bookings: BookingService;
	tts?: TtsPort | null;
	threadId?: string;
	initialState?: ConversationState;
	qualificationEnabled?: boolean;
	speechChunker?: SpeechChunkerOptions;
	speechBudgets?: SpeechBudgetOptions;
	createId?: () => string;
	metrics?: ObservabilityMetrics;
	/** Server wall clock shared with production booking candidate generation. */
	now?: () => Date;
	draftStore?: BookingDraftStore;
}

export interface AudioCommitInput {
	turnId: string;
	generationId: string;
	audio: Uint8Array;
	contentType: "audio/wav";
	language?: string;
	knownFacts: KnownFacts;
}

export interface TextSubmitInput {
	turnId: string;
	generationId: string;
	text: string;
	knownFacts: KnownFacts;
}

export interface DraftConfirmationInput {
	turnId: string;
	generationId: string;
	confirmation: BookingRevisionConfirmation;
}

interface RenderResult {
	visibleText: string;
	audioProduced: boolean;
}

interface SpeechSynthesisJob {
	segmentId: string;
	visibleFallback: string;
	startFailed: boolean;
	promise: Promise<SpeechSynthesisOutcome>;
}

type SpeechSynthesisOutcome =
	| { kind: "success"; result: TtsAudioSegment }
	| { kind: "failure" }
	| { kind: "stale" };

interface SpeechPipeline {
	turn: { turnId: string; generationId: string };
	controller: AbortController;
	pending: SpeechSynthesisJob[];
	failed: boolean;
	degraded: boolean;
	audioProduced: boolean;
}

interface TerminalResponsePermit {
	generationId: string;
	turnId: string;
}

interface ToolOutcome {
	execution: SafeToolExecution;
	events: OrchestratorEvent[];
	serverResponse?: string;
	terminalResponsePermit?: TerminalResponsePermit;
	suppressModelSpeech: boolean;
	/** The result settled while this generation still owned the turn. */
	publishable: boolean;
}

interface DeterministicFactUpdate {
	bookingDraft: BrowserBookingDraft | null;
	proposedFields: QualificationField[];
	alreadyAnswered: boolean;
	pendingDailyBasis: boolean;
}

interface PendingDraftConfirmation {
	revision: number;
	candidateId: string;
	generationId: string;
}

type PlaybackInterruptionReason =
	| "barge_in"
	| "user_stop"
	| "new_generation"
	| "playback_error";

const BOOKING_FAILURE =
	"Не получилось сохранить данные, поэтому я не буду подтверждать бронь. Проверьте контакт и попробуйте ещё раз.";
const QUALIFICATION_FAILURE =
	"Основные данные уже сохранены. Дополнительные ответы сейчас не удалось обновить, и на этом можно закончить.";
const MONTHLY_LEAD_VOLUME_QUESTION =
	"Сколько входящих лидов приходит за месяц?";
const SALES_MANAGER_COUNT_QUESTION =
	"Сколько менеджеров по продажам работает в вашей команде?";
const DAILY_LEAD_BASIS_QUESTION = "Это по рабочим или календарным дням?";
const DRAFT_CONFLICT_RESPONSE =
	"В данных есть расхождение. Выберите верный вариант в форме, и только после этого я смогу подтвердить встречу.";
const AMBIGUOUS_SLOT_RESPONSE =
	"Не удалось однозначно выбрать время. Назовите точное время или скажите: первый вариант либо второй вариант.";
const STALE_SLOT_RESPONSE =
	"Такого времени нет среди текущих вариантов. Выберите, пожалуйста, первый или второй вариант.";
const STALE_DRAFT_CONFIRMATION_RESPONSE =
	"Данные встречи изменились, поэтому прежнее подтверждение больше не действует. Проверьте актуальные данные и снова выберите время.";
const DRAFT_CONFIRMATION_DECLINED_RESPONSE =
	"Хорошо, встречу не сохраняю. Скажите, пожалуйста, что нужно изменить.";
const QUALIFICATION_COMPLETE_CONFIRMATION =
	"Дополнительные ответы сохранены. Спасибо, на этом всё.";
const QUALIFICATION_SKIPPED_CONFIRMATION =
	"Основные данные сохранены. Дополнительные вопросы пропущены, на этом всё.";
const BRAIN_FAILURE_BEFORE_BOOKING =
	"Сейчас не получается продолжить разговор. Данные ещё не были сохранены.";
const BRAIN_FAILURE_AFTER_BOOKING =
	"Основные данные уже сохранены. Дополнительные вопросы необязательны, и на этом можно закончить.";
const STT_FAILURE =
	"Речь сейчас не распознаётся. Повторите, пожалуйста, реплику ещё раз.";
const PRE_BOOKING_DECLINE =
	"Поняла, спасибо за разговор. Если задача станет актуальной, можно вернуться позже.";
const QUALIFICATION_DECLINE =
	"Поняла. Основные данные уже сохранены, дополнительные вопросы пропускаем.";
const TERMINAL_STAGES = new Set<ConversationState["stage"]>([
	"COMPLETE",
	"DECLINED",
	"ERROR",
]);

function isTerminalStage(stage: ConversationState["stage"]): boolean {
	return TERMINAL_STAGES.has(stage);
}

function missingQualificationQuestion(
	booking: NonNullable<ConversationState["booking"]>,
): string | null {
	const collected = new Set(
		collectedQualificationFields(booking.qualification ?? {}),
	);
	if (!collected.has("monthlyLeadVolume")) {
		return MONTHLY_LEAD_VOLUME_QUESTION;
	}
	if (!collected.has("salesManagerCount")) {
		return SALES_MANAGER_COUNT_QUESTION;
	}
	return null;
}

function formatCountAmount(amount: CountAmount, multiplier = 1): string {
	if (amount.kind === "integer") return String(amount.value * multiplier);
	return `${amount.min * multiplier}–${amount.max * multiplier}`;
}

function normalizeMonthly(value: MonthlyLeadVolume): string | null {
	if (value.kind === "monthly") {
		return `${formatCountAmount(value.amount)} в месяц`;
	}
	if (value.basisStatus !== "explicit") return null;
	return `${formatCountAmount(
		value.amount,
		value.basis === "business_day" ? 22 : 30,
	)} в месяц`;
}

function moscowSlotText(slot: MeetingSlot): string {
	const local = new Date(new Date(slot.startAt).getTime() + 3 * 60 * 60_000);
	const date = new Intl.DateTimeFormat("ru-RU", {
		day: "2-digit",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(local);
	const time = `${String(local.getUTCHours()).padStart(2, "0")}:${String(
		local.getUTCMinutes(),
	).padStart(2, "0")}`;
	return `${date} в ${time} по Москве`;
}

function bookingConfirmationText(
	booking: NonNullable<ConversationState["booking"]>,
	question: string | null,
): string {
	const contacts = booking.contacts
		.map((contact) => {
			if (contact.channel === "email") return `почта ${contact.value}`;
			if (contact.channel === "phone") return `телефон ${contact.value}`;
			return `Телеграм ${contact.value}`;
		})
		.join(", ");
	return `Внутренняя виртуальная встреча создана на ${moscowSlotText(
		booking.meetingSlot,
	)} для ${booking.name}, компания ${booking.company}. Контакты: ${contacts}. Внешнее календарное событие и приглашение не создавались.${
		question ? ` ${question}` : ""
	}`;
}

function qualificationConfirmation(
	status: "partial" | "complete" | "skipped",
	booking: NonNullable<ConversationState["booking"]>,
): string {
	if (status === "partial") {
		const question = missingQualificationQuestion(booking);
		return question
			? `Дополнительный ответ сохранён. ${question}`
			: QUALIFICATION_COMPLETE_CONFIRMATION;
	}
	if (status === "complete") return QUALIFICATION_COMPLETE_CONFIRMATION;
	return QUALIFICATION_SKIPPED_CONFIRMATION;
}

function normalizeIntentText(userText: string): string {
	return userText
		.toLocaleLowerCase("ru-RU")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

export type ConservativeNegativeIntent =
	| "pre_booking_refusal"
	| "qualification_decline"
	| null;

const PRE_BOOKING_REFUSAL_PATTERN =
	/^(?:нет спасибо|нет(?: спасибо)? (?:мне |нам )?не интересно|нет(?: спасибо)? я не заинтересован(?:а|ы)?|спасибо (?:мне |нам )?не интересно|(?:мне |нам )?не интересно|(?:я )?не заинтересован(?:а|ы)?|(?:меня|нас) (?:это )?не интересует|(?:это|мне это|нам это) не актуально(?: до свидания)?|не нужно|не надо|отказываюсь|я отказываюсь|не хочу (?:продолжать|общаться|разговаривать|оставлять контакты|бронировать)|давайте (?:закончим|завершим)(?: разговор)?|прекратим разговор|до свидания)(?: пожалуйста)?$/u;

/** High-precision refusal detection; objections and uncertain language stay put. */
export function classifyConservativeNegativeIntent(
	userText: string,
	state: ConversationState,
): ConservativeNegativeIntent {
	const normalized = normalizeIntentText(userText);
	if (
		!normalized ||
		normalized.length > 160 ||
		/[?？]/u.test(userText) ||
		/(?:^|\s)(?:но|может|пока)(?:\s|$)/u.test(normalized)
	) {
		return null;
	}
	if (state.booking === null) {
		return PRE_BOOKING_REFUSAL_PATTERN.test(normalized)
			? "pre_booking_refusal"
			: null;
	}
	if (state.stage === "BOOKED" && state.bookingConfirmationDelivered) {
		return /^(?:нет|нет спасибо|нет на этом вс[её]|на этом вс[её]|нет не задавайте|не задавайте|не надо|не нужно|не хочу|пропустим|давайте пропустим)(?: дополнительные вопросы)?$/u.test(
			normalized,
		)
			? "qualification_decline"
			: null;
	}
	if (state.stage === "POST_BOOKING_QUALIFICATION") {
		return /^(?:нет(?: спасибо)?|нет на этом вс[её]|на этом вс[её]|(?:(?:не хочу|не буду) (?:отвечать|продолжать)(?: на)?|не задавайте|давайте (?:закончим|завершим|пропустим)|пропустим)(?: дополнительные вопросы| опрос| квалификацию)?(?: пожалуйста)?)$/u.test(
			normalized,
		)
			? "qualification_decline"
			: null;
	}
	return null;
}

/**
 * Deterministic owner of atomic STT intake, one Luna turn, booking policy, and
 * complete OpenRouter MP3 phrase requests. Provider retries remain pure.
 */
export class ConversationOrchestrator {
	readonly conversationId: string;
	readonly #promptVersion: string;
	readonly #stt: SttPort;
	readonly #brain: BrainPort;
	readonly #tts: TtsPort | null;
	readonly #bookings: BookingService;
	readonly #tools: BookingToolExecutor;
	readonly #sttTurns = new AtomicSttTurnGate();
	readonly #generations = new GenerationCoordinator();
	readonly #budgets: SpeechBudgetGuard;
	readonly #prefetch = new SpeechPrefetchCoordinator();
	readonly #chunkerOptions: SpeechChunkerOptions;
	readonly #createId: () => string;
	readonly #metrics: ObservabilityMetrics | undefined;
	readonly #now: () => Date;
	readonly #draftStore: BookingDraftStore | undefined;
	readonly #activeCandidateMeetingSlots = new Map<
		string,
		{ turnId: string; candidates: [MeetingSlot, MeetingSlot] }
	>();
	readonly #pendingDynamicEvents = new Map<string, OrchestratorEvent[]>();
	readonly #deferredDomainEvents: Array<
		Extract<
			OrchestratorEvent,
			{ type: "booking.committed" | "booking.updated" }
		>
	> = [];
	readonly #pendingDynamicResponses = new Map<
		string,
		Array<{
			text: string;
			suppressModelSpeech: boolean;
			terminalResponsePermit?: TerminalResponsePermit;
		}>
	>();
	#threadId: string | undefined;
	#state: ConversationState;
	#timeOfDayPreference: MeetingTimePreference = "none";
	#rejectedTimeOfDayPreferences: MeetingTimeBand[] = [];
	#pendingDailyLeadVolume: CountAmount | null = null;
	#pendingDraftConfirmation: PendingDraftConfirmation | null = null;
	#lifecycleInterruption: Promise<void> = Promise.resolve();
	#closed = false;
	#closePromise: Promise<void> | null = null;

	constructor(options: ConversationOrchestratorOptions) {
		this.conversationId = options.conversationId;
		this.#promptVersion = options.promptVersion;
		this.#stt = options.stt;
		this.#brain = options.brain;
		this.#tts = options.tts ?? null;
		this.#bookings = options.bookings;
		this.#tools = new BookingToolExecutor(options.bookings);
		this.#threadId = options.threadId;
		this.#state =
			options.initialState ??
			createInitialConversationState(
				options.qualificationEnabled === undefined
					? undefined
					: { qualificationEnabled: options.qualificationEnabled },
			);
		this.#chunkerOptions = options.speechChunker ?? {};
		this.#budgets = new SpeechBudgetGuard(options.speechBudgets);
		this.#createId = options.createId ?? (() => Bun.randomUUIDv7());
		this.#metrics = options.metrics;
		this.#now = options.now ?? (() => new Date());
		this.#draftStore = options.draftStore;
		if (this.#state.stage === "DISCONNECTED") this.#sttTurns.suspend();
		else if (isTerminalStage(this.#state.stage)) this.#sttTurns.close();
	}

	get state(): ConversationState {
		return this.#state;
	}

	get promptVersion(): string {
		return this.#promptVersion;
	}

	get acceptedAudioCommits(): number {
		return this.#sttTurns.acceptedCommits;
	}

	/** Recovers an orphan commit, then hydrates in-memory state from durable data. */
	async reconcileDurableBooking(): Promise<BookingSnapshot | null> {
		const store = this.#draftStore;
		if (!store) return null;
		let draft = store.reconcile(this.conversationId);
		if (draft.commitStatus === "committing") {
			try {
				const result = await this.#bookings.createBooking(
					store.committingBookingInput(this.conversationId),
				);
				const booking = await this.#bookings.findByConversationId(
					this.conversationId,
				);
				if (!booking || booking.id !== result.bookingId) {
					throw new BookingDraftError("BOOKING_MISMATCH");
				}
				draft = store.reconcile(this.conversationId);
			} catch (error) {
				const booking = await this.#bookings
					.findByConversationId(this.conversationId)
					.catch(() => null);
				if (booking) {
					draft = store.reconcile(this.conversationId);
				} else if (
					error instanceof BookingDraftError ||
					this.#isBookingValidationError(error)
				) {
					draft = this.#markOrphanFailed(store, draft.revision);
					if (draft.commitStatus !== "committed") return null;
				} else {
					// Unknown database failures retain the immutable committing draft so a
					// later attach can retry without racing an uncertain durable write.
					throw error;
				}
			}
		}
		if (draft.commitStatus !== "committed" || !draft.bookingId) return null;
		const booking = await this.#bookings.findByConversationId(
			this.conversationId,
		);
		if (!booking || booking.id !== draft.bookingId) {
			throw new BookingDraftError("BOOKING_MISMATCH");
		}
		// Qualification data proves only that facts were stored. It can never prove
		// that the server confirmation text was delivered or retained.
		const bookingConfirmationDelivered =
			this.#state.bookingConfirmationDelivered;
		const durableStage: ConversationState["stage"] =
			!bookingConfirmationDelivered
				? "BOOKED"
				: booking.qualificationStatus === "complete" ||
						booking.qualificationStatus === "skipped"
					? "COMPLETE"
					: this.#state.qualificationEnabled
						? "POST_BOOKING_QUALIFICATION"
						: "BOOKED";
		if (this.#state.stage === "DISCONNECTED") {
			this.#state = {
				...this.#state,
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered,
				resumeStage: durableStage,
			};
		} else if (!isTerminalStage(this.#state.stage)) {
			this.#state = {
				...this.#state,
				stage: durableStage,
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered,
				resumeStage: null,
			};
			if (durableStage === "COMPLETE") this.#sttTurns.close();
		} else {
			this.#state = { ...this.#state, booking };
		}
		return booking;
	}

	#isBookingValidationError(error: unknown): boolean {
		return (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "BOOKING_VALIDATION_FAILED"
		);
	}

	#markOrphanFailed(
		store: BookingDraftStore,
		expectedRevision: number,
	): NonNullable<ReturnType<BookingDraftStore["load"]>> {
		try {
			return store.markFailed(this.conversationId, expectedRevision);
		} catch (error) {
			const current = store.reconcile(this.conversationId);
			if (
				current.commitStatus === "failed" ||
				current.commitStatus === "committed"
			) {
				return current;
			}
			throw error;
		}
	}

	apply(event: ConversationEvent): TransitionResult {
		const result = transition(this.#state, event);
		if (!result.ok) return result;
		const previousStage = this.#state.stage;
		this.#state = result.state;
		if (this.#state.stage === previousStage) return result;
		if (
			this.#state.stage === "DISCONNECTED" ||
			this.#state.stage !== "COLLECT_BOOKING"
		) {
			this.#pendingDraftConfirmation = null;
		}
		if (this.#state.stage === "DISCONNECTED") {
			this.#sttTurns.suspend();
			this.#lifecycleInterruption = this.#invalidateActiveWork("disconnect");
		} else if (previousStage === "DISCONNECTED") {
			if (isTerminalStage(this.#state.stage)) this.#sttTurns.close();
			else this.#sttTurns.reopen();
		} else if (isTerminalStage(this.#state.stage)) {
			this.#sttTurns.close();
			this.#lifecycleInterruption = this.#invalidateActiveWork("terminal");
		}
		return result;
	}

	/** Callback passed to CodexAppServerBrain only when dynamic mode is enabled. */
	readonly executeDynamicTool = async (
		request: ToolRequest,
		input: BrainTurnInput,
	): Promise<{ ok: boolean }> => {
		const activeCandidates = this.#activeCandidateMeetingSlots.get(
			input.generationId,
		);
		if (
			input.conversationId !== this.conversationId ||
			!this.#canProcessTurns() ||
			!this.#generations.accept(input.generationId, input.turnId) ||
			activeCandidates?.turnId !== input.turnId
		) {
			return { ok: false };
		}
		const outcome = await this.#performTool(
			input.generationId,
			input.turnId,
			request,
			activeCandidates.candidates,
		);
		if (outcome.publishable) {
			this.#pendingDynamicEvents.set(input.generationId, [
				...(this.#pendingDynamicEvents.get(input.generationId) ?? []),
				...outcome.events,
			]);
			if (outcome.serverResponse) {
				this.#pendingDynamicResponses.set(input.generationId, [
					...(this.#pendingDynamicResponses.get(input.generationId) ?? []),
					{
						text: outcome.serverResponse,
						suppressModelSpeech: outcome.suppressModelSpeech,
						...(outcome.terminalResponsePermit
							? { terminalResponsePermit: outcome.terminalResponsePermit }
							: {}),
					},
				]);
			}
		}
		return { ok: outcome.execution.ok };
	};

	/** One accepted audio.commit owns one atomic SttPort request and final. */
	async *acceptAudioCommit(
		input: AudioCommitInput,
	): AsyncGenerator<OrchestratorEvent> {
		if (!this.#canProcessTurns()) {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "audio.commit",
			};
			return;
		}
		const accepted = this.#sttTurns.acceptCommit(input.turnId);
		if (!accepted.ok) {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "audio.commit",
			};
			return;
		}

		await this.#interruptActiveGeneration();
		if (!this.#canProcessTurns() || !this.#sttTurns.isCurrent(accepted.turn)) {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "audio.commit",
			};
			return;
		}
		let final: SttTranscriptionResult;
		try {
			this.#metrics?.markSttRequest(input.turnId);
			final = await this.#stt.transcribe({
				conversationId: this.conversationId,
				turnId: input.turnId,
				audio: input.audio,
				contentType: input.contentType,
				language: input.language ?? "ru",
				signal: accepted.turn.signal,
			});
		} catch {
			if (this.#sttTurns.isCurrent(accepted.turn)) {
				yield {
					type: "degraded",
					generationId: input.generationId,
					provider: "stt",
					code: "STT_UNAVAILABLE",
					textFallback: STT_FAILURE,
				};
				this.#sttTurns.finish(accepted.turn);
			}
			return;
		}

		if (
			!this.#canProcessTurns() ||
			final.conversationId !== this.conversationId ||
			!this.#sttTurns.acceptFinal(accepted.turn, final)
		) {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "stt",
			};
			return;
		}
		const userText = final.text.trim();
		this.#metrics?.markFinalTranscript(input.turnId);
		this.#sttTurns.finish(accepted.turn);
		yield* this.#acceptFinalTurn({
			turnId: input.turnId,
			generationId: input.generationId,
			userText,
			knownFacts: input.knownFacts,
			source: "voice_transcript",
		});
	}

	/** Bypasses STT while entering the exact same final-turn brain/policy path. */
	async *acceptTextSubmit(
		input: TextSubmitInput,
	): AsyncGenerator<OrchestratorEvent> {
		if (!this.canAcceptVisitorTurn) {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "visitor.text.submit",
			};
			return;
		}
		const userText = input.text.trim();
		if (!userText) {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "visitor.text.submit",
			};
			return;
		}
		this.#metrics?.markFinalTranscript(input.turnId);
		yield* this.#acceptFinalTurn({
			...input,
			userText,
			source: "typed_message",
		});
	}

	get canAcceptVisitorTurn(): boolean {
		return (
			this.#canProcessTurns() &&
			this.#state.stage !== "IDLE" &&
			this.#state.stage !== "CONNECTING"
		);
	}

	/** Clears a spoken confirmation permit after a successful external mutation. */
	invalidatePendingDraftConfirmation(): void {
		this.#pendingDraftConfirmation = null;
	}

	/** Server-owned commit path for an exact confirmed current draft revision. */
	async *confirmBookingDraft(
		input: DraftConfirmationInput,
	): AsyncGenerator<OrchestratorEvent> {
		this.#pendingDraftConfirmation = null;
		const store = this.#draftStore;
		if (!store) throw new BookingDraftError("INVALID_TRANSITION");
		await this.reconcileDurableBooking();
		const existing = store.load(this.conversationId);
		if (existing?.commitStatus === "committed") {
			yield {
				type: "booking.draft.updated",
				generationId: input.generationId,
				requestId: input.confirmation.requestId,
				bookingDraft: deriveBrowserBookingDraft(existing),
			};
			return;
		}
		if (
			this.#state.stage !== "COLLECT_BOOKING" ||
			!this.#state.contactConsentConfirmed ||
			!this.#canProcessTurns()
		) {
			throw new BookingDraftError("INVALID_TRANSITION");
		}
		let active: ReturnType<GenerationCoordinator["start"]>["active"];
		try {
			active = this.#generations.start(input.generationId, input.turnId).active;
		} catch {
			throw new BookingDraftError("INVALID_TRANSITION");
		}
		void active;
		this.#budgets.startTurn();
		let confirmed = store.confirm(this.conversationId, input.confirmation);
		if (confirmed.commitStatus === "committed") {
			yield {
				type: "booking.draft.updated",
				generationId: input.generationId,
				requestId: input.confirmation.requestId,
				bookingDraft: deriveBrowserBookingDraft(confirmed),
			};
			this.#generations.finish(input.generationId);
			return;
		}
		const committing = store.markCommitting(
			this.conversationId,
			confirmed.revision,
		);
		const createInput = store.committingBookingInput(this.conversationId);
		let created = false;
		let booking = null as Awaited<
			ReturnType<BookingService["findByConversationId"]>
		>;
		try {
			const result = await this.#bookings.createBooking(createInput);
			created = result.created;
			booking = await this.#bookings.findByConversationId(this.conversationId);
			if (!booking || booking.id !== result.bookingId) {
				throw new BookingDraftError("BOOKING_MISMATCH");
			}
			confirmed = store.reconcile(this.conversationId);
		} catch (error) {
			booking = await this.#bookings
				.findByConversationId(this.conversationId)
				.catch(() => null);
			if (booking) {
				confirmed = store.reconcile(this.conversationId);
			} else {
				if (this.#isBookingValidationError(error)) {
					confirmed = this.#markOrphanFailed(store, committing.revision);
					yield {
						type: "booking.draft.updated",
						generationId: input.generationId,
						requestId: input.confirmation.requestId,
						bookingDraft: deriveBrowserBookingDraft(confirmed),
					};
				}
				this.#generations.finish(input.generationId);
				throw error;
			}
		}
		if (!booking) throw new BookingDraftError("BOOKING_MISMATCH");
		const from = this.#state.stage;
		const committedState = this.apply({ type: "booking_committed", booking });
		if (!committedState.ok) {
			const disconnected =
				(this.#state.stage as ConversationState["stage"]) === "DISCONNECTED";
			if (!disconnected) {
				throw new BookingDraftError("INVALID_TRANSITION");
			}
			this.#state = {
				...this.#state,
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: false,
				resumeStage: "BOOKED",
			};
		}
		yield {
			type: "booking.draft.updated",
			generationId: input.generationId,
			requestId: input.confirmation.requestId,
			bookingDraft: deriveBrowserBookingDraft(confirmed),
		};
		yield {
			type: "booking.committed",
			generationId: input.generationId,
			bookingId: booking.id,
			created,
		};
		if (committedState.ok) {
			yield {
				type: "state.changed",
				generationId: input.generationId,
				from,
				to: "BOOKED",
				reason: "booking_draft_committed",
			};
		}
		if (!committedState.ok) return;
		const text = bookingConfirmationText(
			booking,
			this.#qualificationQuestionForConfirmation(booking),
		);
		const delivered = yield* this.#deliverBookingConfirmation(input, text);
		const rendered = delivered.rendered;
		const terminal = delivered.terminal;
		if (terminal) {
			yield* this.#finishTerminalResponse(
				{ generationId: input.generationId, turnId: input.turnId },
				[rendered.visibleText],
				rendered.audioProduced,
			);
		} else {
			yield* this.#finishGeneration(
				input.generationId,
				[rendered.visibleText],
				rendered.audioProduced,
			);
		}
	}

	async interrupt(
		generationId: string,
		reason: PlaybackInterruptionReason = "barge_in",
	): Promise<OrchestratorEvent> {
		if (
			reason !== "playback_error" &&
			this.#pendingDraftConfirmation?.generationId === generationId
		) {
			this.#pendingDraftConfirmation = null;
		}
		const active = this.#generations.current();
		if (!active || active.generationId !== generationId) {
			return { type: "ignored", generationId, source: "generation" };
		}
		await this.#invalidateActiveWork("interrupted");
		return { type: "assistant.interrupted", generationId };
	}

	async disconnect(): Promise<void> {
		if (this.#closed) return;
		if (this.#state.stage !== "DISCONNECTED")
			this.apply({ type: "disconnect" });
		await this.#lifecycleInterruption;
	}

	/** Permanently fences intake and releases shared provider session state. */
	close(timeoutMs = 5_000): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#sttTurns.close();
		const interruption = this.#invalidateActiveWork("conversation_closed");
		const releaseBrain = this.#brain.releaseConversation
			? this.#brain
					.releaseConversation(this.conversationId)
					.catch(() => undefined)
			: Promise.resolve();
		const resetTts = this.#tts?.resetSession
			? Promise.resolve(this.#tts.resetSession(this.conversationId)).catch(
					() => undefined,
				)
			: Promise.resolve();
		this.#activeCandidateMeetingSlots.clear();
		this.#pendingDynamicEvents.clear();
		this.#pendingDynamicResponses.clear();
		this.#deferredDomainEvents.length = 0;
		this.#threadId = undefined;
		this.#tools.clear();
		this.#generations.close();
		this.#closePromise = Promise.all([
			settleWithin(interruption, timeoutMs),
			settleWithin(releaseBrain, timeoutMs),
			settleWithin(resetTts, timeoutMs),
		]).then(() => undefined);
		return this.#closePromise;
	}

	async *#acceptFinalTurn(input: {
		turnId: string;
		generationId: string;
		userText: string;
		knownFacts: KnownFacts;
		source: "voice_transcript" | "typed_message";
	}): AsyncGenerator<OrchestratorEvent> {
		const pendingConfirmation = this.#pendingDraftConfirmation;
		this.#pendingDraftConfirmation = null;
		if (pendingConfirmation) {
			const confirmationIntent = extractConversationFacts({
				source: "visitor",
				accepted: true,
				text: input.userText,
				context: { pendingConfirmation: true },
			}).intents.confirmation;
			if (confirmationIntent === "confirmed") {
				yield {
					type: "transcript.final",
					turnId: input.turnId,
					text: input.userText,
				};
				const draft = this.#draftStore?.load(this.conversationId);
				if (
					draft?.revision !== pendingConfirmation.revision ||
					draft.readiness !== "ready" ||
					draft.confirmationStatus !== "unconfirmed" ||
					(draft.commitStatus !== "uncommitted" &&
						draft.commitStatus !== "failed") ||
					draft.selectedCandidate?.candidateId !==
						pendingConfirmation.candidateId
				) {
					yield* this.#renderDeterministicFinalResponse(
						input,
						STALE_DRAFT_CONFIRMATION_RESPONSE,
					);
					return;
				}
				yield* this.confirmBookingDraft({
					turnId: input.turnId,
					generationId: input.generationId,
					confirmation: {
						requestId: this.#createId(),
						revision: pendingConfirmation.revision,
					},
				});
				return;
			}
			if (confirmationIntent === "declined") {
				yield {
					type: "transcript.final",
					turnId: input.turnId,
					text: input.userText,
				};
				yield* this.#renderDeterministicFinalResponse(
					input,
					DRAFT_CONFIRMATION_DECLINED_RESPONSE,
				);
				return;
			}
		}

		const factUpdate = this.#ingestIntoExistingDraft(input);
		const negativeIntent = classifyConservativeNegativeIntent(
			input.userText,
			this.#state,
		);
		if (negativeIntent) {
			const from = this.#state.stage;
			let refusalBooking = this.#state.booking;
			let refusalUpdate:
				| Extract<OrchestratorEvent, { type: "booking.updated" }>
				| undefined;
			if (negativeIntent === "qualification_decline" && refusalBooking) {
				const persisted = await this.#persistQualificationRefusal(
					input.turnId,
					input.generationId,
				);
				refusalBooking = persisted.booking;
				refusalUpdate = persisted.event;
			}
			const declined = this.apply(
				negativeIntent === "qualification_decline"
					? {
							type: "qualification_refused",
							...(refusalBooking ? { booking: refusalBooking } : {}),
						}
					: { type: "clear_refusal" },
			);
			if (declined.ok) {
				const text = this.#state.booking
					? QUALIFICATION_DECLINE
					: PRE_BOOKING_DECLINE;
				yield {
					type: "transcript.final",
					turnId: input.turnId,
					text: input.userText,
				};
				if (factUpdate?.bookingDraft) {
					yield {
						type: "booking.draft.updated",
						generationId: input.generationId,
						requestId: null,
						bookingDraft: factUpdate.bookingDraft,
					};
				}
				if (refusalUpdate) yield refusalUpdate;
				yield { type: "text.delta", generationId: input.generationId, text };
				yield { type: "text.done", generationId: input.generationId, text };
				yield {
					type: "state.changed",
					generationId: input.generationId,
					from,
					to: this.#state.stage,
					reason: "explicit_user_refusal",
				};
				return;
			}
		}

		let active: ReturnType<GenerationCoordinator["start"]>["active"];
		try {
			active = this.#generations.start(input.generationId, input.turnId).active;
		} catch {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "generation",
			};
			return;
		}
		yield {
			type: "transcript.final",
			turnId: input.turnId,
			text: input.userText,
		};
		if (factUpdate?.bookingDraft) {
			yield {
				type: "booking.draft.updated",
				generationId: input.generationId,
				requestId: null,
				bookingDraft: factUpdate.bookingDraft,
			};
		}
		if (this.#state.stage === "POST_BOOKING_QUALIFICATION") {
			const handled = yield* this.#handleDeterministicQualification(
				input,
				factUpdate,
			);
			if (handled) return;
		}
		yield* this.#runBrainTurn(input, active);
	}

	async *#renderDeterministicFinalResponse(
		input: { turnId: string; generationId: string },
		text: string,
	): AsyncGenerator<OrchestratorEvent> {
		try {
			this.#generations.start(input.generationId, input.turnId);
		} catch {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "generation",
			};
			return;
		}
		this.#budgets.startTurn();
		const rendered = yield* this.#renderPhrase(input, text);
		yield* this.#finishGeneration(
			input.generationId,
			[rendered.visibleText],
			rendered.audioProduced,
		);
	}

	async *#runBrainTurn(
		input: {
			turnId: string;
			generationId: string;
			userText: string;
			knownFacts: KnownFacts;
			source: "voice_transcript" | "typed_message";
		},
		active: { signal: AbortSignal },
	): AsyncGenerator<OrchestratorEvent> {
		if (
			!this.#canProcessTurns() ||
			!this.#generations.accept(input.generationId, input.turnId)
		) {
			return;
		}
		this.#budgets.startTurn();
		for (const event of this.#deferredDomainEvents.splice(0)) {
			yield { ...event, generationId: input.generationId };
		}
		const visible: string[] = [];
		let audioProduced = false;

		if (
			this.#state.stage === "BOOKED" &&
			this.#state.booking &&
			!this.#state.bookingConfirmationDelivered
		) {
			const text = bookingConfirmationText(
				this.#state.booking,
				this.#qualificationQuestionForConfirmation(this.#state.booking),
			);
			const delivered = yield* this.#deliverBookingConfirmation(input, text);
			if (delivered.rendered.visibleText) {
				visible.push(delivered.rendered.visibleText);
			}
			audioProduced ||= delivered.rendered.audioProduced;
			if (delivered.terminal) {
				yield* this.#finishTerminalResponse(
					{ generationId: input.generationId, turnId: input.turnId },
					visible,
					audioProduced,
				);
			} else {
				yield* this.#finishGeneration(
					input.generationId,
					visible,
					audioProduced,
				);
			}
			return;
		}

		const streamingApprovedContacts: Contact[] = this.#state
			.contactConsentConfirmed
			? this.#state.booking
				? this.#state.booking.contacts
				: (this.#draftStore?.approvedContacts(this.conversationId) ?? [])
			: [];
		const chunker = new StreamingSentenceChunker(
			this.#chunkerOptions,
			streamingApprovedContacts,
		);
		const heldActionSpeech: string[] = [];
		let suppressModelSpeech = false;
		let toolSettledThisTurn = false;
		let brainFailure: Extract<BrainDelta, { type: "error" }> | undefined;
		let schedulingReady = false;
		try {
			const now = this.#now();
			const concreteRequest = parseConcreteMeetingRequest(input.userText, now);
			const draftBeforeRefresh = this.#draftStore?.load(this.conversationId);
			const selectionBeforeRefresh =
				this.#state.stage === "COLLECT_BOOKING" && draftBeforeRefresh
					? resolveCurrentBookingCandidate(
							input.userText,
							draftBeforeRefresh.candidates,
							now,
						)
					: ({ kind: "none" } satisfies BookingSelectionResolution);
			if (
				concreteRequest.kind === "none" &&
				selectionBeforeRefresh.kind === "none"
			) {
				const parsedPreference = parseMeetingTimePreference(input.userText);
				if (parsedPreference.kind === "selected") {
					this.#timeOfDayPreference = parsedPreference.preference;
					this.#rejectedTimeOfDayPreferences = [];
				} else if (parsedPreference.kind === "rejected") {
					this.#timeOfDayPreference = "none";
					this.#rejectedTimeOfDayPreferences = [parsedPreference.preference];
				}
			} else if (concreteRequest.kind !== "none") {
				this.#timeOfDayPreference = "none";
				this.#rejectedTimeOfDayPreferences = [];
			}
			const candidateMeetingSlots = await this.#bookings.candidateMeetingSlots(
				this.#timeOfDayPreference,
				this.#rejectedTimeOfDayPreferences,
				concreteRequest.kind === "none"
					? undefined
					: {
							userText: input.userText,
							currentInstant: now.toISOString(),
						},
			);
			if (!this.#generations.accept(input.generationId, input.turnId)) return;
			const refreshedDraft = this.#refreshDraftForCandidates(
				input,
				candidateMeetingSlots,
			);
			if (refreshedDraft) {
				yield {
					type: "booking.draft.updated",
					generationId: input.generationId,
					requestId: null,
					bookingDraft: refreshedDraft,
				};
			}
			if (!this.#generations.accept(input.generationId, input.turnId)) return;
			let directDraft = this.#draftStore?.load(this.conversationId);
			if (this.#state.stage === "COLLECT_BOOKING" && directDraft) {
				const selection = resolveCurrentBookingCandidate(
					input.userText,
					directDraft.candidates,
					now,
				);
				if (selection.kind === "selected") {
					if (
						directDraft.selectedCandidate?.candidateId !== selection.candidateId
					) {
						directDraft = this.#draftStore?.setSelectedCandidate(
							this.conversationId,
							directDraft.revision,
							selection.candidateId,
						);
						if (directDraft) {
							yield {
								type: "booking.draft.updated",
								generationId: input.generationId,
								requestId: null,
								bookingDraft: deriveBrowserBookingDraft(directDraft),
							};
						}
					}
				} else if (
					selection.kind === "ambiguous" ||
					selection.kind === "not_current"
				) {
					if (directDraft.selectedCandidate) {
						directDraft = this.#draftStore?.setSelectedCandidate(
							this.conversationId,
							directDraft.revision,
							null,
						);
						if (directDraft) {
							yield {
								type: "booking.draft.updated",
								generationId: input.generationId,
								requestId: null,
								bookingDraft: deriveBrowserBookingDraft(directDraft),
							};
						}
					}
					this.#pendingDraftConfirmation = null;
					const text =
						selection.kind === "ambiguous"
							? AMBIGUOUS_SLOT_RESPONSE
							: STALE_SLOT_RESPONSE;
					const rendered = yield* this.#renderPhrase(input, text);
					yield* this.#finishGeneration(
						input.generationId,
						[rendered.visibleText],
						rendered.audioProduced,
					);
					return;
				}

				if (!directDraft) return;
				const hasConflict = Object.values(directDraft.factRegistry.facts).some(
					(fact) => fact.status === "conflicted",
				);
				if (hasConflict || directDraft.readiness === "ready") {
					const text = hasConflict
						? DRAFT_CONFLICT_RESPONSE
						: this.#draftConfirmationQuestion(directDraft);
					const rendered = yield* this.#renderPhrase(input, text);
					if (
						!hasConflict &&
						directDraft.readiness === "ready" &&
						directDraft.selectedCandidate &&
						rendered.visibleText &&
						this.#generations.accept(input.generationId, input.turnId)
					) {
						this.#pendingDraftConfirmation = {
							revision: directDraft.revision,
							candidateId: directDraft.selectedCandidate.candidateId,
							generationId: input.generationId,
						};
					}
					yield* this.#finishGeneration(
						input.generationId,
						[rendered.visibleText],
						rendered.audioProduced,
					);
					return;
				}
			}
			const context = buildBrainContext({
				conversationId: this.conversationId,
				...(this.#threadId ? { threadId: this.#threadId } : {}),
				turnId: input.turnId,
				generationId: input.generationId,
				userText: input.userText,
				stage: this.#state.stage,
				knownFacts: input.knownFacts,
				booking: this.#state.booking,
				allowedActions: allowedActions(this.#state),
				promptVersion: this.#promptVersion,
				now,
				timeOfDayPreference: this.#timeOfDayPreference,
				rejectedTimeOfDayPreferences: this.#rejectedTimeOfDayPreferences,
				concreteRequest,
				candidateMeetingSlots,
			});
			schedulingReady = true;
			this.#activeCandidateMeetingSlots.set(input.generationId, {
				turnId: input.turnId,
				candidates: candidateMeetingSlots,
			});
			this.#threadId ??= await this.#brain.createThread(this.conversationId);
			if (!this.#generations.accept(input.generationId, input.turnId)) return;

			// Exactly one BrainPort.runTurn call per accepted final transcript.
			for await (const delta of this.#brain.runTurn(context, active.signal)) {
				if (!this.#acceptBrainDelta(input, delta)) {
					yield {
						type: "ignored",
						generationId: delta.generationId,
						source: "brain",
					};
					continue;
				}

				if (delta.type === "speech.delta") {
					this.#metrics?.markFirstLlmDelta(input.turnId);
				}

				for (const event of this.#takeDynamicEvents(input.generationId)) {
					yield event;
				}
				for (const dynamicResponse of this.#takeDynamicResponses(
					input.generationId,
				)) {
					let terminalResponsePermit = dynamicResponse.terminalResponsePermit;
					const rendered = yield* this.#renderToolResponse(
						input,
						dynamicResponse.text,
						terminalResponsePermit,
					);
					if (rendered.visibleText) visible.push(rendered.visibleText);
					audioProduced ||= rendered.audioProduced;
					suppressModelSpeech ||= dynamicResponse.suppressModelSpeech;
					if (!terminalResponsePermit) {
						if (!this.#generations.accept(input.generationId, input.turnId))
							return;
						if (this.#state.stage === "BOOKED") {
							this.apply({ type: "booking_confirmation_delivered" });
							if (!this.#state.qualificationEnabled) {
								this.apply({ type: "complete" });
								terminalResponsePermit = {
									generationId: input.generationId,
									turnId: input.turnId,
								};
							}
						}
					}
					if (isTerminalStage(this.#state.stage)) {
						if (!terminalResponsePermit) return;
						yield* this.#finishTerminalResponse(
							terminalResponsePermit,
							visible,
							audioProduced,
						);
						return;
					}
				}

				if (delta.type === "error") {
					brainFailure = delta;
					break;
				}
				if (delta.type === "turn.completed") {
					const stageEvent = this.#applyBrainStageProposal(
						input.generationId,
						toolSettledThisTurn ? undefined : delta.nextStage,
					);
					if (stageEvent) yield stageEvent;
					continue;
				}
				if (delta.type === "tool.request") {
					const outcome = await this.#performTool(
						input.generationId,
						input.turnId,
						delta.tool,
						context.schedulingContext.candidateMeetingSlots.map(
							(candidate) => candidate.meetingSlot,
						) as [MeetingSlot, MeetingSlot],
					);
					toolSettledThisTurn = true;
					for (const event of outcome.events) yield event;
					chunker.clear();
					heldActionSpeech.length = 0;
					suppressModelSpeech ||= outcome.suppressModelSpeech;
					if (outcome.serverResponse) {
						let terminalResponsePermit = outcome.terminalResponsePermit;
						const rendered = yield* this.#renderToolResponse(
							input,
							outcome.serverResponse,
							terminalResponsePermit,
						);
						if (rendered.visibleText) visible.push(rendered.visibleText);
						audioProduced ||= rendered.audioProduced;
						if (!terminalResponsePermit) {
							if (!this.#generations.accept(input.generationId, input.turnId))
								return;
							if (this.#state.stage === "BOOKED") {
								this.apply({ type: "booking_confirmation_delivered" });
								if (!this.#state.qualificationEnabled) {
									this.apply({ type: "complete" });
									terminalResponsePermit = {
										generationId: input.generationId,
										turnId: input.turnId,
									};
								}
							}
						}
						if (isTerminalStage(this.#state.stage)) {
							if (!terminalResponsePermit) return;
							yield* this.#finishTerminalResponse(
								terminalResponsePermit,
								visible,
								audioProduced,
							);
							return;
						}
					}
					continue;
				}
				if (suppressModelSpeech) continue;
				const ready = chunker.push(delta.text);
				if (allowedActions(this.#state).length > 0) {
					heldActionSpeech.push(...ready);
					continue;
				}
				const rendered = yield* this.#renderPhrases(input, ready);
				visible.push(...rendered.visibleTexts);
				audioProduced ||= rendered.audioProduced;
			}

			for (const event of this.#takeDynamicEvents(input.generationId))
				yield event;
			for (const dynamicResponse of this.#takeDynamicResponses(
				input.generationId,
			)) {
				let terminalResponsePermit = dynamicResponse.terminalResponsePermit;
				const rendered = yield* this.#renderToolResponse(
					input,
					dynamicResponse.text,
					terminalResponsePermit,
				);
				if (rendered.visibleText) visible.push(rendered.visibleText);
				audioProduced ||= rendered.audioProduced;
				suppressModelSpeech ||= dynamicResponse.suppressModelSpeech;
				if (!terminalResponsePermit) {
					if (!this.#generations.accept(input.generationId, input.turnId))
						return;
					if (this.#state.stage === "BOOKED") {
						this.apply({ type: "booking_confirmation_delivered" });
						if (!this.#state.qualificationEnabled) {
							this.apply({ type: "complete" });
							terminalResponsePermit = {
								generationId: input.generationId,
								turnId: input.turnId,
							};
						}
					}
				}
				if (isTerminalStage(this.#state.stage)) {
					if (!terminalResponsePermit) return;
					yield* this.#finishTerminalResponse(
						terminalResponsePermit,
						visible,
						audioProduced,
					);
					return;
				}
			}
			if (!suppressModelSpeech && !brainFailure) {
				const rendered = yield* this.#renderPhrases(input, [
					...heldActionSpeech,
					...chunker.flush(),
				]);
				visible.push(...rendered.visibleTexts);
				audioProduced ||= rendered.audioProduced;
			}
		} catch {
			brainFailure = {
				type: "error",
				turnId: input.turnId,
				generationId: input.generationId,
				error: {
					code: schedulingReady ? "BRAIN_PROTOCOL_ERROR" : "DB_UNAVAILABLE",
					message: schedulingReady
						? "Brain turn failed"
						: "Scheduling context is unavailable",
					retryable: true,
				},
			};
		}

		if (
			brainFailure &&
			this.#generations.accept(input.generationId, input.turnId)
		) {
			const fallback = this.#state.booking
				? BRAIN_FAILURE_AFTER_BOOKING
				: BRAIN_FAILURE_BEFORE_BOOKING;
			const from = this.#state.stage;
			const failed = this.apply({ type: "provider_failed" });
			if (failed.ok && this.#state.stage === "ERROR") {
				yield {
					type: "state.changed",
					generationId: input.generationId,
					from,
					to: "ERROR",
					reason: "provider_failed",
					errorCode: brainFailure.error.code,
				};
				yield {
					type: "degraded",
					generationId: input.generationId,
					provider: "brain",
					code: brainFailure.error.code,
					textFallback: fallback,
				};
				yield {
					type: "text.delta",
					generationId: input.generationId,
					text: fallback,
				};
				visible.push(fallback);
				yield* this.#finishTerminalResponse(
					{ generationId: input.generationId, turnId: input.turnId },
					visible,
					audioProduced,
				);
				return;
			}
		}

		yield* this.#finishGeneration(input.generationId, visible, audioProduced);
	}

	#ingestIntoExistingDraft(input: {
		turnId: string;
		userText: string;
		source: "voice_transcript" | "typed_message";
	}): DeterministicFactUpdate | null {
		const store = this.#draftStore;
		const draft = store?.load(this.conversationId);
		if (!store || !draft || draft.commitStatus === "committing") return null;
		const expectedField = this.#expectedQualificationField();
		const extracted = extractConversationFacts({
			source: "visitor",
			accepted: true,
			text: input.userText,
			...(expectedField
				? { context: { expectedField, correctionExpected: true } }
				: {}),
		});
		if (extracted.kind !== "extracted") return null;
		const proposals: LunaFactProposal[] = [];
		let pendingDailyBasis = false;
		let derivedMonthly: string | null = null;
		for (const proposal of extracted.proposals) {
			if (
				draft.commitStatus === "committed" &&
				proposal.field !== "monthlyLeadVolume" &&
				proposal.field !== "salesManagerCount"
			) {
				continue;
			}
			if (proposal.field === "monthlyLeadVolume") {
				const normalized = normalizeMonthly(proposal.value);
				if (normalized === null) {
					this.#pendingDailyLeadVolume = proposal.value.amount;
					pendingDailyBasis = true;
					continue;
				}
				this.#pendingDailyLeadVolume = null;
				proposals.push({
					field: "monthlyLeadVolume",
					value: normalized,
					quote: proposal.source.evidence,
				});
				continue;
			}
			proposals.push({
				field: proposal.field === "email" ? "workEmail" : proposal.field,
				value: proposal.value,
				quote: proposal.source.evidence,
			} as LunaFactProposal);
		}
		const hasMonthlyProposal = proposals.some(
			(proposal) => proposal.field === "monthlyLeadVolume",
		);
		if (
			this.#pendingDailyLeadVolume &&
			expectedField === "monthlyLeadVolume" &&
			!hasMonthlyProposal
		) {
			const normalized = input.userText
				.toLocaleLowerCase("ru-RU")
				.replace(/[^\p{L}\s]/gu, " ")
				.replace(/\s+/gu, " ")
				.trim();
			const multiplier = /(?:рабоч|будн)/u.test(normalized)
				? 22
				: /календар/u.test(normalized)
					? 30
					: null;
			if (multiplier !== null) {
				derivedMonthly = `${formatCountAmount(
					this.#pendingDailyLeadVolume,
					multiplier,
				)} в месяц`;
				this.#pendingDailyLeadVolume = null;
				pendingDailyBasis = false;
			}
		}
		if (proposals.length === 0 && derivedMonthly === null) {
			return {
				bookingDraft: null,
				proposedFields: [],
				alreadyAnswered: extracted.intents.alreadyAnswered,
				pendingDailyBasis,
			};
		}
		try {
			let updated = draft;
			if (proposals.length > 0) {
				updated = store.ingestProposals({
					conversationId: this.conversationId,
					expectedRevision: updated.revision,
					source: input.source,
					turnId: input.turnId,
					currentTurnText: input.userText,
					proposals,
				});
			}
			if (derivedMonthly !== null) {
				updated = store.ingestServerDerivation({
					conversationId: this.conversationId,
					expectedRevision: updated.revision,
					turnId: input.turnId,
					currentTurnText: input.userText,
					field: "monthlyLeadVolume",
					value: derivedMonthly,
					evidenceText: input.userText.trim(),
				});
			}
			const proposedFields = proposals
				.map((proposal) => proposal.field)
				.filter(
					(field): field is QualificationField =>
						field === "monthlyLeadVolume" || field === "salesManagerCount",
				);
			if (derivedMonthly !== null) proposedFields.push("monthlyLeadVolume");
			return {
				bookingDraft: deriveBrowserBookingDraft(updated),
				proposedFields,
				alreadyAnswered: extracted.intents.alreadyAnswered,
				pendingDailyBasis,
			};
		} catch {
			return null;
		}
	}

	#refreshDraftForCandidates(
		input: {
			turnId: string;
			userText: string;
			source: "voice_transcript" | "typed_message";
		},
		candidateMeetingSlots: [MeetingSlot, MeetingSlot],
	): BrowserBookingDraft | null {
		const store = this.#draftStore;
		if (!store) return null;
		let draft = store.load(this.conversationId);
		if (!draft) {
			draft = store.initialize(this.conversationId, candidateMeetingSlots);
			return (
				this.#ingestIntoExistingDraft(input)?.bookingDraft ??
				deriveBrowserBookingDraft(draft)
			);
		}
		if (
			draft.commitStatus === "committed" ||
			draft.commitStatus === "committing"
		) {
			return null;
		}
		const same = draft.candidates.every((candidate, index) => {
			const slot = candidateMeetingSlots[index];
			return (
				slot !== undefined &&
				candidate.meetingSlot.startAt === slot.startAt &&
				candidate.meetingSlot.endAt === slot.endAt &&
				candidate.meetingSlot.timeZone === slot.timeZone
			);
		});
		if (same) return null;
		draft = store.refreshCandidates(
			this.conversationId,
			draft.revision,
			candidateMeetingSlots,
		);
		this.#pendingDraftConfirmation = null;
		return deriveBrowserBookingDraft(draft);
	}

	#expectedQualificationField(): QualificationField | undefined {
		if (this.#state.stage !== "POST_BOOKING_QUALIFICATION") return undefined;
		const qualification = this.#state.booking?.qualification ?? {};
		if (qualification.monthlyLeadVolume === undefined) {
			return "monthlyLeadVolume";
		}
		if (qualification.salesManagerCount === undefined) {
			return "salesManagerCount";
		}
		return undefined;
	}

	#qualificationQuestionForConfirmation(
		booking: BookingSnapshot,
	): string | null {
		if (!this.#state.qualificationEnabled) return null;
		const accepted = this.#draftStore?.acceptedFacts(this.conversationId) ?? {};
		const effectiveBooking: BookingSnapshot = {
			...booking,
			qualification: {
				...(booking.qualification ?? {}),
				...(accepted.monthlyLeadVolume === undefined
					? {}
					: { monthlyLeadVolume: accepted.monthlyLeadVolume }),
				...(accepted.salesManagerCount === undefined
					? {}
					: { salesManagerCount: accepted.salesManagerCount }),
			},
		};
		if (
			this.#pendingDailyLeadVolume &&
			effectiveBooking.qualification?.monthlyLeadVolume === undefined
		) {
			return DAILY_LEAD_BASIS_QUESTION;
		}
		return missingQualificationQuestion(effectiveBooking);
	}

	#draftConfirmationQuestion(
		draft: NonNullable<ReturnType<BookingDraftStore["load"]>>,
	): string {
		const facts = this.#draftStore?.acceptedFacts(this.conversationId) ?? {};
		const selected = draft.selectedCandidate;
		const contacts =
			this.#draftStore?.approvedContacts(this.conversationId) ?? [];
		if (!facts.name || !facts.company || !selected) {
			return "Проверьте обязательные данные и выберите один из текущих вариантов времени.";
		}
		const contactText = contacts
			.map((contact) => {
				if (contact.channel === "email") return `почта ${contact.value}`;
				if (contact.channel === "phone") return `телефон ${contact.value}`;
				return `Телеграм ${contact.value}`;
			})
			.join(", ");
		return `Подтвердите, пожалуйста: ${facts.name}, компания ${facts.company}, ${contactText}, встреча ${moscowSlotText(selected.meetingSlot)}. Всё верно?`;
	}

	async *#handleDeterministicQualification(
		input: { turnId: string; generationId: string },
		update: DeterministicFactUpdate | null,
	): AsyncGenerator<OrchestratorEvent, boolean> {
		if (!this.#state.booking) return false;
		if (update?.pendingDailyBasis) {
			const rendered = yield* this.#renderPhrase(
				input,
				DAILY_LEAD_BASIS_QUESTION,
			);
			yield* this.#finishGeneration(
				input.generationId,
				[rendered.visibleText],
				rendered.audioProduced,
			);
			return true;
		}
		if (
			!update ||
			(update.proposedFields.length === 0 && !update.alreadyAnswered)
		) {
			return false;
		}
		const event = await this.#applyAcceptedDraftQualification(
			input.turnId,
			input.generationId,
		);
		if (event) yield event;
		const booking = this.#state.booking;
		if (!booking) return true;
		let question = missingQualificationQuestion(booking);
		let text: string;
		if (update.alreadyAnswered && question && !event) {
			const accepted = this.#draftStore?.acceptedFacts(this.conversationId);
			const askedFactKnown =
				question === MONTHLY_LEAD_VOLUME_QUESTION
					? accepted?.monthlyLeadVolume !== undefined
					: accepted?.salesManagerCount !== undefined;
			if (askedFactKnown) {
				question = null;
				text =
					"Да, этот ответ уже сохранён в данных разговора. Повторять вопрос не буду.";
			} else {
				text = `В сохранённых данных этого ответа пока нет. ${question}`;
			}
		} else {
			text = question ? question : QUALIFICATION_COMPLETE_CONFIRMATION;
		}
		const rendered = yield* this.#renderPhrase(input, text);
		if (!question && booking.qualificationStatus === "complete") {
			const from = this.#state.stage;
			const completed = this.apply({ type: "qualification_completed" });
			if (completed.ok) {
				yield {
					type: "state.changed",
					generationId: input.generationId,
					from,
					to: "COMPLETE",
					reason: "qualification_complete",
				};
			}
		}
		yield* this.#finishGeneration(
			input.generationId,
			[rendered.visibleText],
			rendered.audioProduced,
		);
		return true;
	}

	async #applyAcceptedDraftQualification(
		_turnId: string,
		generationId: string,
	): Promise<Extract<OrchestratorEvent, { type: "booking.updated" }> | null> {
		const current = this.#state.booking;
		const store = this.#draftStore;
		const qualificationStageRetained =
			this.#state.stage === "POST_BOOKING_QUALIFICATION" ||
			(this.#state.stage === "DISCONNECTED" &&
				this.#state.resumeStage === "POST_BOOKING_QUALIFICATION");
		if (
			!current ||
			!store ||
			!this.#state.bookingConfirmationDelivered ||
			!qualificationStageRetained
		) {
			return null;
		}
		const accepted = store.acceptedFacts(this.conversationId);
		const patch: { monthlyLeadVolume?: string; salesManagerCount?: number } =
			{};
		if (
			current.qualification?.monthlyLeadVolume === undefined &&
			accepted.monthlyLeadVolume !== undefined
		) {
			patch.monthlyLeadVolume = accepted.monthlyLeadVolume;
		}
		if (
			current.qualification?.salesManagerCount === undefined &&
			accepted.salesManagerCount !== undefined
		) {
			patch.salesManagerCount = accepted.salesManagerCount;
		}
		if (Object.keys(patch).length === 0) return null;
		const merged = { ...(current.qualification ?? {}), ...patch };
		const completion =
			merged.monthlyLeadVolume !== undefined &&
			merged.salesManagerCount !== undefined
				? "complete"
				: "partial";
		try {
			const draft = store.load(this.conversationId);
			const result = await this.#bookings.appendQualification({
				bookingId: current.id,
				idempotencyKey: `draft-qualification-${draft?.revision ?? 0}-${current.id}`,
				patch,
				completion,
			});
			const booking = await this.#bookings.findByConversationId(
				this.conversationId,
			);
			if (!booking || booking.id !== current.id) return null;
			const updated = this.apply({ type: "qualification_updated", booking });
			if (!updated.ok) this.#state = { ...this.#state, booking };
			return {
				type: "booking.updated",
				generationId,
				bookingId: booking.id,
				qualificationStatus: result.qualificationStatus,
				updatedFields: result.updatedFields,
				qualificationFields: collectedQualificationFields(
					booking.qualification ?? {},
				),
				updatedAt: booking.updatedAt,
			};
		} catch {
			return null;
		}
	}

	async #persistQualificationRefusal(
		turnId: string,
		generationId: string,
	): Promise<{
		booking: NonNullable<ConversationState["booking"]>;
		event?: Extract<OrchestratorEvent, { type: "booking.updated" }>;
	}> {
		const current = this.#state.booking;
		if (!current) throw new Error("Qualification refusal requires a booking");
		if (
			collectedQualificationFields(current.qualification ?? {}).length > 0 ||
			current.qualificationStatus === "skipped"
		) {
			return { booking: current };
		}
		try {
			const result = await this.#bookings.appendQualification({
				bookingId: current.id,
				idempotencyKey: `qualification-refusal-${turnId}`,
				patch: {},
				completion: "skipped",
			});
			const booking = await this.#bookings.findByConversationId(
				this.conversationId,
			);
			if (!booking || booking.id !== current.id) return { booking: current };
			return {
				booking,
				event: {
					type: "booking.updated",
					generationId,
					bookingId: booking.id,
					qualificationStatus: result.qualificationStatus,
					updatedFields: result.updatedFields,
					qualificationFields: collectedQualificationFields(
						booking.qualification ?? {},
					),
					updatedAt: booking.updatedAt,
				},
			};
		} catch {
			return { booking: current };
		}
	}

	#applyBrainStageProposal(
		generationId: string,
		nextStage: ConversationState["stage"] | undefined,
	): Extract<OrchestratorEvent, { type: "state.changed" }> | null {
		const from = this.#state.stage;
		if (!nextStage || nextStage === from) return null;
		const edge = `${from}->${nextStage}`;
		let event: ConversationEvent | null = null;
		switch (edge) {
			case "GREETING->DISCOVERY":
				event = { type: "discovery_requested" };
				break;
			case "GREETING->BOOKING_OFFER":
			case "DISCOVERY->BOOKING_OFFER":
			case "VALUE->BOOKING_OFFER":
			case "OBJECTION->BOOKING_OFFER":
				event = { type: "booking_offered" };
				break;
			case "DISCOVERY->VALUE":
				event = { type: "value_ready" };
				break;
			case "VALUE->OBJECTION":
				event = { type: "objection_raised" };
				break;
			case "OBJECTION->VALUE":
				event = { type: "objection_resolved" };
				break;
			case "BOOKING_OFFER->COLLECT_BOOKING":
				event = { type: "booking_accepted" };
				break;
		}
		if (!event) return null;
		const result = this.apply(event);
		if (!result.ok || this.#state.stage !== nextStage) return null;
		return {
			type: "state.changed",
			generationId,
			from,
			to: nextStage,
			reason: "brain_stage_proposal_validated",
		};
	}

	#acceptBrainDelta(
		input: { turnId: string; generationId: string },
		delta: BrainDelta,
	): boolean {
		return (
			this.#canProcessTurns() &&
			this.#generations.accept(input.generationId, input.turnId) &&
			delta.generationId === input.generationId &&
			delta.turnId === input.turnId
		);
	}

	#draftAuthorizesModelCreate(input: CreateBookingInput): boolean {
		const store = this.#draftStore;
		const draft = store?.load(this.conversationId);
		if (
			!store ||
			!draft ||
			draft.confirmationStatus !== "confirmed" ||
			draft.commitStatus !== "uncommitted" ||
			!draft.selectedCandidate
		) {
			return false;
		}
		const facts = store.acceptedFacts(this.conversationId);
		const contacts = store.approvedContacts(this.conversationId);
		return (
			input.conversationId === this.conversationId &&
			input.consentConfirmed === true &&
			input.name === facts.name &&
			input.company === facts.company &&
			input.meetingSlot.startAt ===
				draft.selectedCandidate.meetingSlot.startAt &&
			input.meetingSlot.endAt === draft.selectedCandidate.meetingSlot.endAt &&
			input.meetingSlot.timeZone ===
				draft.selectedCandidate.meetingSlot.timeZone &&
			input.contacts.length === contacts.length &&
			input.contacts.every((contact) =>
				contacts.some(
					(approved) =>
						approved.channel === contact.channel &&
						approved.value === contact.value,
				),
			)
		);
	}

	async #performTool(
		generationId: string,
		turnId: string,
		request: ToolRequest,
		candidateMeetingSlots: [MeetingSlot, MeetingSlot],
	): Promise<ToolOutcome> {
		if (
			!this.#canProcessTurns() ||
			!this.#generations.accept(generationId, turnId)
		) {
			return {
				execution: {
					ok: false,
					callId: request.callId,
					code: "ACTION_NOT_ALLOWED_IN_STATE",
					message: "Tool turn is no longer current",
				},
				events: [],
				suppressModelSpeech: true,
				publishable: false,
			};
		}
		if (
			request.name === "create_booking" &&
			this.#draftStore &&
			!this.#draftAuthorizesModelCreate(request.args)
		) {
			return {
				execution: {
					ok: false,
					callId: request.callId,
					code: "ACTION_NOT_ALLOWED_IN_STATE",
					message: "The model booking does not match a confirmed server draft",
				},
				events: [
					{
						type: "tool.result",
						generationId,
						callId: request.callId,
						ok: false,
						code: "ACTION_NOT_ALLOWED_IN_STATE",
					},
				],
				serverResponse: BOOKING_FAILURE,
				suppressModelSpeech: true,
				publishable: true,
			};
		}
		let execution: SafeToolExecution;
		try {
			execution = await this.#tools.execute(
				this.#state,
				this.conversationId,
				candidateMeetingSlots,
				request,
			);
		} catch (error) {
			this.#metrics?.recordBooking(
				request.name === "create_booking" ? "create" : "update",
				"failure",
			);
			throw error;
		}
		this.#metrics?.recordBooking(
			request.name === "create_booking" ? "create" : "update",
			execution.ok
				? execution.value.replayedCall
					? "replay"
					: "success"
				: "failure",
		);
		const stillCurrent =
			this.#canProcessTurns() && this.#generations.accept(generationId, turnId);
		if (!execution.ok) {
			if (!stillCurrent) {
				return {
					execution,
					events: [],
					suppressModelSpeech: true,
					publishable: false,
				};
			}
			return {
				execution,
				events: [
					{
						type: "tool.result",
						generationId,
						callId: execution.callId,
						ok: false,
						code: execution.code,
					},
				],
				serverResponse:
					request.name === "create_booking"
						? BOOKING_FAILURE
						: QUALIFICATION_FAILURE,
				suppressModelSpeech: true,
				publishable: true,
			};
		}

		const events: OrchestratorEvent[] = [];
		let from: ConversationState["stage"] | undefined;
		if (!execution.value.replayedCall) {
			from = this.#state.stage;
			if (execution.value.name === "create_booking") {
				const committed = this.apply({
					type: "booking_committed",
					booking: execution.value.booking,
				});
				if (!committed.ok) {
					// The durable booking is authoritative, but stale work must never
					// reopen a disconnected or terminal conversation.
					const preserveStage =
						this.#state.stage === "DISCONNECTED" ||
						isTerminalStage(this.#state.stage);
					this.#state = {
						...this.#state,
						stage: preserveStage ? this.#state.stage : "BOOKED",
						booking: execution.value.booking,
						bookingConfirmationDelivered: false,
						resumeStage:
							this.#state.stage === "DISCONNECTED"
								? "BOOKED"
								: this.#state.resumeStage,
					};
				}
				events.push({
					type: "booking.committed",
					generationId,
					bookingId: execution.value.result.bookingId,
					created: execution.value.result.created,
				});
			} else {
				const updated = this.apply({
					type: "qualification_updated",
					booking: execution.value.booking,
				});
				if (!updated.ok) {
					this.#state = { ...this.#state, booking: execution.value.booking };
				}
				events.push({
					type: "booking.updated",
					generationId,
					bookingId: execution.value.result.bookingId,
					qualificationStatus: execution.value.result.qualificationStatus,
					updatedFields: execution.value.result.updatedFields,
					qualificationFields: collectedQualificationFields(
						execution.value.booking.qualification ?? {},
					),
					updatedAt: execution.value.booking.updatedAt,
				});
				if (
					execution.value.result.qualificationStatus === "complete" ||
					execution.value.result.qualificationStatus === "skipped"
				) {
					const completed = this.apply({ type: "qualification_completed" });
					if (!completed.ok) {
						if (this.#state.stage === "DISCONNECTED") {
							this.#state = { ...this.#state, resumeStage: "COMPLETE" };
						} else if (!isTerminalStage(this.#state.stage)) {
							this.#state = { ...this.#state, stage: "COMPLETE" };
							this.#sttTurns.close();
							this.#lifecycleInterruption =
								this.#invalidateActiveWork("terminal");
						}
					}
				}
			}
		}
		if (!stillCurrent) {
			if (!this.#closed) {
				for (const event of events) {
					if (
						event.type === "booking.committed" ||
						event.type === "booking.updated"
					) {
						this.#deferredDomainEvents.push(event);
					}
				}
			}
			return {
				execution,
				events: [],
				suppressModelSpeech: true,
				publishable: false,
			};
		}
		events.push({
			type: "tool.result",
			generationId,
			callId: execution.value.callId,
			name: execution.value.name,
			ok: true,
			replayedCall: execution.value.replayedCall,
		});
		if (from && from !== this.#state.stage) {
			events.push({
				type: "state.changed",
				generationId,
				from,
				to: this.#state.stage,
				reason:
					execution.value.name === "create_booking"
						? "booking_committed"
						: "qualification_updated",
			});
		}
		const serverResponse = execution.value.replayedCall
			? undefined
			: execution.value.name === "create_booking"
				? bookingConfirmationText(
						execution.value.booking,
						this.#state.qualificationEnabled
							? missingQualificationQuestion(execution.value.booking)
							: null,
					)
				: qualificationConfirmation(
						execution.value.result.qualificationStatus,
						execution.value.booking,
					);
		return {
			execution,
			events,
			...(serverResponse ? { serverResponse } : {}),
			...(serverResponse && isTerminalStage(this.#state.stage)
				? {
						terminalResponsePermit: { generationId, turnId },
					}
				: {}),
			suppressModelSpeech: true,
			publishable: true,
		};
	}

	async *#renderToolResponse(
		turn: { turnId: string; generationId: string },
		visibleText: string,
		terminalResponsePermit?: TerminalResponsePermit,
	): AsyncGenerator<OrchestratorEvent, RenderResult> {
		const visible = visibleText.replace(/\s+/gu, " ").trim();
		if (!visible) return { visibleText: "", audioProduced: false };
		if (isTerminalStage(this.#state.stage)) {
			if (
				terminalResponsePermit?.generationId !== turn.generationId ||
				terminalResponsePermit.turnId !== turn.turnId
			) {
				return { visibleText: "", audioProduced: false };
			}
			// This permit proves the durable tool settled while the generation still
			// owned the turn. Terminal policy forbids starting TTS for its response.
			yield {
				type: "text.delta",
				generationId: turn.generationId,
				text: visible,
			};
			return { visibleText: visible, audioProduced: false };
		}
		return yield* this.#renderPhrase(turn, visible);
	}

	async *#deliverBookingConfirmation(
		turn: { turnId: string; generationId: string },
		visibleText: string,
	): AsyncGenerator<
		OrchestratorEvent,
		{ rendered: RenderResult; terminal: boolean }
	> {
		const visible = visibleText.replace(/\s+/gu, " ").trim();
		if (!visible || !this.#generations.accept(turn.generationId, turn.turnId)) {
			return {
				rendered: { visibleText: "", audioProduced: false },
				terminal: false,
			};
		}

		// Resuming after this yield proves the text event was consumed by the
		// transport mapper and retained, even if the socket detaches before TTS.
		yield {
			type: "text.delta",
			generationId: turn.generationId,
			text: visible,
		};
		const confirmationFrom = this.#state.stage;
		const confirmed = this.apply({ type: "booking_confirmation_delivered" });
		if (!confirmed.ok) {
			return {
				rendered: { visibleText: visible, audioProduced: false },
				terminal: false,
			};
		}
		if (this.#state.stage !== confirmationFrom) {
			yield {
				type: "state.changed",
				generationId: turn.generationId,
				from: confirmationFrom,
				to: this.#state.stage,
				reason: "booking_confirmation_retained",
			};
		}

		const qualificationEvent = this.#state.qualificationEnabled
			? await this.#applyAcceptedDraftQualification(
					turn.turnId,
					turn.generationId,
				)
			: null;
		if (qualificationEvent) yield qualificationEvent;

		const audioProduced = yield* this.#renderSpokenPhrase(turn, visible);
		let terminal = false;
		const booking = this.#state.booking;
		if (
			this.#state.qualificationEnabled &&
			booking &&
			(booking.qualificationStatus === "complete" ||
				booking.qualificationStatus === "skipped")
		) {
			const completeFrom = this.#state.stage;
			const completed = this.apply({ type: "qualification_completed" });
			if (completed.ok) {
				terminal = this.#state.stage === "COMPLETE";
				if (this.#state.stage !== completeFrom) {
					yield {
						type: "state.changed",
						generationId: turn.generationId,
						from: completeFrom,
						to: this.#state.stage,
						reason: "qualification_complete",
					};
				}
			}
		} else if (!this.#state.qualificationEnabled) {
			const completeFrom = this.#state.stage;
			const completed = this.apply({ type: "complete" });
			if (completed.ok) {
				terminal = this.#state.stage === "COMPLETE";
				if (this.#state.stage !== completeFrom) {
					yield {
						type: "state.changed",
						generationId: turn.generationId,
						from: completeFrom,
						to: this.#state.stage,
						reason: "qualification_disabled",
					};
				}
			}
		}
		return {
			rendered: { visibleText: visible, audioProduced },
			terminal,
		};
	}

	async *#renderPhrase(
		turn: { turnId: string; generationId: string },
		visibleText: string,
	): AsyncGenerator<OrchestratorEvent, RenderResult> {
		const rendered = yield* this.#renderPhrases(turn, [visibleText]);
		return {
			visibleText: rendered.visibleTexts[0] ?? "",
			audioProduced: rendered.audioProduced,
		};
	}

	async *#renderPhrases(
		turn: { turnId: string; generationId: string },
		visibleTexts: readonly string[],
	): AsyncGenerator<
		OrchestratorEvent,
		{ visibleTexts: string[]; audioProduced: boolean }
	> {
		const visible: string[] = [];
		if (!this.#generations.accept(turn.generationId, turn.turnId)) {
			return { visibleTexts: visible, audioProduced: false };
		}
		const pipeline = this.#createSpeechPipeline(turn);
		const approvedContacts: Contact[] = this.#state.booking
			? this.#state.booking.contacts
			: (this.#draftStore?.approvedContacts(this.conversationId) ?? []);
		for (const sourceText of visibleTexts) {
			const text = sourceText.replace(/\s+/gu, " ").trim();
			if (!text || !this.#generations.accept(turn.generationId, turn.turnId)) {
				continue;
			}
			visible.push(text);
			yield {
				type: "text.delta",
				generationId: turn.generationId,
				text,
			};
			const prepared = prepareSpeech(text, {
				contactProcessing: this.#state.contactConsentConfirmed,
				approvedContacts,
			});
			if (prepared.spokenText) {
				yield* this.#enqueuePreparedSpeech(pipeline, prepared, text);
			}
		}
		yield* this.#drainSpeechPipeline(pipeline);
		return { visibleTexts: visible, audioProduced: pipeline.audioProduced };
	}

	async *#renderSpokenPhrase(
		turn: { turnId: string; generationId: string },
		visible: string,
	): AsyncGenerator<OrchestratorEvent, boolean> {
		if (!this.#generations.accept(turn.generationId, turn.turnId)) return false;
		const approvedContacts: Contact[] = this.#state.booking
			? this.#state.booking.contacts
			: (this.#draftStore?.approvedContacts(this.conversationId) ?? []);
		const prepared = prepareSpeech(visible, {
			contactProcessing: this.#state.contactConsentConfirmed,
			approvedContacts,
		});
		if (!prepared.spokenText) return false;
		const pipeline = this.#createSpeechPipeline(turn);
		yield* this.#enqueuePreparedSpeech(pipeline, prepared, visible);
		yield* this.#drainSpeechPipeline(pipeline);
		return pipeline.audioProduced;
	}

	#createSpeechPipeline(turn: {
		turnId: string;
		generationId: string;
	}): SpeechPipeline {
		const controller = new AbortController();
		const generationSignal = this.#generations.signal(turn.generationId);
		if (generationSignal.aborted) {
			controller.abort(generationSignal.reason);
		} else {
			generationSignal.addEventListener(
				"abort",
				() => controller.abort(generationSignal.reason),
				{ once: true },
			);
		}
		return {
			turn,
			controller,
			pending: [],
			failed: false,
			degraded: false,
			audioProduced: false,
		};
	}

	async *#enqueuePreparedSpeech(
		pipeline: SpeechPipeline,
		prepared: ReturnType<typeof prepareSpeech>,
		visibleFallback: string,
	): AsyncGenerator<OrchestratorEvent> {
		if (pipeline.failed) return;
		if (!this.#tts) {
			pipeline.failed = true;
			pipeline.degraded = true;
			yield {
				type: "degraded",
				generationId: pipeline.turn.generationId,
				provider: "tts",
				code: "TTS_UNAVAILABLE",
				textFallback: visibleFallback,
			};
			return;
		}
		const rendered = renderPreparedSpeech(prepared);
		for (const spoken of chunkPreparedSpeech(rendered, this.#chunkerOptions)) {
			while (pipeline.pending.length >= 2 && !pipeline.failed) {
				yield* this.#drainNextSpeechJob(pipeline);
			}
			if (pipeline.failed) return;
			const job = this.#startSpeechJob(pipeline, spoken, visibleFallback);
			pipeline.pending.push(job);
			if (job.startFailed) break;
		}
	}

	#startSpeechJob(
		pipeline: SpeechPipeline,
		spoken: string,
		visibleFallback: string,
	): SpeechSynthesisJob {
		const segmentId = this.#createId();
		if (!this.#tts || !this.#prefetch.tryStart(segmentId)) {
			return {
				segmentId,
				visibleFallback,
				startFailed: true,
				promise: Promise.resolve({ kind: "failure" }),
			};
		}
		const budget = this.#budgets.reserve(spoken);
		if (!budget.ok) {
			this.#prefetch.finish(segmentId);
			return {
				segmentId,
				visibleFallback,
				startFailed: true,
				promise: Promise.resolve({ kind: "failure" }),
			};
		}

		const tts = this.#tts;
		const turn = pipeline.turn;
		const request = Object.freeze({
			conversationId: this.conversationId,
			turnId: turn.turnId,
			generationId: turn.generationId,
			segmentId,
			text: spoken,
			signal: pipeline.controller.signal,
		});
		const ttsStartedAt = this.#metrics?.markTtsRequest();
		const promise = Promise.resolve()
			.then(() => tts.synthesize(request))
			.then((rawResult): SpeechSynthesisOutcome => {
				const result = TtsAudioSegmentSchema.parse(rawResult);
				if (
					pipeline.controller.signal.aborted ||
					!this.#generations.accept(turn.generationId, turn.turnId)
				) {
					return { kind: "stale" };
				}
				if (
					result.generationId !== turn.generationId ||
					result.segmentId !== segmentId
				) {
					return { kind: "failure" };
				}
				return { kind: "success", result };
			})
			.catch(
				(): SpeechSynthesisOutcome =>
					pipeline.controller.signal.aborted ||
					!this.#generations.accept(turn.generationId, turn.turnId)
						? { kind: "stale" }
						: { kind: "failure" },
			)
			.then((outcome) => {
				if (ttsStartedAt !== undefined) {
					this.#metrics?.recordTtsCompletion(ttsStartedAt, outcome.kind);
				}
				return outcome;
			})
			.finally(() => this.#prefetch.finish(segmentId));
		return { segmentId, visibleFallback, startFailed: false, promise };
	}

	async *#drainNextSpeechJob(
		pipeline: SpeechPipeline,
	): AsyncGenerator<OrchestratorEvent> {
		const job = pipeline.pending.shift();
		if (!job) return;
		const outcome = await job.promise;
		if (pipeline.failed) return;
		if (
			outcome.kind === "stale" ||
			!this.#generations.accept(
				pipeline.turn.generationId,
				pipeline.turn.turnId,
			)
		) {
			pipeline.failed = true;
			pipeline.controller.abort("stale TTS pipeline");
			pipeline.pending.length = 0;
			return;
		}
		if (outcome.kind === "failure") {
			pipeline.failed = true;
			pipeline.controller.abort("ordered TTS failure");
			// Later promises are already rejection-safe and retain their global
			// coordinator slots until settlement, but no buffered audio is retained
			// by this ordered publisher after the first failure.
			pipeline.pending.length = 0;
			if (!pipeline.degraded) {
				pipeline.degraded = true;
				yield {
					type: "degraded",
					generationId: pipeline.turn.generationId,
					provider: "tts",
					code: "TTS_UNAVAILABLE",
					textFallback: job.visibleFallback,
				};
			}
			return;
		}
		const sequence = this.#generations.nextAudioSeq(pipeline.turn.generationId);
		if (sequence === null) return;
		pipeline.audioProduced = true;
		this.#metrics?.markFirstPlaybackReady(pipeline.turn.turnId);
		yield {
			type: "audio.segment",
			generationId: outcome.result.generationId,
			segmentId: outcome.result.segmentId,
			sequence,
			contentType: outcome.result.contentType,
			bytes: outcome.result.bytes,
			final: true,
		};
	}

	async *#drainSpeechPipeline(
		pipeline: SpeechPipeline,
	): AsyncGenerator<OrchestratorEvent> {
		while (pipeline.pending.length > 0 && !pipeline.failed) {
			yield* this.#drainNextSpeechJob(pipeline);
		}
	}

	async *#finishTerminalResponse(
		permit: TerminalResponsePermit,
		visible: string[],
		audioProduced: boolean,
	): AsyncGenerator<OrchestratorEvent> {
		// Entering a terminal state invalidates its generation. Only an explicit
		// permit created by a current server-authored tool/failure path may finish.
		yield {
			type: "text.done",
			generationId: permit.generationId,
			text: visible.join(" ").trim(),
		};
		if (audioProduced)
			yield { type: "audio.done", generationId: permit.generationId };
		this.#activeCandidateMeetingSlots.delete(permit.generationId);
		this.#pendingDynamicEvents.delete(permit.generationId);
		this.#pendingDynamicResponses.delete(permit.generationId);
	}

	async *#finishGeneration(
		generationId: string,
		visible: string[],
		audioProduced: boolean,
	): AsyncGenerator<OrchestratorEvent> {
		if (!this.#generations.accept(generationId)) return;
		yield {
			type: "text.done",
			generationId,
			text: visible.join(" ").trim(),
		};
		if (audioProduced) yield { type: "audio.done", generationId };
		this.#activeCandidateMeetingSlots.delete(generationId);
		this.#pendingDynamicEvents.delete(generationId);
		this.#pendingDynamicResponses.delete(generationId);
		this.#generations.finish(generationId);
	}

	#takeDynamicEvents(generationId: string): OrchestratorEvent[] {
		const events = this.#pendingDynamicEvents.get(generationId) ?? [];
		this.#pendingDynamicEvents.delete(generationId);
		return events;
	}

	#takeDynamicResponses(generationId: string): Array<{
		text: string;
		suppressModelSpeech: boolean;
		terminalResponsePermit?: TerminalResponsePermit;
	}> {
		const responses = this.#pendingDynamicResponses.get(generationId) ?? [];
		this.#pendingDynamicResponses.delete(generationId);
		return responses;
	}

	#canProcessTurns(): boolean {
		return (
			!this.#closed &&
			this.#state.stage !== "DISCONNECTED" &&
			!isTerminalStage(this.#state.stage)
		);
	}

	#invalidateActiveWork(_reason: string): Promise<void> {
		const active = this.#generations.current();
		if (!active) return Promise.resolve();
		const interrupted = this.#generations.interrupt(active.generationId);
		if (!interrupted) return Promise.resolve();
		this.#prefetch.abortAll();
		this.#activeCandidateMeetingSlots.delete(active.generationId);
		this.#pendingDynamicEvents.delete(active.generationId);
		this.#pendingDynamicResponses.delete(active.generationId);
		const threadId = this.#threadId;
		if (!threadId) return Promise.resolve();
		return this.#brain
			.interrupt(threadId, interrupted.turnId)
			.catch(() => undefined)
			.then(() => undefined);
	}

	async #interruptActiveGeneration(): Promise<void> {
		await this.#invalidateActiveWork("superseded");
	}
}

async function settleWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.then(
			() => undefined,
			() => undefined,
		),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
