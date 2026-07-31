import type {
	BookingService,
	BrainDelta,
	BrainPort,
	BrainTurnInput,
	KnownFacts,
	SafeErrorCode,
	SttPort,
	SttTranscriptionResult,
	ToolRequest,
	TtsPort,
} from "@botamin/contracts";
import { TtsAudioSegmentSchema } from "@botamin/contracts";
import { buildBrainContext } from "./context";
import { GenerationCoordinator } from "./generation";
import {
	allowedActions,
	BookingToolExecutor,
	type SafeToolExecution,
} from "./policy";
import { AtomicSttTurnGate } from "./reliability";
import {
	SpeechBudgetGuard,
	type SpeechBudgetOptions,
	type SpeechChunkerOptions,
	SpeechPrefetchCoordinator,
	StreamingSentenceChunker,
	sanitizeSpeech,
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
			updatedFields: string[];
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
			contentType: "audio/mpeg";
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
			source: "audio.commit" | "stt" | "brain" | "tts" | "generation";
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
}

export interface AudioCommitInput {
	turnId: string;
	generationId: string;
	audio: Uint8Array;
	contentType: "audio/wav";
	language?: string;
	knownFacts: KnownFacts;
}

interface RenderResult {
	visibleText: string;
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

const BOOKING_CONFIRMATION_WITH_QUESTION =
	"Всё получила и зафиксировала. Календарная встреча пока не создана: коллега свяжется по указанному контакту. Можно задать один необязательный вопрос?";
const BOOKING_CONFIRMATION_ONLY =
	"Всё получила и зафиксировала. Календарная встреча пока не создана: коллега свяжется по указанному контакту.";
const BOOKING_FAILURE =
	"Не получилось сохранить данные, поэтому я не буду подтверждать бронь. Проверьте контакт и попробуйте ещё раз.";
const QUALIFICATION_FAILURE =
	"Основные данные уже сохранены. Дополнительные ответы сейчас не удалось обновить, и на этом можно закончить.";
const QUALIFICATION_PARTIAL_CONFIRMATION =
	"Дополнительные ответы сохранены. Можно продолжить или закончить на этом.";
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

function qualificationConfirmation(
	status: "partial" | "complete" | "skipped",
): string {
	if (status === "partial") return QUALIFICATION_PARTIAL_CONFIRMATION;
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

/** Conservative server-owned evidence for spoken post-booking consent. */
function hasExplicitQualificationConsent(userText: string): boolean {
	const normalized = normalizeIntentText(userText);
	if (!normalized || normalized.length > 120) return false;
	if (
		/\b(?:нет|не\s+надо|не\s+хочу|не\s+нужно|не\s+задавайте)\b/u.test(
			normalized,
		)
	) {
		return false;
	}
	return /^(?:да|конечно|можно|хорошо|ладно|задавайте|спрашивайте)(?:\s|$)/u.test(
		normalized,
	);
}

export type ConservativeNegativeIntent =
	| "pre_booking_refusal"
	| "qualification_decline"
	| null;

/** High-precision refusal detection; objections and uncertain language stay put. */
export function classifyConservativeNegativeIntent(
	userText: string,
	state: ConversationState,
): ConservativeNegativeIntent {
	const normalized = normalizeIntentText(userText);
	if (
		!normalized ||
		normalized.length > 160 ||
		/(?:^|\s)(?:но|может|пока)(?:\s|$)/u.test(normalized)
	) {
		return null;
	}
	if (state.booking === null) {
		return /^(?:нет спасибо|нет спасибо (?:мне )?не интересно|спасибо не интересно|мне не интересно|не нужно|не надо|отказываюсь|я отказываюсь|не хочу (?:продолжать|общаться|разговаривать|оставлять контакты|бронировать)|давайте (?:закончим|завершим)(?: разговор)?|прекратим разговор)(?: пожалуйста)?$/u.test(
			normalized,
		)
			? "pre_booking_refusal"
			: null;
	}
	if (state.stage === "BOOKED" && state.bookingConfirmationDelivered) {
		return /^(?:нет|нет спасибо|нет не задавайте|не задавайте|не надо|не нужно|не хочу|пропустим|давайте пропустим)(?: дополнительные вопросы)?$/u.test(
			normalized,
		)
			? "qualification_decline"
			: null;
	}
	if (state.stage === "POST_BOOKING_QUALIFICATION") {
		return /^(?:(?:не хочу|не буду) (?:отвечать|продолжать)(?: на)?|не задавайте|давайте (?:закончим|завершим|пропустим)|пропустим)(?: дополнительные вопросы| опрос| квалификацию)?(?: пожалуйста)?$/u.test(
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
	readonly #tools: BookingToolExecutor;
	readonly #sttTurns = new AtomicSttTurnGate();
	readonly #generations = new GenerationCoordinator();
	readonly #budgets: SpeechBudgetGuard;
	readonly #prefetch = new SpeechPrefetchCoordinator();
	readonly #chunkerOptions: SpeechChunkerOptions;
	readonly #createId: () => string;
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
	#lifecycleInterruption: Promise<void> = Promise.resolve();
	#closed = false;
	#closePromise: Promise<void> | null = null;

	constructor(options: ConversationOrchestratorOptions) {
		this.conversationId = options.conversationId;
		this.#promptVersion = options.promptVersion;
		this.#stt = options.stt;
		this.#brain = options.brain;
		this.#tts = options.tts ?? null;
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

	apply(event: ConversationEvent): TransitionResult {
		const result = transition(this.#state, event);
		if (!result.ok) return result;
		const previousStage = this.#state.stage;
		this.#state = result.state;
		if (this.#state.stage === previousStage) return result;
		if (this.#state.stage === "DISCONNECTED") {
			this.#sttTurns.suspend();
			this.#lifecycleInterruption = this.#invalidateActiveWork("disconnect");
		} else if (previousStage === "DISCONNECTED") {
			this.#sttTurns.reopen();
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
		if (
			input.conversationId !== this.conversationId ||
			!this.#canProcessTurns() ||
			!this.#generations.accept(input.generationId, input.turnId)
		) {
			return { ok: false };
		}
		const outcome = await this.#performTool(
			input.generationId,
			input.turnId,
			request,
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
		this.#sttTurns.finish(accepted.turn);
		const negativeIntent = classifyConservativeNegativeIntent(
			userText,
			this.#state,
		);
		if (negativeIntent) {
			const from = this.#state.stage;
			const declined = this.apply(
				negativeIntent === "qualification_decline" && from === "BOOKED"
					? { type: "qualification_consent_declined" }
					: { type: "clear_refusal" },
			);
			if (declined.ok) {
				const text = this.#state.booking
					? QUALIFICATION_DECLINE
					: PRE_BOOKING_DECLINE;
				yield {
					type: "transcript.final",
					turnId: input.turnId,
					text: userText,
				};
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
			// Final acceptance and current-generation ownership are one synchronous
			// fence. A newer commit can only resume after both have happened.
			active = this.#generations.start(input.generationId, input.turnId).active;
		} catch {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "generation",
			};
			return;
		}
		yield { type: "transcript.final", turnId: input.turnId, text: userText };
		yield* this.#runBrainTurn(
			{
				turnId: input.turnId,
				generationId: input.generationId,
				userText,
				knownFacts: input.knownFacts,
			},
			active,
		);
	}

	async interrupt(generationId: string): Promise<OrchestratorEvent> {
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

	async *#runBrainTurn(
		input: {
			turnId: string;
			generationId: string;
			userText: string;
			knownFacts: KnownFacts;
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
			const text = this.#state.qualificationEnabled
				? BOOKING_CONFIRMATION_WITH_QUESTION
				: BOOKING_CONFIRMATION_ONLY;
			const rendered = yield* this.#renderPhrase(input, text);
			if (rendered.visibleText) visible.push(rendered.visibleText);
			audioProduced ||= rendered.audioProduced;
			if (!this.#generations.accept(input.generationId, input.turnId)) return;
			this.apply({ type: "booking_confirmation_delivered" });
			if (!this.#state.qualificationEnabled) this.apply({ type: "complete" });
			if (isTerminalStage(this.#state.stage)) {
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

		const chunker = new StreamingSentenceChunker(this.#chunkerOptions);
		const heldActionSpeech: string[] = [];
		let suppressModelSpeech = false;
		let toolSettledThisTurn = false;
		let brainFailure: Extract<BrainDelta, { type: "error" }> | undefined;
		try {
			this.#threadId ??= await this.#brain.createThread(this.conversationId);
			if (!this.#generations.accept(input.generationId, input.turnId)) return;
			const context = buildBrainContext({
				conversationId: this.conversationId,
				threadId: this.#threadId,
				turnId: input.turnId,
				generationId: input.generationId,
				userText: input.userText,
				stage: this.#state.stage,
				knownFacts: input.knownFacts,
				booking: this.#state.booking,
				allowedActions: allowedActions(this.#state),
				promptVersion: this.#promptVersion,
			});

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
						input.userText,
					);
					if (stageEvent) yield stageEvent;
					continue;
				}
				if (delta.type === "tool.request") {
					const outcome = await this.#performTool(
						input.generationId,
						input.turnId,
						delta.tool,
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
				for (const phrase of ready) {
					const rendered = yield* this.#renderPhrase(input, phrase);
					if (rendered.visibleText) visible.push(rendered.visibleText);
					audioProduced ||= rendered.audioProduced;
				}
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
				for (const phrase of [...heldActionSpeech, ...chunker.flush()]) {
					const rendered = yield* this.#renderPhrase(input, phrase);
					if (rendered.visibleText) visible.push(rendered.visibleText);
					audioProduced ||= rendered.audioProduced;
				}
			}
		} catch {
			brainFailure = {
				type: "error",
				turnId: input.turnId,
				generationId: input.generationId,
				error: {
					code: "BRAIN_PROTOCOL_ERROR",
					message: "Brain turn failed",
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

	#applyBrainStageProposal(
		generationId: string,
		nextStage: ConversationState["stage"] | undefined,
		userText: string,
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
			case "BOOKED->POST_BOOKING_QUALIFICATION":
				if (hasExplicitQualificationConsent(userText)) {
					event = { type: "qualification_consent_granted" };
				}
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

	async #performTool(
		generationId: string,
		turnId: string,
		request: ToolRequest,
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
		const execution = await this.#tools.execute(
			this.#state,
			this.conversationId,
			request,
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
		const serverResponse =
			execution.value.name === "create_booking"
				? execution.value.replayedCall
					? undefined
					: this.#state.qualificationEnabled
						? BOOKING_CONFIRMATION_WITH_QUESTION
						: BOOKING_CONFIRMATION_ONLY
				: qualificationConfirmation(execution.value.result.qualificationStatus);
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

	async *#renderPhrase(
		turn: { turnId: string; generationId: string },
		visibleText: string,
	): AsyncGenerator<OrchestratorEvent, RenderResult> {
		const visible = visibleText.replace(/\s+/gu, " ").trim();
		if (!visible || !this.#generations.accept(turn.generationId, turn.turnId)) {
			return { visibleText: "", audioProduced: false };
		}
		yield {
			type: "text.delta",
			generationId: turn.generationId,
			text: visible,
		};

		const spoken = sanitizeSpeech(visible);
		if (!spoken) return { visibleText: visible, audioProduced: false };
		const budget = this.#budgets.reserve(spoken);
		if (!budget.ok || !this.#tts) {
			yield {
				type: "degraded",
				generationId: turn.generationId,
				provider: "tts",
				code: "TTS_UNAVAILABLE",
				textFallback: visible,
			};
			return { visibleText: visible, audioProduced: false };
		}

		const segmentId = this.#createId();
		if (!this.#prefetch.tryStart(segmentId)) {
			yield {
				type: "degraded",
				generationId: turn.generationId,
				provider: "tts",
				code: "TTS_UNAVAILABLE",
				textFallback: visible,
			};
			return { visibleText: visible, audioProduced: false };
		}
		try {
			const result = TtsAudioSegmentSchema.parse(
				await this.#tts.synthesize({
					conversationId: this.conversationId,
					turnId: turn.turnId,
					generationId: turn.generationId,
					segmentId,
					text: spoken,
					signal: this.#generations.signal(turn.generationId),
				}),
			);
			if (
				!this.#generations.accept(turn.generationId, turn.turnId) ||
				result.generationId !== turn.generationId ||
				result.segmentId !== segmentId
			) {
				yield {
					type: "ignored",
					generationId: result.generationId,
					source: "tts",
				};
				return { visibleText: visible, audioProduced: false };
			}
			const sequence = this.#generations.nextAudioSeq(turn.generationId);
			if (sequence === null) {
				return { visibleText: visible, audioProduced: false };
			}
			yield {
				type: "audio.segment",
				generationId: result.generationId,
				segmentId: result.segmentId,
				sequence,
				contentType: result.contentType,
				bytes: result.bytes,
				final: true,
			};
			return { visibleText: visible, audioProduced: true };
		} catch {
			if (this.#generations.accept(turn.generationId, turn.turnId)) {
				yield {
					type: "degraded",
					generationId: turn.generationId,
					provider: "tts",
					code: "TTS_UNAVAILABLE",
					textFallback: visible,
				};
			}
			return { visibleText: visible, audioProduced: false };
		} finally {
			this.#prefetch.finish(segmentId);
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
