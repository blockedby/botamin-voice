import { describe, expect, test } from "bun:test";
import type {
	AppendQualificationInput,
	BookingService,
	BrainDelta,
	BrainPort,
	BrainTurnInput,
	CreateBookingInput,
	ProviderHealth,
	SttHealth,
	SttPort,
	SttTranscriptionResult,
	ToolRequest,
	TtsAudioSegment,
	TtsHealth,
	TtsPort,
	TtsSynthesisRequest,
} from "@botamin/contracts";
import {
	createDeterministicMp3Fixture,
	FakeBookingService,
	FakeBrain,
	FakeNotifier,
	FakeStt,
	FakeTts,
} from "../../../../packages/test-fixtures/src";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "./orchestrator";
import {
	type ConversationState,
	createInitialConversationState,
} from "./state";

const conversationId = "01J00000000000000000000000";
const turn1 = "01J00000000000000000000010";
const turn2 = "01J00000000000000000000011";
const generation1 = "01J00000000000000000000020";
const generation2 = "01J00000000000000000000021";
const promptVersion = "a".repeat(64);
const audio = new Uint8Array([82, 73, 70, 70]);
const facts = {
	role: "  руководитель   продаж ",
	company: "Example",
	useCases: ["ночные лиды", "ночные лиды"],
	painPoints: ["медленный ответ"],
	objections: [],
};
const bookingInput: CreateBookingInput = {
	conversationId,
	idempotencyKey: "booking-orchestrator-0001",
	name: "Анна",
	contacts: [{ channel: "email", value: "anna@example.com" }],
	consentConfirmed: true,
};

function collectionState(): ConversationState {
	return {
		...createInitialConversationState(),
		stage: "COLLECT_BOOKING",
		contactConsentConfirmed: true,
	};
}

function valueState(): ConversationState {
	return { ...createInitialConversationState(), stage: "VALUE" };
}

function commit(
	turnId = turn1,
	generationId = generation1,
): {
	turnId: string;
	generationId: string;
	audio: Uint8Array;
	contentType: "audio/wav";
	knownFacts: typeof facts;
} {
	return {
		turnId,
		generationId,
		audio,
		contentType: "audio/wav",
		knownFacts: facts,
	};
}

function bookingScript(
	turnId = turn1,
	generationId = generation1,
): BrainDelta[] {
	return [
		{
			type: "speech.delta",
			turnId,
			generationId,
			text: "Бронь уже создана. Какая у вас CRM?",
		},
		{
			type: "tool.request",
			turnId,
			generationId,
			tool: {
				name: "create_booking",
				callId: "call-create-1",
				args: bookingInput,
			},
		},
		{
			type: "speech.delta",
			turnId,
			generationId,
			text: "Назовите CRM и объём лидов?",
		},
		{ type: "turn.completed", turnId, generationId },
	];
}

function speechScript(
	text: string,
	turnId = turn1,
	generationId = generation1,
): BrainDelta[] {
	return [
		{ type: "speech.delta", turnId, generationId, text },
		{ type: "turn.completed", turnId, generationId },
	];
}

async function collect(
	iterable: AsyncIterable<OrchestratorEvent>,
): Promise<OrchestratorEvent[]> {
	const result: OrchestratorEvent[] = [];
	for await (const event of iterable) result.push(event);
	return result;
}

function fixture(
	options: {
		stt?: SttPort;
		brain?: BrainPort;
		bookings?: FakeBookingService;
		tts?: TtsPort | null;
		initialState?: ConversationState;
	} = {},
) {
	const stt = options.stt ?? new FakeStt({ text: "Да, сохраните данные" });
	const brain = options.brain ?? new FakeBrain(bookingScript());
	const bookings = options.bookings ?? new FakeBookingService();
	const tts = options.tts === undefined ? new FakeTts() : options.tts;
	const orchestrator = new ConversationOrchestrator({
		conversationId,
		promptVersion,
		stt,
		brain,
		bookings,
		tts,
		initialState: options.initialState ?? collectionState(),
	});
	return { orchestrator, stt, brain, bookings, tts };
}

class FailingTts implements TtsPort {
	readonly inputs: TtsSynthesisRequest[] = [];
	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.inputs.push(request);
		throw new Error("private OpenRouter error");
	}
	async health(): Promise<TtsHealth> {
		return "unavailable";
	}
}

class RetryTts implements TtsPort {
	readonly inputs: TtsSynthesisRequest[] = [];
	attempts = 0;
	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.inputs.push(request);
		// The adapter/fake owns its bounded provider retry inside one atomic port call.
		this.attempts += 2;
		return {
			generationId: request.generationId,
			segmentId: request.segmentId,
			contentType: "audio/mpeg",
			bytes: Uint8Array.from(createDeterministicMp3Fixture()),
			final: true,
		};
	}
	async health(): Promise<TtsHealth> {
		return "ready";
	}
}

describe("atomic transcript intake", () => {
	test("duplicate audio.commit/final can start only one Luna turn", async () => {
		const brain = new FakeBrain(
			speechScript(
				"Покажу подходящий сценарий для ночных лидов и предложу один следующий шаг.",
			),
		);
		const { orchestrator, stt } = fixture({
			brain,
			initialState: valueState(),
		});
		const first = await collect(orchestrator.acceptAudioCommit(commit()));
		const duplicate = await collect(orchestrator.acceptAudioCommit(commit()));
		expect((stt as FakeStt).inputs).toHaveLength(1);
		expect(brain.turns).toHaveLength(1);
		expect(
			first.filter((event) => event.type === "transcript.final"),
		).toHaveLength(1);
		expect(duplicate).toEqual([
			{ type: "ignored", generationId: generation1, source: "audio.commit" },
		]);
	});

	test("newer turn aborts late STT and only its final reaches brain", async () => {
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const stt = new FakeStt({
			text: "Текущий текст",
			beforeResolve: async () => {
				calls += 1;
				if (calls === 1) {
					firstStarted();
					await gate;
				}
			},
		});
		const brain = new FakeBrain(
			speechScript("Ответ на текущую реплику завершён.", turn2, generation2),
		);
		const { orchestrator } = fixture({
			stt,
			brain,
			initialState: valueState(),
		});
		const stalePromise = collect(orchestrator.acceptAudioCommit(commit()));
		await started;
		const current = await collect(
			orchestrator.acceptAudioCommit(commit(turn2, generation2)),
		);
		releaseFirst();
		const stale = await stalePromise;
		expect(stt.inputs).toHaveLength(2);
		expect(brain.turns).toHaveLength(1);
		expect(brain.turns[0]?.turnId).toBe(turn2);
		expect(current.some((event) => event.type === "transcript.final")).toBe(
			true,
		);
		expect(stale.some((event) => event.type === "transcript.final")).toBe(
			false,
		);
		expect(stale.some((event) => event.type === "degraded")).toBe(false);
	});

	test("newer commit between accepted final and old iterator resume fences old brain and tools", async () => {
		class InterleavedBrain implements BrainPort {
			readonly turns: BrainTurnInput[] = [];
			async createThread(): Promise<string> {
				return "interleaving-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				this.turns.push(input);
				yield {
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Только новый ответ должен быть обработан и показан посетителю.",
				};
				yield {
					type: "turn.completed",
					turnId: input.turnId,
					generationId: input.generationId,
				};
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const brain = new InterleavedBrain();
		const bookings = new FakeBookingService();
		const { orchestrator } = fixture({
			brain,
			bookings,
			initialState: valueState(),
		});
		const stale = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		expect((await stale.next()).value).toMatchObject({
			type: "transcript.final",
			turnId: turn1,
		});

		const fresh = await collect(
			orchestrator.acceptAudioCommit(commit(turn2, generation2)),
		);
		const staleRemainder: OrchestratorEvent[] = [];
		for (;;) {
			const item = await stale.next();
			if (item.done) break;
			staleRemainder.push(item.value);
		}

		expect(brain.turns.map((turn) => turn.turnId)).toEqual([turn2]);
		expect(bookings.domainEvents).toHaveLength(0);
		expect(staleRemainder).toHaveLength(0);
		expect(JSON.stringify(fresh)).toContain("Только новый ответ");
	});

	test("interrupt during thread creation never invokes Luna runTurn", async () => {
		let release!: () => void;
		let threadStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			threadStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class SlowThreadBrain implements BrainPort {
			runs = 0;
			async createThread(): Promise<string> {
				threadStarted();
				await gate;
				return "slow-thread";
			}
			async *runTurn(): AsyncIterable<BrainDelta> {
				this.runs += 1;
				yield* [] as BrainDelta[];
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const brain = new SlowThreadBrain();
		const { orchestrator } = fixture({ brain, initialState: valueState() });
		const iterator = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "transcript.final",
		});
		const pending = iterator.next();
		await started;
		await orchestrator.interrupt(generation1);
		release();
		await pending;
		expect(brain.runs).toBe(0);
	});

	test("STT failure invokes no brain, tool, notifier, or TTS", async () => {
		class BrokenStt implements SttPort {
			async transcribe(): Promise<SttTranscriptionResult> {
				throw new Error("private audio failure");
			}
			async health(): Promise<SttHealth> {
				return "unavailable";
			}
		}
		const brain = new FakeBrain(bookingScript());
		const bookings = new FakeBookingService();
		const tts = new FakeTts();
		const { orchestrator } = fixture({
			stt: new BrokenStt(),
			brain,
			bookings,
			tts,
		});
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		expect(events).toEqual([
			expect.objectContaining({
				type: "degraded",
				provider: "stt",
				code: "STT_UNAVAILABLE",
			}),
		]);
		expect(brain.turns).toHaveLength(0);
		expect(bookings.domainEvents).toHaveLength(0);
		expect(tts.inputs).toHaveLength(0);
	});
});

describe("terminal and transport lifecycle fencing", () => {
	test("terminal ERROR rejects late STT and every later audio commit", async () => {
		let release!: () => void;
		let started!: () => void;
		const sttStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stt = new FakeStt({
			text: "Поздний финал",
			beforeResolve: async () => {
				started();
				await gate;
			},
		});
		const brain = new FakeBrain(speechScript("Не запускать"));
		const tts = new FakeTts();
		const { orchestrator } = fixture({
			stt,
			brain,
			tts,
			initialState: valueState(),
		});
		const late = collect(orchestrator.acceptAudioCommit(commit()));
		await sttStarted;
		expect(orchestrator.apply({ type: "provider_failed" })).toMatchObject({
			ok: true,
			state: { stage: "ERROR" },
		});
		release();
		const lateEvents = await late;
		const laterEvents = await collect(
			orchestrator.acceptAudioCommit(commit(turn2, generation2)),
		);
		expect(brain.turns).toHaveLength(0);
		expect(tts.inputs).toHaveLength(0);
		expect(lateEvents).toEqual([]);
		expect(laterEvents).toEqual([
			{ type: "ignored", generationId: generation2, source: "audio.commit" },
		]);
	});

	test("terminal DECLINED aborts active brain and rejects its late tool", async () => {
		let release!: () => void;
		let started!: () => void;
		const brainStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class LateToolBrain implements BrainPort {
			async createThread(): Promise<string> {
				return "terminal-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				started();
				await gate;
				yield {
					type: "tool.request",
					turnId: input.turnId,
					generationId: input.generationId,
					tool: {
						name: "create_booking",
						callId: "late-terminal-tool",
						args: bookingInput,
					},
				};
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const bookings = new FakeBookingService();
		const { orchestrator } = fixture({
			brain: new LateToolBrain(),
			bookings,
			initialState: collectionState(),
		});
		const iterator = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "transcript.final",
		});
		const pending = iterator.next();
		await brainStarted;
		expect(orchestrator.apply({ type: "clear_refusal" })).toMatchObject({
			ok: true,
			state: { stage: "DECLINED" },
		});
		release();
		await pending;
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			expect(item.value.type).not.toMatch(/booking|tool|audio/u);
		}
		expect(bookings.domainEvents).toHaveLength(0);
	});

	test("all terminal stages reject fresh audio intake", async () => {
		for (const stage of ["DECLINED", "COMPLETE", "ERROR"] as const) {
			const state = { ...valueState(), stage };
			const { orchestrator, brain } = fixture({ initialState: state });
			expect(await collect(orchestrator.acceptAudioCommit(commit()))).toEqual([
				{
					type: "ignored",
					generationId: generation1,
					source: "audio.commit",
				},
			]);
			expect((brain as FakeBrain).turns).toHaveLength(0);
		}
	});

	test("disconnect fences stale work and reconnect opens one fresh turn with booking intact", async () => {
		const bookings = new FakeBookingService();
		await bookings.createBooking(bookingInput);
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		let release!: () => void;
		let started!: () => void;
		const sttStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let sttCalls = 0;
		const stt = new FakeStt({
			text: "Свежая реплика",
			beforeResolve: async () => {
				sttCalls += 1;
				if (sttCalls === 1) {
					started();
					await gate;
				}
			},
		});
		class ReconnectBrain implements BrainPort {
			readonly turns: BrainTurnInput[] = [];
			async createThread(): Promise<string> {
				return "reconnect-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				this.turns.push(input);
				yield* speechScript(
					"После переподключения обрабатывается только свежая ограниченная реплика.",
					input.turnId,
					input.generationId,
				);
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const brain = new ReconnectBrain();
		const initialState: ConversationState = {
			...createInitialConversationState(),
			stage: "POST_BOOKING_QUALIFICATION",
			booking,
			contactConsentConfirmed: true,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted",
		};
		const { orchestrator } = fixture({
			stt,
			brain,
			bookings,
			initialState,
		});
		const stale = collect(orchestrator.acceptAudioCommit(commit()));
		await sttStarted;
		expect(orchestrator.apply({ type: "disconnect" }).ok).toBe(true);
		release();
		expect(await stale).toEqual([]);
		expect(orchestrator.state.booking?.id).toBe(booking.id);
		expect(orchestrator.apply({ type: "reconnect" })).toMatchObject({
			ok: true,
			state: { stage: "POST_BOOKING_QUALIFICATION" },
		});
		const fresh = await collect(
			orchestrator.acceptAudioCommit(commit(turn2, generation2)),
		);
		expect(brain.turns.map((turn) => turn.turnId)).toEqual([turn2]);
		expect(JSON.stringify(fresh)).toContain("После переподключения");
		expect(orchestrator.state.booking?.id).toBe(booking.id);
	});
});

describe("booking and tool timeline", () => {
	test("commit precedes confirmation and qualification cannot leak before it", async () => {
		const tts = new FakeTts();
		const { orchestrator, brain, bookings } = fixture({ tts });
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		const types = events.map((event) => event.type);
		const spoken = events
			.filter((event) => event.type === "text.delta")
			.map((event) => event.text)
			.join(" ");
		expect(types.indexOf("transcript.final")).toBeLessThan(
			types.indexOf("booking.committed"),
		);
		expect(types.indexOf("booking.committed")).toBeLessThan(
			types.indexOf("text.delta"),
		);
		expect(bookings.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
		]);
		expect(spoken).toContain("Всё получила и зафиксировала");
		expect(spoken).toContain("Календарная встреча пока не создана");
		expect(spoken).not.toMatch(/CRM|объём лидов/u);
		expect(orchestrator.state).toMatchObject({
			stage: "BOOKED",
			booking: { status: "booked" },
			bookingConfirmationDelivered: true,
			qualificationConsent: "unknown",
		});
		expect((brain as FakeBrain).turns).toHaveLength(1);
		expect(tts.inputs[0]).toMatchObject({
			turnId: turn1,
			generationId: generation1,
		});
	});

	test("explicit post-booking consent enables qualification on the next transcript", async () => {
		const qualification: BrainDelta[] = [
			{
				type: "tool.request",
				turnId: turn2,
				generationId: generation2,
				tool: {
					name: "append_booking_qualification",
					callId: "qualification-after-consent",
					args: {
						bookingId: "01J00000000000000000000001",
						idempotencyKey: "qualification-consent-01",
						patch: { role: "РОП" },
						completion: "complete",
					},
				},
			},
			{ type: "turn.completed", turnId: turn2, generationId: generation2 },
		];
		const brain = new FakeBrain(bookingScript(), qualification);
		const { orchestrator, bookings } = fixture({ brain });
		await collect(orchestrator.acceptAudioCommit(commit()));
		expect(
			orchestrator.apply({ type: "qualification_consent_granted" }).ok,
		).toBe(true);
		const events = await collect(
			orchestrator.acceptAudioCommit(commit(turn2, generation2)),
		);
		expect(brain.turns).toHaveLength(2);
		expect(brain.turns[1]).toMatchObject({
			stage: "POST_BOOKING_QUALIFICATION",
			allowedActions: ["append_booking_qualification"],
		});
		expect(events.some((event) => event.type === "booking.updated")).toBe(true);
		expect(bookings.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
			"booking.updated",
		]);
		expect(orchestrator.state).toMatchObject({
			stage: "COMPLETE",
			booking: { qualification: { role: "РОП" } },
		});
	});

	for (const scenario of [
		{
			status: "partial" as const,
			patch: { role: "РОП" },
			expected:
				"Дополнительные ответы сохранены. Можно продолжить или закончить на этом.",
			terminal: false,
		},
		{
			status: "complete" as const,
			patch: { crm: "amoCRM" },
			expected: "Дополнительные ответы сохранены. Спасибо, на этом всё.",
			terminal: true,
		},
		{
			status: "skipped" as const,
			patch: {},
			expected:
				"Основные данные сохранены. Дополнительные вопросы пропущены, на этом всё.",
			terminal: true,
		},
	] as const) {
		test(`qualification ${scenario.status} emits only truthful server-authored visible text`, async () => {
			const bookings = new FakeBookingService();
			await bookings.createBooking(bookingInput);
			const booking = await bookings.findByConversationId(conversationId);
			if (!booking) throw new Error("booking missing");
			const state: ConversationState = {
				...createInitialConversationState(),
				stage: "POST_BOOKING_QUALIFICATION",
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: true,
				qualificationConsent: "granted",
			};
			const falseModelConfirmation =
				"Модель ложно подтверждает обновление до серверного результата и называет клиента Анна.";
			const brain = new FakeBrain([
				{
					type: "speech.delta",
					turnId: turn1,
					generationId: generation1,
					text: falseModelConfirmation,
				},
				{
					type: "tool.request",
					turnId: turn1,
					generationId: generation1,
					tool: {
						name: "append_booking_qualification",
						callId: `qualification-${scenario.status}`,
						args: {
							bookingId: booking.id,
							idempotencyKey: `qualification-${scenario.status}-truthful`,
							patch: scenario.patch,
							completion: scenario.status,
						},
					},
				},
				{
					type: "speech.delta",
					turnId: turn1,
					generationId: generation1,
					text: "Модель ещё раз ложно подтверждает результат.",
				},
				{ type: "turn.completed", turnId: turn1, generationId: generation1 },
			]);
			const tts = new FakeTts();
			const { orchestrator } = fixture({
				brain,
				bookings,
				tts,
				initialState: state,
			});
			const events = await collect(orchestrator.acceptAudioCommit(commit()));
			const visible = events
				.filter(
					(
						event,
					): event is Extract<OrchestratorEvent, { type: "text.delta" }> =>
						event.type === "text.delta",
				)
				.map((event) => event.text)
				.join(" ");
			const done = events.find((event) => event.type === "text.done");
			expect(visible).toBe(scenario.expected);
			expect(visible).not.toContain("Модель");
			expect(done).toMatchObject({ text: scenario.expected });
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "booking.updated",
					qualificationStatus: scenario.status,
				}),
			);
			expect(orchestrator.state.booking?.qualificationStatus).toBe(
				scenario.status,
			);
			expect(orchestrator.state.stage === "COMPLETE").toBe(scenario.terminal);
			if (scenario.terminal) expect(tts.inputs).toHaveLength(0);
			else
				expect(tts.inputs.map((input) => input.text)).toEqual([
					scenario.expected,
				]);
		});
	}

	test("dynamic callback awaits actual execution before safe confirmation", async () => {
		class DynamicBrain implements BrainPort {
			executor?: (
				request: ToolRequest,
				input: BrainTurnInput,
			) => Promise<{ ok: boolean }>;
			readonly turns: BrainTurnInput[] = [];
			async createThread(): Promise<string> {
				return "dynamic-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				this.turns.push(input);
				if (!this.executor) throw new Error("executor missing");
				await this.executor(
					{
						name: "create_booking",
						callId: "dynamic-create-1",
						args: bookingInput,
					},
					input,
				);
				yield {
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Модель говорит, что календарь создан и просит CRM.",
				};
				yield {
					type: "turn.completed",
					turnId: input.turnId,
					generationId: input.generationId,
				};
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const brain = new DynamicBrain();
		const { orchestrator, bookings } = fixture({ brain });
		brain.executor = orchestrator.executeDynamicTool;
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		const spoken = events
			.filter((event) => event.type === "text.delta")
			.map((event) => event.text)
			.join(" ");
		expect(bookings.domainEvents).toHaveLength(1);
		expect(
			events.map((event) => event.type).indexOf("booking.committed"),
		).toBeLessThan(events.map((event) => event.type).indexOf("text.delta"));
		expect(spoken).toContain("Всё получила и зафиксировала");
		expect(spoken).not.toContain("календарь создан");
		expect(brain.turns).toHaveLength(1);
	});

	test("second qualification tool failure preserves first committed patch and booking", async () => {
		const bookings = new FakeBookingService();
		await bookings.createBooking(bookingInput);
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const state: ConversationState = {
			...createInitialConversationState(),
			stage: "POST_BOOKING_QUALIFICATION",
			booking,
			contactConsentConfirmed: true,
			bookingConfirmationDelivered: true,
			qualificationConsent: "granted",
		};
		const brain = new FakeBrain([
			{
				type: "tool.request",
				turnId: turn1,
				generationId: generation1,
				tool: {
					name: "append_booking_qualification",
					callId: "qualification-one",
					args: {
						bookingId: booking.id,
						idempotencyKey: "qualification-key-01",
						patch: { role: "РОП" },
						completion: "partial",
					},
				},
			},
			{
				type: "tool.request",
				turnId: turn1,
				generationId: generation1,
				tool: {
					name: "append_booking_qualification",
					callId: "qualification-two",
					args: {
						bookingId: "01J00000000000000000000099",
						idempotencyKey: "qualification-key-02",
						patch: { crm: "CRM" },
						completion: "complete",
					},
				},
			},
			{ type: "turn.completed", turnId: turn1, generationId: generation1 },
		]);
		const { orchestrator } = fixture({ brain, bookings, initialState: state });
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		expect(
			events.filter((event) => event.type === "booking.updated"),
		).toHaveLength(1);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "tool.result", ok: false }),
		);
		expect(bookings.domainEvents.map((event) => event.type)).toEqual([
			"booking.created",
			"booking.updated",
		]);
		expect(orchestrator.state).toMatchObject({
			stage: "POST_BOOKING_QUALIFICATION",
			booking: { status: "booked", qualification: { role: "РОП" } },
		});
	});

	test("interruption during booking execution preserves commit and defers its event before confirmation", async () => {
		let release!: () => void;
		let executionStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delegate = new FakeBookingService();
		class DelayedBookingService implements BookingService {
			async createBooking(input: CreateBookingInput) {
				executionStarted();
				await gate;
				return delegate.createBooking(input);
			}
			async appendQualification(input: AppendQualificationInput) {
				return delegate.appendQualification(input);
			}
			async findByConversationId(id: string) {
				return delegate.findByConversationId(id);
			}
		}
		const brain = new FakeBrain(bookingScript());
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion,
			stt: new FakeStt({ text: "Сохраните" }),
			brain,
			bookings: new DelayedBookingService(),
			tts: new FakeTts(),
			initialState: collectionState(),
		});
		const iterator = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "transcript.final",
		});
		const pending = iterator.next();
		await started;
		await orchestrator.interrupt(generation1);
		release();
		await pending;
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			expect(item.value.type).not.toBe("booking.committed");
		}
		expect(delegate.domainEvents).toHaveLength(1);
		expect(orchestrator.state.booking?.status).toBe("booked");

		const resumed = await collect(
			orchestrator.acceptAudioCommit(commit(turn2, generation2)),
		);
		const types = resumed.map((event) => event.type);
		expect(types.indexOf("booking.committed")).toBeGreaterThanOrEqual(0);
		expect(types.indexOf("booking.committed")).toBeLessThan(
			types.indexOf("text.delta"),
		);
		expect(brain.turns).toHaveLength(1);
	});

	test("notifier refusal and disconnect never remove a booking", async () => {
		const notifier = new FakeNotifier();
		notifier.failPublishing = true;
		const bookings = new FakeBookingService({ notifier });
		const { orchestrator } = fixture({ bookings });
		await collect(orchestrator.acceptAudioCommit(commit()));
		const bookingId = orchestrator.state.booking?.id;
		expect(bookings.notificationErrors).toHaveLength(1);
		expect(orchestrator.apply({ type: "clear_refusal" }).ok).toBe(true);
		expect(orchestrator.state).toMatchObject({
			stage: "COMPLETE",
			booking: { id: bookingId, status: "booked" },
		});

		const bookedState = {
			...collectionState(),
			stage: "BOOKED" as const,
			booking: await bookings.findByConversationId(conversationId),
			bookingConfirmationDelivered: true,
		};
		const disconnected = fixture({ initialState: bookedState }).orchestrator;
		expect(disconnected.apply({ type: "disconnect" }).ok).toBe(true);
		expect(disconnected.state.booking?.id).toBe(bookingId);
	});
});

describe("speech, TTS degradation, and generation fencing", () => {
	test("PII remains visible but sanitized bounded text alone enters TTS", async () => {
		const visible =
			"Напишите на name@example.com, в Telegram @private_sales или +7 (999) 123-45-67. Подробности: https://example.com/path.";
		const brain = new FakeBrain(speechScript(visible));
		const tts = new FakeTts();
		const { orchestrator } = fixture({
			brain,
			tts,
			initialState: valueState(),
		});
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		const done = events.find((event) => event.type === "text.done");
		expect(done).toMatchObject({ text: visible });
		expect(tts.inputs.length).toBeGreaterThan(0);
		for (const input of tts.inputs) {
			expect(input.text.length).toBeLessThanOrEqual(240);
			expect(input.text).not.toMatch(/@|999|example\.com|https/u);
		}
	});

	test("complete nested JSON envelope stays visible but no nested PII reaches TTS", async () => {
		const envelope = JSON.stringify({
			metadata: {
				company: "Секретная Компания",
				contacts: ["private@example.com", "+7 999 123-45-67"],
				identifiers: {
					bookingId: "01J00000000000000000000001",
					conversationId,
				},
			},
			speech: "Ложная фраза с именем Анна.",
			action: {
				payload: { name: "Анна", company: "Секретная Компания" },
				type: "create_booking",
			},
		});
		const brain = new FakeBrain(speechScript(envelope));
		const tts = new FakeTts();
		const { orchestrator } = fixture({
			brain,
			tts,
			initialState: valueState(),
		});
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		const done = events.find((event) => event.type === "text.done");
		expect(done?.type === "text.done" ? done.text : "").toContain(
			"Секретная Компания",
		);
		expect(JSON.stringify(events)).toContain("private@example.com");
		expect(tts.inputs).toHaveLength(0);
		expect(events.some((event) => event.type === "audio.segment")).toBe(false);
	});

	test("TTS retry/outage repeats only synthesis and preserves text and booking", async () => {
		const failing = new FailingTts();
		const { orchestrator, brain, bookings } = fixture({ tts: failing });
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		expect(failing.inputs).toHaveLength(1);
		expect((brain as FakeBrain).turns).toHaveLength(1);
		expect(bookings.domainEvents).toHaveLength(1);
		expect(orchestrator.state.booking?.status).toBe("booked");
		expect(events.some((event) => event.type === "text.done")).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "degraded", provider: "tts" }),
		);
		expect(JSON.stringify(events)).not.toContain("private OpenRouter error");
	});

	test("successful TTS retry reuses one segment identity and emits one atomic MP3", async () => {
		const tts = new RetryTts();
		const brain = new FakeBrain(
			speechScript("Короткий полезный ответ для проверки повторной синтеза."),
		);
		const { orchestrator } = fixture({
			brain,
			tts,
			initialState: valueState(),
		});
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		expect(tts.attempts).toBe(2);
		expect(tts.inputs).toHaveLength(1);
		expect(new Set(tts.inputs.map((input) => input.segmentId)).size).toBe(1);
		const segments = events.filter((event) => event.type === "audio.segment");
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({
			final: true,
			contentType: "audio/mpeg",
		});
	});

	test("barge-in aborts generation and suppresses late Luna text", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class LateBrain implements BrainPort {
			readonly interrupted: Array<{ threadId: string; turnId: string }> = [];
			async createThread(): Promise<string> {
				return "late-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				yield {
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Первая содержательная фраза уже готова и может быть показана посетителю сейчас.",
				};
				await gate;
				yield {
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Поздняя фраза не должна появиться.",
				};
			}
			async interrupt(threadId: string, turnId: string): Promise<void> {
				this.interrupted.push({ threadId, turnId });
			}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const brain = new LateBrain();
		const { orchestrator } = fixture({ brain, initialState: valueState() });
		const iterator = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		const seen: OrchestratorEvent[] = [];
		seen.push((await iterator.next()).value as OrchestratorEvent); // transcript
		seen.push((await iterator.next()).value as OrchestratorEvent); // text
		seen.push((await iterator.next()).value as OrchestratorEvent); // audio
		const pending = iterator.next();
		await Promise.resolve();
		const interrupted = await orchestrator.interrupt(generation1);
		release();
		const next = await pending;
		if (!next.done) seen.push(next.value);
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			seen.push(item.value);
		}
		expect(interrupted).toEqual({
			type: "assistant.interrupted",
			generationId: generation1,
		});
		expect(brain.interrupted).toEqual([
			{ threadId: "late-thread", turnId: turn1 },
		]);
		expect(JSON.stringify(seen)).not.toContain("Поздняя фраза");
	});

	test("late complete MP3 after interruption is suppressed", async () => {
		let release!: () => void;
		let synthesisStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			synthesisStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class LateTts implements TtsPort {
			async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
				synthesisStarted();
				await gate;
				return {
					generationId: request.generationId,
					segmentId: request.segmentId,
					contentType: "audio/mpeg",
					bytes: Uint8Array.from(createDeterministicMp3Fixture()),
					final: true,
				};
			}
			async health(): Promise<TtsHealth> {
				return "ready";
			}
		}
		const brain = new FakeBrain(
			speechScript(
				"Эта фраза достаточно длинная, чтобы синтез начался до завершения ответа.",
			),
		);
		const { orchestrator } = fixture({
			brain,
			tts: new LateTts(),
			initialState: valueState(),
		});
		const iterator = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "transcript.final",
		});
		expect((await iterator.next()).value).toMatchObject({ type: "text.delta" });
		const pendingAudio = iterator.next();
		await started;
		await orchestrator.interrupt(generation1);
		release();
		const late = await pendingAudio;
		expect(late.done || late.value.type === "ignored").toBe(true);
		expect(late.done ? undefined : late.value.type).not.toBe("audio.segment");
		const remaining: OrchestratorEvent[] = [];
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			remaining.push(item.value);
		}
		expect(remaining.some((event) => event.type === "audio.segment")).toBe(
			false,
		);
	});

	test("repeated barge-in keeps abort-insensitive syntheses bounded at two and emits no stale audio", async () => {
		class AbortInsensitiveTts implements TtsPort {
			readonly inputs: TtsSynthesisRequest[] = [];
			readonly releases: Array<() => void> = [];
			unresolved = 0;
			maxUnresolved = 0;
			async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
				this.inputs.push(request);
				this.unresolved += 1;
				this.maxUnresolved = Math.max(this.maxUnresolved, this.unresolved);
				return new Promise<TtsAudioSegment>((resolve) => {
					this.releases.push(() => {
						this.unresolved -= 1;
						resolve({
							generationId: request.generationId,
							segmentId: request.segmentId,
							contentType: "audio/mpeg",
							bytes: Uint8Array.from(createDeterministicMp3Fixture()),
							final: true,
						});
					});
				});
			}
			async health(): Promise<TtsHealth> {
				return "ready";
			}
		}
		class BargeBrain implements BrainPort {
			async createThread(): Promise<string> {
				return "barge-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				yield* speechScript(
					"Эта фраза достаточно длинная для запуска синтеза, который намеренно игнорирует сигнал отмены.",
					input.turnId,
					input.generationId,
				);
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const tts = new AbortInsensitiveTts();
		const { orchestrator } = fixture({
			brain: new BargeBrain(),
			tts,
			initialState: valueState(),
		});

		async function startHangingTurn(turnId: string, generationId: string) {
			const iterator = orchestrator
				.acceptAudioCommit(commit(turnId, generationId))
				[Symbol.asyncIterator]();
			expect((await iterator.next()).value).toMatchObject({
				type: "transcript.final",
			});
			expect((await iterator.next()).value).toMatchObject({
				type: "text.delta",
			});
			const pending = iterator.next();
			while (tts.inputs.length < tts.unresolved) await Promise.resolve();
			return { iterator, pending };
		}

		const first = await startHangingTurn(turn1, generation1);
		while (tts.inputs.length < 1) await Promise.resolve();
		await orchestrator.interrupt(generation1);
		const second = await startHangingTurn(turn2, generation2);
		while (tts.inputs.length < 2) await Promise.resolve();
		await orchestrator.interrupt(generation2);
		const turn3 = "01J00000000000000000000012";
		const generation3 = "01J00000000000000000000022";
		const third = await collect(
			orchestrator.acceptAudioCommit(commit(turn3, generation3)),
		);
		expect(tts.inputs).toHaveLength(2);
		expect(tts.unresolved).toBe(2);
		expect(tts.maxUnresolved).toBe(2);
		expect(third).toContainEqual(
			expect.objectContaining({ type: "degraded", provider: "tts" }),
		);

		tts.releases[0]?.();
		tts.releases[1]?.();
		const staleEvents: OrchestratorEvent[] = [];
		for (const hanging of [first, second]) {
			const pending = await hanging.pending;
			if (!pending.done) staleEvents.push(pending.value);
			for (;;) {
				const item = await hanging.iterator.next();
				if (item.done) break;
				staleEvents.push(item.value);
			}
		}
		expect(tts.unresolved).toBe(0);
		expect(staleEvents.some((event) => event.type === "audio.segment")).toBe(
			false,
		);
	});

	test("first phrase reaches TTS before Luna produces the second", async () => {
		const timeline: string[] = [];
		class TimedBrain implements BrainPort {
			async createThread(): Promise<string> {
				return "timed-thread";
			}
			async *runTurn(input: BrainTurnInput): AsyncIterable<BrainDelta> {
				timeline.push("brain.first");
				yield {
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Первая фраза достаточно длинная для раннего запуска синтеза и быстрой реакции.",
				};
				timeline.push("brain.second");
				yield {
					type: "speech.delta",
					turnId: input.turnId,
					generationId: input.generationId,
					text: " Вторая фраза завершает ответ.",
				};
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		class TimedTts extends FakeTts {
			override async synthesize(
				request: TtsSynthesisRequest,
			): Promise<TtsAudioSegment> {
				timeline.push(`tts:${request.text}`);
				return super.synthesize(request);
			}
		}
		const { orchestrator } = fixture({
			brain: new TimedBrain(),
			tts: new TimedTts(),
			initialState: valueState(),
		});
		await collect(orchestrator.acceptAudioCommit(commit()));
		expect(timeline.indexOf("brain.first")).toBeLessThan(
			timeline.findIndex((entry) => entry.startsWith("tts:")),
		);
		expect(
			timeline.findIndex((entry) => entry.startsWith("tts:")),
		).toBeLessThan(timeline.indexOf("brain.second"));
	});
});
