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
	sanitizeSpeech,
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

interface ToolOutcome {
	execution: SafeToolExecution;
	events: OrchestratorEvent[];
	serverResponse?: string;
	suppressModelSpeech: boolean;
}

const BOOKING_CONFIRMATION_WITH_QUESTION =
	"Всё получила и зафиксировала. Календарная встреча пока не создана: коллега свяжется по указанному контакту. Можно задать один необязательный вопрос?";
const BOOKING_CONFIRMATION_ONLY =
	"Всё получила и зафиксировала. Календарная встреча пока не создана: коллега свяжется по указанному контакту.";
const BOOKING_FAILURE =
	"Не получилось сохранить данные, поэтому я не буду подтверждать бронь. Проверьте контакт и попробуйте ещё раз.";
const QUALIFICATION_FAILURE =
	"Основные данные уже сохранены. Дополнительные ответы сейчас не удалось обновить, и на этом можно закончить.";
const BRAIN_FAILURE_BEFORE_BOOKING =
	"Сейчас не получается продолжить разговор. Данные ещё не были сохранены.";
const BRAIN_FAILURE_AFTER_BOOKING =
	"Основные данные уже сохранены. Дополнительные вопросы необязательны, и на этом можно закончить.";
const STT_FAILURE =
	"Речь сейчас не распознаётся. Повторите, пожалуйста, реплику ещё раз.";

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
		{ text: string; suppressModelSpeech: boolean }
	>();
	#threadId: string | undefined;
	#state: ConversationState;

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
		if (result.ok) this.#state = result.state;
		return result;
	}

	/** Callback passed to CodexAppServerBrain only when dynamic mode is enabled. */
	readonly executeDynamicTool = async (
		request: ToolRequest,
		input: BrainTurnInput,
	): Promise<{ ok: boolean }> => {
		if (
			input.conversationId !== this.conversationId ||
			!this.#generations.accept(input.generationId, input.turnId)
		) {
			return { ok: false };
		}
		const outcome = await this.#performTool(
			input.generationId,
			input.turnId,
			request,
		);
		if (this.#generations.accept(input.generationId, input.turnId)) {
			this.#pendingDynamicEvents.set(input.generationId, [
				...(this.#pendingDynamicEvents.get(input.generationId) ?? []),
				...outcome.events,
			]);
			if (outcome.serverResponse) {
				this.#pendingDynamicResponses.set(input.generationId, {
					text: outcome.serverResponse,
					suppressModelSpeech: outcome.suppressModelSpeech,
				});
			}
		}
		return { ok: outcome.execution.ok };
	};

	/** One accepted audio.commit owns one atomic SttPort request and final. */
	async *acceptAudioCommit(
		input: AudioCommitInput,
	): AsyncGenerator<OrchestratorEvent> {
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
		yield { type: "transcript.final", turnId: input.turnId, text: userText };
		this.#sttTurns.finish(accepted.turn);
		yield* this.#runBrainTurn({
			turnId: input.turnId,
			generationId: input.generationId,
			userText,
			knownFacts: input.knownFacts,
		});
	}

	async interrupt(generationId: string): Promise<OrchestratorEvent> {
		const interrupted = this.#generations.interrupt(generationId);
		if (!interrupted) {
			return { type: "ignored", generationId, source: "generation" };
		}
		this.#prefetch.abortAll();
		this.#pendingDynamicEvents.delete(generationId);
		this.#pendingDynamicResponses.delete(generationId);
		if (this.#threadId) {
			await this.#brain
				.interrupt(this.#threadId, interrupted.turnId)
				.catch(() => undefined);
		}
		return { type: "assistant.interrupted", generationId };
	}

	async disconnect(): Promise<void> {
		this.#sttTurns.close();
		await this.#interruptActiveGeneration();
		if (this.#state.stage !== "DISCONNECTED")
			this.apply({ type: "disconnect" });
	}

	async *#runBrainTurn(input: {
		turnId: string;
		generationId: string;
		userText: string;
		knownFacts: KnownFacts;
	}): AsyncGenerator<OrchestratorEvent> {
		let started: ReturnType<GenerationCoordinator["start"]>;
		try {
			started = this.#generations.start(input.generationId, input.turnId);
		} catch {
			yield {
				type: "ignored",
				generationId: input.generationId,
				source: "generation",
			};
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
			this.apply({ type: "booking_confirmation_delivered" });
			if (!this.#state.qualificationEnabled) this.apply({ type: "complete" });
			yield* this.#finishGeneration(input.generationId, visible, audioProduced);
			return;
		}

		const chunker = new StreamingSentenceChunker(this.#chunkerOptions);
		const heldCollectionSpeech: string[] = [];
		let suppressModelSpeech = false;
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
			for await (const delta of this.#brain.runTurn(
				context,
				started.active.signal,
			)) {
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
				const dynamicResponse = this.#pendingDynamicResponses.get(
					input.generationId,
				);
				if (dynamicResponse) {
					this.#pendingDynamicResponses.delete(input.generationId);
					const rendered = yield* this.#renderPhrase(
						input,
						dynamicResponse.text,
					);
					if (rendered.visibleText) visible.push(rendered.visibleText);
					audioProduced ||= rendered.audioProduced;
					suppressModelSpeech ||= dynamicResponse.suppressModelSpeech;
					if (this.#state.stage === "BOOKED") {
						this.apply({ type: "booking_confirmation_delivered" });
						if (!this.#state.qualificationEnabled)
							this.apply({ type: "complete" });
					}
				}

				if (delta.type === "error") {
					brainFailure = delta;
					break;
				}
				if (delta.type === "turn.completed") continue;
				if (delta.type === "tool.request") {
					const outcome = await this.#performTool(
						input.generationId,
						input.turnId,
						delta.tool,
					);
					for (const event of outcome.events) yield event;
					chunker.clear();
					heldCollectionSpeech.length = 0;
					suppressModelSpeech ||= outcome.suppressModelSpeech;
					if (outcome.serverResponse) {
						const rendered = yield* this.#renderPhrase(
							input,
							outcome.serverResponse,
						);
						if (rendered.visibleText) visible.push(rendered.visibleText);
						audioProduced ||= rendered.audioProduced;
						if (this.#state.stage === "BOOKED") {
							this.apply({ type: "booking_confirmation_delivered" });
							if (!this.#state.qualificationEnabled) {
								this.apply({ type: "complete" });
							}
						}
					}
					continue;
				}
				if (suppressModelSpeech) continue;
				const ready = chunker.push(delta.text);
				if (this.#state.stage === "COLLECT_BOOKING") {
					heldCollectionSpeech.push(...ready);
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
			if (!suppressModelSpeech && !brainFailure) {
				for (const phrase of [...heldCollectionSpeech, ...chunker.flush()]) {
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
			yield {
				type: "degraded",
				generationId: input.generationId,
				provider: "brain",
				code: brainFailure.error.code,
				textFallback: fallback,
			};
			if (visible.length === 0) {
				const rendered = yield* this.#renderPhrase(input, fallback);
				if (rendered.visibleText) visible.push(rendered.visibleText);
				audioProduced ||= rendered.audioProduced;
			}
			this.apply({ type: "provider_failed" });
		}

		yield* this.#finishGeneration(input.generationId, visible, audioProduced);
	}

	#acceptBrainDelta(
		input: { turnId: string; generationId: string },
		delta: BrainDelta,
	): boolean {
		return (
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
		if (!this.#generations.accept(generationId, turnId)) {
			return {
				execution: {
					ok: false,
					callId: request.callId,
					code: "ACTION_NOT_ALLOWED_IN_STATE",
					message: "Tool turn is no longer current",
				},
				events: [],
				suppressModelSpeech: true,
			};
		}
		const execution = await this.#tools.execute(
			this.#state,
			this.conversationId,
			request,
		);
		const stillCurrent = this.#generations.accept(generationId, turnId);
		if (!execution.ok) {
			if (!stillCurrent) {
				return {
					execution,
					events: [],
					suppressModelSpeech: true,
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
					// The durable booking is authoritative even if disconnect/new-turn
					// state changed while the transaction was running.
					this.#state = {
						...this.#state,
						stage:
							this.#state.stage === "DISCONNECTED" ? "DISCONNECTED" : "BOOKED",
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
						this.#state =
							this.#state.stage === "DISCONNECTED"
								? { ...this.#state, resumeStage: "COMPLETE" }
								: { ...this.#state, stage: "COMPLETE" };
					}
				}
			}
		}
		if (!stillCurrent) {
			for (const event of events) {
				if (
					event.type === "booking.committed" ||
					event.type === "booking.updated"
				) {
					this.#deferredDomainEvents.push(event);
				}
			}
			return {
				execution,
				events: [],
				suppressModelSpeech: true,
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
			execution.value.name === "create_booking" && !execution.value.replayedCall
				? this.#state.qualificationEnabled
					? BOOKING_CONFIRMATION_WITH_QUESTION
					: BOOKING_CONFIRMATION_ONLY
				: undefined;
		return {
			execution,
			events,
			...(serverResponse ? { serverResponse } : {}),
			suppressModelSpeech: execution.value.name === "create_booking",
		};
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

	async #interruptActiveGeneration(): Promise<void> {
		const active = this.#generations.current();
		if (active) await this.interrupt(active.generationId);
	}
}
