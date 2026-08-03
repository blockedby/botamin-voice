import { describe, expect, test } from "bun:test";
import type {
	AppendQualificationInput,
	BookingService,
	BrainDelta,
	BrainPort,
	BrainTurnInput,
	CreateBookingInput,
	MeetingTimeBand,
	MeetingTimePreference,
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
import { containsPhoneLikeText } from "@botamin/contracts";
import {
	createDeterministicMp3Fixture,
	createTestBookingContacts,
	createTestMeetingSlot,
	FakeBookingService,
	FakeBrain,
	FakeNotifier,
	FakeStt,
	FakeTts,
} from "../../../../packages/test-fixtures/src";
import {
	generateCandidateMeetingSlots,
	generateMeetingSlotProposal,
} from "../domain/booking";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "./orchestrator";
import {
	prepareSpeech,
	type SpeechBudgetOptions,
	type SpeechChunkerOptions,
} from "./speech";
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
	contacts: createTestBookingContacts(),
	company: "Example LLC",
	meetingSlot: createTestMeetingSlot(),
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

function expectNoTerminalCompletion(events: OrchestratorEvent[]): void {
	expect(events.filter((event) => event.type.endsWith(".done"))).toEqual([]);
}

function fixture(
	options: {
		stt?: SttPort;
		brain?: BrainPort;
		bookings?: FakeBookingService;
		tts?: TtsPort | null;
		initialState?: ConversationState;
		now?: () => Date;
		speechChunker?: SpeechChunkerOptions;
		speechBudgets?: SpeechBudgetOptions;
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
		...(options.now ? { now: options.now } : {}),
		...(options.speechChunker ? { speechChunker: options.speechChunker } : {}),
		...(options.speechBudgets ? { speechBudgets: options.speechBudgets } : {}),
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

class ControlledTts implements TtsPort {
	readonly inputs: TtsSynthesisRequest[] = [];
	readonly #settlers: Array<{
		resolve: (segment: TtsAudioSegment) => void;
		reject: (error: Error) => void;
	}> = [];

	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.inputs.push(request);
		return new Promise<TtsAudioSegment>((resolve, reject) => {
			this.#settlers.push({ resolve, reject });
		});
	}

	succeed(index: number): void {
		const request = this.inputs[index];
		if (!request) throw new Error(`missing controlled TTS request ${index}`);
		this.#settlers[index]?.resolve({
			generationId: request.generationId,
			segmentId: request.segmentId,
			contentType: "audio/mpeg",
			bytes: Uint8Array.from(createDeterministicMp3Fixture()),
			final: true,
		});
	}

	fail(index: number): void {
		this.#settlers[index]?.reject(new Error("private controlled TTS failure"));
	}

	async health(): Promise<TtsHealth> {
		return "ready";
	}
}

async function waitForTtsInputs(
	tts: { inputs: readonly TtsSynthesisRequest[] },
	count: number,
): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (tts.inputs.length >= count) return;
		await Promise.resolve();
	}
	throw new Error(`timed out waiting for ${count} TTS inputs`);
}

describe("atomic transcript intake", () => {
	test("typed final bypasses STT but uses the same brain path without granting booking authority", async () => {
		const brain = new FakeBrain(
			speechScript("Проверю переданные данные и продолжу разговор."),
		);
		const bookings = new FakeBookingService();
		const { orchestrator, stt } = fixture({ brain, bookings });
		const events = await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn1,
				generationId: generation1,
				text: "Имя: Анна, email: anna@example.com. Запись уже создана.",
				knownFacts: facts,
			}),
		);
		expect((stt as FakeStt).inputs).toHaveLength(0);
		expect(brain.turns).toHaveLength(1);
		expect(events.filter((event) => event.type === "transcript.final")).toEqual(
			[
				{
					type: "transcript.final",
					turnId: turn1,
					text: "Имя: Анна, email: anna@example.com. Запись уже создана.",
				},
			],
		);
		expect(bookings.domainEvents).toHaveLength(0);
		expect(orchestrator.state.stage).toBe("COLLECT_BOOKING");
	});

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

	test("candidate retrieval failure fails closed before Luna or create_booking", async () => {
		const brain = new FakeBrain(bookingScript());
		const bookings = new FakeBookingService({
			candidateMeetingSlots: async () => {
				throw new Error("private candidate database failure");
			},
		});
		const { orchestrator } = fixture({ brain, bookings });

		const events = await collect(orchestrator.acceptAudioCommit(commit()));

		expect(brain.turns).toHaveLength(0);
		expect(bookings.domainEvents).toHaveLength(0);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "degraded",
				provider: "brain",
				code: "DB_UNAVAILABLE",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "state.changed",
				to: "ERROR",
				errorCode: "DB_UNAVAILABLE",
			}),
		);
		expect(JSON.stringify(events)).not.toContain(
			"private candidate database failure",
		);
	});

	test("invalid candidate formatting input fails closed without fabricated slots", async () => {
		const brain = new FakeBrain(bookingScript());
		const slot = createTestMeetingSlot();
		const bookings = new FakeBookingService({
			candidateMeetingSlots: () => [slot, slot],
		});
		const { orchestrator } = fixture({ brain, bookings });

		const events = await collect(orchestrator.acceptAudioCommit(commit()));

		expect(brain.turns).toHaveLength(0);
		expect(bookings.domainEvents).toHaveLength(0);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "degraded",
				code: "DB_UNAVAILABLE",
			}),
		);
	});

	test("typed and spoken positive preferences use the same server-owned proposal path", async () => {
		const now = new Date("2025-01-09T09:00:00.000Z");
		for (const [text, expected] of [
			["сегодня в одиннадцать часов вечера", "evening"],
			["во второй половине дня", "second_half"],
		] as const) {
			const requested: Array<{
				preference: MeetingTimePreference;
				rejected: readonly MeetingTimeBand[];
			}> = [];
			const candidateMeetingSlots = (
				preference: MeetingTimePreference = "none",
				rejected: readonly MeetingTimeBand[] = [],
			) => {
				requested.push({ preference, rejected });
				return generateCandidateMeetingSlots(now, [], preference, rejected);
			};
			const typedBrain = new FakeBrain([]);
			const typed = fixture({
				brain: typedBrain,
				bookings: new FakeBookingService({ candidateMeetingSlots }),
				now: () => now,
			});
			await collect(
				typed.orchestrator.acceptTextSubmit({
					turnId: turn1,
					generationId: generation1,
					text,
					knownFacts: facts,
				}),
			);

			const spokenBrain = new FakeBrain([]);
			const spoken = fixture({
				brain: spokenBrain,
				stt: new FakeStt({ text }),
				bookings: new FakeBookingService({ candidateMeetingSlots }),
				now: () => now,
			});
			await collect(spoken.orchestrator.acceptAudioCommit(commit()));

			expect(requested).toEqual([
				{ preference: expected, rejected: [] },
				{ preference: expected, rejected: [] },
			]);
			expect(typedBrain.turns[0]?.schedulingContext).toEqual(
				spokenBrain.turns[0]?.schedulingContext,
			);
			expect(typedBrain.turns[0]?.schedulingContext).toMatchObject({
				timeOfDayPreference: expected,
				rejectedTimeOfDayPreferences: [],
			});
		}
	});

	test("typed and spoken exact Moscow requests refresh the same candidates before Luna", async () => {
		const now = new Date("2026-08-02T09:00:00.000Z");
		const text = "4 августа в 11";
		const contexts: BrainTurnInput["schedulingContext"][] = [];
		for (const spoken of [false, true]) {
			const brain = new FakeBrain([]);
			const harness = fixture({
				brain,
				...(spoken ? { stt: new FakeStt({ text }) } : {}),
				bookings: new FakeBookingService({
					candidateMeetingSlots: (
						preference = "none",
						rejected = [],
						request,
					) => {
						if (!request) throw new Error("missing concrete request input");
						return generateMeetingSlotProposal(
							new Date(request.currentInstant),
							request.userText,
							[],
							preference,
							rejected,
						).slots;
					},
				}),
				now: () => now,
			});
			if (spoken) {
				await collect(harness.orchestrator.acceptAudioCommit(commit()));
			} else {
				await collect(
					harness.orchestrator.acceptTextSubmit({
						turnId: turn1,
						generationId: generation1,
						text,
						knownFacts: facts,
					}),
				);
			}
			const scheduling = brain.turns[0]?.schedulingContext;
			if (!scheduling) throw new Error("missing scheduling context");
			contexts.push(scheduling);
		}

		expect(contexts[0]).toEqual(contexts[1]);
		expect(contexts[0]).toMatchObject({
			currentInstant: "2026-08-02T09:00:00.000Z",
			timeOfDayPreference: "none",
			rejectedTimeOfDayPreferences: [],
			concreteRequestInterpretation: {
				kind: "included",
				requestedMoscowLocalDate: "2026-08-04",
				requestedMoscowLocalTime: "11:00",
				reason: "exact_request_included",
				candidateIndex: 1,
			},
		});
		expect(
			contexts[0]?.candidateMeetingSlots.map(
				(candidate) => candidate.meetingSlot.startAt,
			),
		).toEqual(["2026-08-04T07:40:00.000Z", "2026-08-04T08:00:00.000Z"]);
	});

	test("occupied exact time stays on date and a full requested date rolls forward", async () => {
		const now = new Date("2026-08-02T09:00:00.000Z");
		const moscowStartAt = (date: string, minute: number): string => {
			const [year, month, day] = date.split("-").map(Number);
			return new Date(
				Date.UTC(
					year as number,
					(month as number) - 1,
					day,
					Math.floor(minute / 60) - 3,
					minute % 60,
				),
			).toISOString();
		};
		const occupiedCases = [
			{
				occupied: [moscowStartAt("2026-08-04", 11 * 60)],
				expectedStarts: [
					moscowStartAt("2026-08-04", 10 * 60 + 40),
					moscowStartAt("2026-08-04", 11 * 60 + 20),
				],
				expectedReason: "exact_time_not_included",
			},
			{
				occupied: Array.from({ length: 25 }, (_, index) =>
					moscowStartAt("2026-08-04", 9 * 60 + index * 20),
				),
				expectedStarts: [
					moscowStartAt("2026-08-05", 10 * 60 + 40),
					moscowStartAt("2026-08-05", 11 * 60),
				],
				expectedReason: "requested_date_unsatisfied",
			},
		] as const;

		for (const testCase of occupiedCases) {
			const brain = new FakeBrain([]);
			const { orchestrator } = fixture({
				brain,
				bookings: new FakeBookingService({
					candidateMeetingSlots: (
						preference = "none",
						rejected = [],
						request,
					) => {
						if (!request) throw new Error("missing concrete request input");
						return generateMeetingSlotProposal(
							new Date(request.currentInstant),
							request.userText,
							testCase.occupied,
							preference,
							rejected,
						).slots;
					},
				}),
				now: () => now,
			});
			await collect(
				orchestrator.acceptTextSubmit({
					turnId: turn1,
					generationId: generation1,
					text: "4 августа в 11",
					knownFacts: facts,
				}),
			);

			const scheduling = brain.turns[0]?.schedulingContext;
			expect(
				scheduling?.candidateMeetingSlots.map(
					(candidate) => candidate.meetingSlot.startAt,
				),
			).toEqual([...testCase.expectedStarts]);
			expect(scheduling?.concreteRequestInterpretation).toEqual({
				kind: "not_included",
				requestedMoscowLocalDate: "2026-08-04",
				requestedMoscowLocalTime: "11:00",
				reason: testCase.expectedReason,
				candidateIndex: null,
			});
		}
	});

	test("same-day and invalid concrete requests clear stale bands without becoming broad preferences", async () => {
		const now = new Date("2026-08-02T09:00:00.000Z");
		for (const [text, reason] of [
			["сегодня в 11:00", "same_day"],
			["4 августа в 11:10", "off_grid"],
		] as const) {
			const requested: MeetingTimePreference[] = [];
			const brain = new FakeBrain([], []);
			const { orchestrator } = fixture({
				brain,
				bookings: new FakeBookingService({
					candidateMeetingSlots: (
						preference = "none",
						rejected = [],
						request,
					) => {
						requested.push(preference);
						return request
							? generateMeetingSlotProposal(
									new Date(request.currentInstant),
									request.userText,
									[],
									preference,
									rejected,
								).slots
							: generateCandidateMeetingSlots(now, [], preference, rejected);
					},
				}),
				now: () => now,
			});
			await collect(
				orchestrator.acceptTextSubmit({
					turnId: turn1,
					generationId: generation1,
					text: "Давайте вечером",
					knownFacts: facts,
				}),
			);
			await collect(
				orchestrator.acceptTextSubmit({
					turnId: turn2,
					generationId: generation2,
					text,
					knownFacts: facts,
				}),
			);

			expect(requested).toEqual(["evening", "none"]);
			expect(brain.turns[1]?.schedulingContext).toMatchObject({
				timeOfDayPreference: "none",
				rejectedTimeOfDayPreferences: [],
				concreteRequestInterpretation: {
					kind: "not_included",
					reason,
					candidateIndex: null,
				},
			});
			expect(
				brain.turns[1]?.schedulingContext.candidateMeetingSlots.map(
					(candidate) => candidate.meetingSlot.startAt,
				),
			).toEqual(["2026-08-03T06:00:00.000Z", "2026-08-03T13:00:00.000Z"]);
		}
	});

	test("a turn without a concrete mention retains the current broad preference", async () => {
		const now = new Date("2026-08-02T09:00:00.000Z");
		const brain = new FakeBrain([], []);
		const { orchestrator } = fixture({
			brain,
			bookings: new FakeBookingService({
				candidateMeetingSlots: (preference = "none", rejected = []) =>
					generateCandidateMeetingSlots(now, [], preference, rejected),
			}),
			now: () => now,
		});
		for (const [turnId, generationId, text] of [
			[turn1, generation1, "Давайте утром"],
			[turn2, generation2, "Это подходит"],
		] as const) {
			await collect(
				orchestrator.acceptTextSubmit({
					turnId,
					generationId,
					text,
					knownFacts: facts,
				}),
			);
		}

		expect(
			brain.turns.map((turn) => turn.schedulingContext.timeOfDayPreference),
		).toEqual(["morning", "morning"]);
		expect(
			brain.turns[1]?.schedulingContext.concreteRequestInterpretation,
		).toEqual({ kind: "none" });
	});

	test("a later out-of-hours preference refreshes Luna data with evening policy slots", async () => {
		const now = new Date("2025-01-09T09:00:00.000Z");
		const requested: MeetingTimePreference[] = [];
		const brain = new FakeBrain([], []);
		const { orchestrator } = fixture({
			brain,
			bookings: new FakeBookingService({
				candidateMeetingSlots: (preference = "none") => {
					requested.push(preference);
					return generateCandidateMeetingSlots(now, [], preference);
				},
			}),
			now: () => now,
		});

		await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn1,
				generationId: generation1,
				text: "Давайте утром",
				knownFacts: facts,
			}),
		);
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn2,
				generationId: generation2,
				text: "Нет, лучше в 23:00",
				knownFacts: facts,
			}),
		);

		expect(requested).toEqual(["morning", "evening"]);
		expect(brain.turns).toHaveLength(2);
		expect(brain.turns[1]?.schedulingContext.timeOfDayPreference).toBe(
			"evening",
		);
		expect(
			brain.turns[1]?.schedulingContext.candidateMeetingSlots.map(
				(candidate) => candidate.displayLabel,
			),
		).toEqual([
			"10 января 2025 года, пятница, 16:00–16:20 по Москве",
			"10 января 2025 года, пятница, 17:00–17:20 по Москве",
		]);
		expect(JSON.stringify(brain.turns[1])).not.toContain("23:00–23:20");
	});

	test("typed and spoken evening rejections produce only non-evening server candidates", async () => {
		const now = new Date("2025-01-09T09:00:00.000Z");
		for (const [text, spoken] of [
			["Мне неудобно вечером", false],
			["Вечером не могу", true],
		] as const) {
			const brain = new FakeBrain([]);
			const harness = fixture({
				brain,
				...(spoken ? { stt: new FakeStt({ text }) } : {}),
				bookings: new FakeBookingService({
					candidateMeetingSlots: (preference = "none", rejected = []) =>
						generateCandidateMeetingSlots(now, [], preference, rejected),
				}),
				now: () => now,
			});
			if (spoken) {
				await collect(harness.orchestrator.acceptAudioCommit(commit()));
			} else {
				await collect(
					harness.orchestrator.acceptTextSubmit({
						turnId: turn1,
						generationId: generation1,
						text,
						knownFacts: facts,
					}),
				);
			}
			const scheduling = brain.turns[0]?.schedulingContext;
			expect(scheduling).toMatchObject({
				timeOfDayPreference: "none",
				rejectedTimeOfDayPreferences: ["evening"],
			});
			expect(
				scheduling?.candidateMeetingSlots.map(
					(candidate) => candidate.meetingSlot.startAt,
				),
			).toEqual(["2025-01-10T06:00:00.000Z", "2025-01-10T11:00:00.000Z"]);
		}
	});

	test("a second-turn bare rejection clears and does not retain evening", async () => {
		const now = new Date("2025-01-09T09:00:00.000Z");
		const requested: Array<{
			preference: MeetingTimePreference;
			rejected: readonly MeetingTimeBand[];
		}> = [];
		const brain = new FakeBrain([], []);
		const { orchestrator } = fixture({
			brain,
			bookings: new FakeBookingService({
				candidateMeetingSlots: (preference = "none", rejected = []) => {
					requested.push({ preference, rejected });
					return generateCandidateMeetingSlots(now, [], preference, rejected);
				},
			}),
			now: () => now,
		});
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn1,
				generationId: generation1,
				text: "Давайте вечером",
				knownFacts: facts,
			}),
		);
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn2,
				generationId: generation2,
				text: "Не вечером",
				knownFacts: facts,
			}),
		);

		expect(requested).toEqual([
			{ preference: "evening", rejected: [] },
			{ preference: "none", rejected: ["evening"] },
		]);
		expect(brain.turns[1]?.schedulingContext).toMatchObject({
			timeOfDayPreference: "none",
			rejectedTimeOfDayPreferences: ["evening"],
		});
		expect(
			brain.turns[1]?.schedulingContext.candidateMeetingSlots.map(
				(candidate) => candidate.meetingSlot.startAt,
			),
		).toEqual(["2025-01-10T06:00:00.000Z", "2025-01-10T11:00:00.000Z"]);
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
		expectNoTerminalCompletion(lateEvents);
		expect(laterEvents).toEqual([
			{ type: "ignored", generationId: generation2, source: "audio.commit" },
		]);
	});

	test("abort-insensitive brain finishing after DECLINED emits no stale text.done", async () => {
		let release!: () => void;
		let started!: () => void;
		const brainStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class AbortInsensitiveFinishingBrain implements BrainPort {
			async createThread(): Promise<string> {
				return "late-finishing-thread";
			}
			async *runTurn(): AsyncIterable<BrainDelta> {
				started();
				await gate;
				yield* [] as BrainDelta[];
			}
			async interrupt(): Promise<void> {}
			async health(): Promise<ProviderHealth> {
				return { status: "healthy" };
			}
		}
		const { orchestrator } = fixture({
			brain: new AbortInsensitiveFinishingBrain(),
			initialState: valueState(),
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
		const lateEvents: OrchestratorEvent[] = [];
		const first = await pending;
		if (!first.done) lateEvents.push(first.value);
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			lateEvents.push(item.value);
		}
		expect(lateEvents).toEqual([]);
		expectNoTerminalCompletion(lateEvents);
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
		const lateEvents: OrchestratorEvent[] = [];
		const first = await pending;
		if (!first.done) lateEvents.push(first.value);
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			lateEvents.push(item.value);
		}
		for (const event of lateEvents)
			expect(event.type).not.toMatch(/booking|tool|audio/u);
		expectNoTerminalCompletion(lateEvents);
		expect(bookings.domainEvents).toHaveLength(0);
	});

	test("terminal DECLINED suppresses late TTS segment and all completion", async () => {
		let release!: () => void;
		let started!: () => void;
		const synthesisStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		class AbortInsensitiveTts implements TtsPort {
			async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
				started();
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
				"Ответ достаточно длинный, чтобы синтез начался до внешнего завершения разговора.",
			),
		);
		const { orchestrator } = fixture({
			brain,
			tts: new AbortInsensitiveTts(),
			initialState: valueState(),
		});
		const iterator = orchestrator
			.acceptAudioCommit(commit())
			[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({
			type: "transcript.final",
		});
		expect((await iterator.next()).value).toMatchObject({ type: "text.delta" });
		const pending = iterator.next();
		await synthesisStarted;
		expect(orchestrator.apply({ type: "clear_refusal" })).toMatchObject({
			ok: true,
			state: { stage: "DECLINED" },
		});
		release();
		const lateEvents: OrchestratorEvent[] = [];
		const first = await pending;
		if (!first.done) lateEvents.push(first.value);
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			lateEvents.push(item.value);
		}
		expect(lateEvents.some((event) => event.type === "audio.segment")).toBe(
			false,
		);
		expectNoTerminalCompletion(lateEvents);
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
		expect(spoken).toContain("Внутренняя виртуальная встреча создана");
		expect(spoken).toContain(
			"Внешнее календарное событие и приглашение не создавались",
		);
		expect(spoken).not.toMatch(/CRM|объём лидов/u);
		expect(orchestrator.state).toMatchObject({
			stage: "POST_BOOKING_QUALIFICATION",
			booking: { status: "booked" },
			bookingConfirmationDelivered: true,
		});
		expect((brain as FakeBrain).turns).toHaveLength(1);
		expect(tts.inputs[0]).toMatchObject({
			turnId: turn1,
			generationId: generation1,
		});
	});

	test("booking confirmation starts by asking only the first missing qualification field", async () => {
		const brain = new FakeBrain(bookingScript());
		const { orchestrator } = fixture({ brain });
		const bookingEvents = await collect(
			orchestrator.acceptAudioCommit(commit()),
		);
		const confirmation = bookingEvents
			.filter((event) => event.type === "text.delta")
			.map((event) => event.text)
			.join(" ");
		expect(confirmation).toContain("Сколько входящих лидов приходит за месяц?");
		expect(confirmation).not.toContain("Можно задать два коротких вопроса?");
		expect(brain.turns).toHaveLength(1);
		expect(orchestrator.state.stage).toBe("POST_BOOKING_QUALIFICATION");
	});

	for (const scenario of [
		{
			name: "first partial asks the missing manager-count question",
			patch: { monthlyLeadVolume: "около 240" },
			completion: "complete" as const,
			expectedStatus: "partial" as const,
			expected:
				"Дополнительный ответ сохранён. Сколько менеджеров по продажам работает в вашей команде?",
			terminal: false,
		},
		{
			name: "reverse field order asks only for missing monthly leads",
			patch: { salesManagerCount: 8 },
			completion: "complete" as const,
			expectedStatus: "partial" as const,
			expected:
				"Дополнительный ответ сохранён. Сколько входящих лидов приходит за месяц?",
			terminal: false,
		},
		{
			name: "both fields at once complete despite a partial model claim",
			patch: { monthlyLeadVolume: "около 240", salesManagerCount: 8 },
			completion: "partial" as const,
			expectedStatus: "complete" as const,
			expected: "Дополнительные ответы сохранены. Спасибо, на этом всё.",
			terminal: true,
		},
	] as const) {
		test(scenario.name, async () => {
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
			};
			const brain = new FakeBrain([
				{
					type: "speech.delta",
					turnId: turn1,
					generationId: generation1,
					text: "Модель ложно подтверждает завершение.",
				},
				{
					type: "tool.request",
					turnId: turn1,
					generationId: generation1,
					tool: {
						name: "append_booking_qualification",
						callId: `qualification-${scenario.expectedStatus}-${scenario.patch.salesManagerCount ?? "leads"}`,
						args: {
							bookingId: booking.id,
							idempotencyKey: `qualification-${scenario.expectedStatus}-${scenario.patch.salesManagerCount ?? "leads"}-truthful`,
							patch: scenario.patch,
							completion: scenario.completion,
						},
					},
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
				.filter((event) => event.type === "text.delta")
				.map((event) => event.text)
				.join(" ");
			expect(visible).toBe(scenario.expected);
			expect(visible).not.toContain("Модель");
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "booking.updated",
					qualificationStatus: scenario.expectedStatus,
				}),
			);
			expect(orchestrator.state).toMatchObject({
				stage: scenario.terminal ? "COMPLETE" : "POST_BOOKING_QUALIFICATION",
				booking: {
					status: "booked",
					qualificationStatus: scenario.expectedStatus,
					qualification: scenario.patch,
				},
			});
		});
	}

	test("exact eval refusal after one answer completes without brain and preserves partial booking", async () => {
		const emptyBookings = new FakeBookingService();
		await emptyBookings.createBooking(bookingInput);
		const emptyBooking =
			await emptyBookings.findByConversationId(conversationId);
		if (!emptyBooking) throw new Error("booking missing");
		const emptyBrain = new FakeBrain([]);
		const empty = fixture({
			brain: emptyBrain,
			bookings: emptyBookings,
			initialState: {
				...createInitialConversationState(),
				stage: "BOOKED",
				booking: emptyBooking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: true,
			},
		});
		const skippedEvents = await collect(
			empty.orchestrator.acceptTextSubmit({
				turnId: turn1,
				generationId: generation1,
				text: "Нет, не задавайте.",
				knownFacts: facts,
			}),
		);
		expect(emptyBrain.turns).toHaveLength(0);
		expect(empty.orchestrator.state).toMatchObject({
			stage: "COMPLETE",
			booking: { status: "booked", qualificationStatus: "skipped" },
		});
		expect(skippedEvents).toContainEqual(
			expect.objectContaining({
				type: "booking.updated",
				qualificationStatus: "skipped",
			}),
		);

		const partialBookings = new FakeBookingService();
		const created = await partialBookings.createBooking(bookingInput);
		await partialBookings.appendQualification({
			bookingId: created.bookingId,
			idempotencyKey: "qualification-before-refusal",
			patch: { monthlyLeadVolume: "около 240" },
			completion: "complete",
		});
		const partialBooking =
			await partialBookings.findByConversationId(conversationId);
		if (!partialBooking) throw new Error("booking missing");
		const partialBrain = new FakeBrain([]);
		const partial = fixture({
			brain: partialBrain,
			bookings: partialBookings,
			initialState: {
				...createInitialConversationState(),
				stage: "POST_BOOKING_QUALIFICATION",
				booking: partialBooking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: true,
			},
		});
		const updatesBeforeRefusal = partialBookings.domainEvents.length;
		const refusedEvents = await collect(
			partial.orchestrator.acceptTextSubmit({
				turnId: turn2,
				generationId: generation2,
				text: "Нет, на этом всё.",
				knownFacts: facts,
			}),
		);
		expect(partialBrain.turns).toHaveLength(0);
		expect(partialBookings.domainEvents).toHaveLength(updatesBeforeRefusal);
		expect(partial.orchestrator.state).toMatchObject({
			stage: "COMPLETE",
			booking: {
				status: "booked",
				qualificationStatus: "partial",
				qualification: { monthlyLeadVolume: "около 240" },
			},
		});
		expect(
			refusedEvents
				.filter((event) => event.type === "text.delta")
				.map((event) => event.text)
				.join(" "),
		).not.toMatch(/сколько|продолж/u);
	});

	test("current brain failure retains its truthful server-authored terminal response", async () => {
		const brain = new FakeBrain([
			{
				type: "error",
				turnId: turn1,
				generationId: generation1,
				error: {
					code: "BRAIN_PROTOCOL_ERROR",
					message: "private provider detail",
					retryable: true,
				},
			},
		]);
		const { orchestrator } = fixture({
			brain,
			tts: null,
			initialState: valueState(),
		});
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		const expected =
			"Сейчас не получается продолжить разговор. Данные ещё не были сохранены.";
		expect(orchestrator.state.stage).toBe("ERROR");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "degraded",
				provider: "brain",
				textFallback: expected,
			}),
		);
		expect(events).toContainEqual({
			type: "text.done",
			generationId: generation1,
			text: expected,
		});
		expect(JSON.stringify(events)).not.toContain("private provider detail");
	});

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
		expect(spoken).toContain("Внутренняя виртуальная встреча создана");
		expect(spoken).toContain(
			"Внешнее календарное событие и приглашение не создавались",
		);
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
						patch: { monthlyLeadVolume: "около 240" },
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
						patch: { salesManagerCount: 8 },
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
			booking: {
				status: "booked",
				qualification: { monthlyLeadVolume: "около 240" },
			},
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
			async candidateMeetingSlots() {
				return delegate.candidateMeetingSlots();
			}
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
		const lateEvents: OrchestratorEvent[] = [];
		const first = await pending;
		if (!first.done) lateEvents.push(first.value);
		for (;;) {
			const item = await iterator.next();
			if (item.done) break;
			lateEvents.push(item.value);
		}
		expect(lateEvents.some((event) => event.type === "booking.committed")).toBe(
			false,
		);
		expectNoTerminalCompletion(lateEvents);
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
			"Напишите на name@example.com, в Telegram @private_sales или +7:999:123:45:67 и +7•999·123/45,67. Подробности: https://example.com/path.";
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

	test("keeps every allowed numeric form intact at provider-bound delta and hard boundaries", async () => {
		const controls = [
			"Обычная вводная Дело № 1234567.",
			"Дата 10.08.2026.",
			"Время 16:00.",
			"Доля 1234567 %.",
			"Значение 1234567,89.",
			"Диапазон 1000000 - 2000000.",
			"Обработано 1 000 000 заявок.",
		] as const;
		for (const control of controls) {
			const firstDigit = control.search(/\p{N}/u);
			if (firstDigit <= 0) throw new Error("numeric control is malformed");
			const hardPadding = "текст ".repeat(
				Math.max(1, Math.ceil((116 - firstDigit) / 6)),
			);
			const hardSource = `${hardPadding}${control}`;
			const scenarios = [
				{ name: "trailing", source: control, deltas: [control] },
				{
					name: "delta",
					source: control,
					deltas: [control.slice(0, firstDigit), control.slice(firstDigit)],
				},
				{ name: "hard", source: hardSource, deltas: [hardSource] },
			] as const;
			for (const scenario of scenarios) {
				const brain = new FakeBrain([
					...scenario.deltas.map(
						(text): BrainDelta => ({
							type: "speech.delta",
							turnId: turn1,
							generationId: generation1,
							text,
						}),
					),
					{
						type: "turn.completed",
						turnId: turn1,
						generationId: generation1,
					},
				]);
				const tts = new FakeTts();
				const { orchestrator } = fixture({
					brain,
					tts,
					initialState: valueState(),
					speechChunker: {
						firstMinimum: 1,
						firstTarget: 20,
						softTarget: 120,
						hardLimit: 120,
					},
				});
				const events = await collect(orchestrator.acceptAudioCommit(commit()));
				const providerBound = tts.inputs.map((input) => input.text).join(" ");
				expect(
					events.find((event) => event.type === "text.done"),
				).toMatchObject({ text: scenario.source });
				expect(providerBound, `${control} at ${scenario.name}`).toBe(
					scenario.source,
				);
				expect(providerBound).not.toContain("контакт скрыт");
				expect(tts.inputs.every((input) => input.text.length <= 120)).toBe(
					true,
				);
				if (scenario.name === "hard") {
					expect(tts.inputs.length).toBeGreaterThan(1);
				}
			}
		}
	});

	test("never reconstructs the reviewer Unicode phone across provider calls or retries", async () => {
		const source = "Телефон +⁷.⁹⁹⁹.¹²³.⁴⁵.⁶⁷";
		const twoDeltaSplits = Array.from(
			{ length: source.length - 1 },
			(_, index) => [source.slice(0, index + 1), source.slice(index + 1)],
		);
		const permutations: readonly (readonly string[])[] = [
			[source],
			...twoDeltaSplits,
			["Телефон +⁷.", "⁹⁹⁹.", "¹²³.", "⁴⁵.", "⁶⁷"],
			["Телефон ", "+", "⁷", ".", "⁹⁹", "⁹.¹", "²³.⁴⁵.⁶", "⁷"],
			[...source],
		];

		for (const deltas of permutations) {
			const brain = new FakeBrain([
				...deltas.map(
					(text): BrainDelta => ({
						type: "speech.delta",
						turnId: turn1,
						generationId: generation1,
						text,
					}),
				),
				{ type: "turn.completed", turnId: turn1, generationId: generation1 },
			]);
			const tts = new RetryTts();
			const { orchestrator } = fixture({
				brain,
				tts,
				initialState: valueState(),
				speechChunker: {
					firstMinimum: 1,
					firstTarget: 20,
					softTarget: 120,
					hardLimit: 120,
				},
			});
			const events = await collect(orchestrator.acceptAudioCommit(commit()));
			const providerBound = tts.inputs.map((input) => input.text).join(" ");
			const normalizedDigits = providerBound
				.normalize("NFKC")
				.replace(/\D/gu, "");

			expect(events.find((event) => event.type === "text.done")).toMatchObject({
				text: source,
			});
			expect(tts.inputs.length).toBeGreaterThan(0);
			expect(tts.attempts).toBe(tts.inputs.length * 2);
			expect(tts.inputs.every((input) => input.text.length <= 120)).toBe(true);
			expect(providerBound).toContain("контакт скрыт");
			expect(providerBound).not.toContain(source);
			expect(containsPhoneLikeText(providerBound)).toBe(false);
			expect(normalizedDigits).not.toMatch(/\d{8}/u);
		}
	});

	test("actual TTS speaks an exact committed phone atomically across model deltas", async () => {
		const approvedPhone = "+79555678955";
		const bookings = new FakeBookingService();
		await bookings.createBooking({
			...bookingInput,
			contacts: [
				{ channel: "email", value: "fixture@example.com" },
				{ channel: "phone", value: approvedPhone },
			],
		});
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const visible = "Телефон +7 955 567-89-55.";
		const brain = new FakeBrain([
			...["Телефон +7 ", "955 ", "567-", "89-", "55."].map(
				(text): BrainDelta => ({
					type: "speech.delta",
					turnId: turn2,
					generationId: generation2,
					text,
				}),
			),
			{ type: "turn.completed", turnId: turn2, generationId: generation2 },
		]);
		const tts = new FakeTts();
		const { orchestrator } = fixture({
			bookings,
			brain,
			tts,
			initialState: {
				...createInitialConversationState(),
				stage: "POST_BOOKING_QUALIFICATION",
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: true,
			},
			speechChunker: {
				firstMinimum: 1,
				firstTarget: 20,
				softTarget: 120,
				hardLimit: 120,
			},
		});
		const events = await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn2,
				generationId: generation2,
				text: "Продолжайте.",
				knownFacts: facts,
			}),
		);
		expect(events.find((event) => event.type === "text.done")).toMatchObject({
			text: visible,
		});
		expect(tts.inputs).toHaveLength(1);
		expect(tts.inputs[0]?.text).toBe(
			"Телефон плюс семь, девятьсот пятьдесят пять, пятьсот шестьдесят семь, восемьдесят девять, пятьдесят пять.",
		);
		expect(tts.inputs[0]?.text).not.toMatch(/7955|контакт скрыт/u);
	});

	test("recording TTS keeps approved contacts atomic across provider placements", async () => {
		const approvedContacts = [
			{ channel: "email", value: "atomic.contact@example.com" },
			{ channel: "phone", value: "+79555678955" },
			{ channel: "telegram", value: "@Atomic_Sales" },
		] as const;
		const bookings = new FakeBookingService();
		await bookings.createBooking({
			...bookingInput,
			contacts: [...approvedContacts],
		});
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const initialState: ConversationState = {
			...createInitialConversationState(),
			stage: "POST_BOOKING_QUALIFICATION",
			booking,
			contactConsentConfirmed: true,
			bookingConfirmationDelivered: true,
		};
		const broadPlacements = Array.from(
			{ length: 14 },
			(_, index) => index * 20,
		);
		for (const contact of approvedContacts) {
			const contactOnly = prepareSpeech(contact.value, {
				contactProcessing: true,
				approvedContacts: [contact],
			}).spokenText;
			const placements =
				contact.channel === "phone"
					? [
							...new Set([
								...broadPlacements,
								...Array.from({ length: 71 }, (_, index) => 140 + index),
							]),
						]
					: broadPlacements;
			for (const position of placements) {
				const prefix = "обычная фраза "
					.repeat(Math.ceil((position + 1) / "обычная фраза ".length))
					.slice(0, position);
				const visible = `${prefix}${prefix ? " " : ""}${contact.value}, затем продолжение ответа.`;
				const tts = new FakeTts();
				const { orchestrator } = fixture({
					bookings,
					brain: new FakeBrain(speechScript(visible, turn2, generation2)),
					tts,
					initialState,
				});
				await collect(
					orchestrator.acceptTextSubmit({
						turnId: turn2,
						generationId: generation2,
						text: "Продолжайте.",
						knownFacts: facts,
					}),
				);
				expect(
					tts.inputs.filter((input) => input.text.includes(contactOnly)),
					`${contact.channel} at ${position}`,
				).toHaveLength(1);
				expect(tts.inputs.every((input) => [...input.text].length <= 240)).toBe(
					true,
				);
			}
		}
	});

	test("recording TTS preserves approved contacts across every model split", async () => {
		const approvedContacts = [
			{ channel: "email", value: "atomic.contact@example.com" },
			{ channel: "phone", value: "+79555678955" },
			{ channel: "telegram", value: "@Atomic_Sales" },
		] as const;
		const bookings = new FakeBookingService();
		await bookings.createBooking({
			...bookingInput,
			contacts: [...approvedContacts],
		});
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		for (const contact of approvedContacts) {
			const contactOnly = prepareSpeech(contact.value, {
				contactProcessing: true,
				approvedContacts: [contact],
			}).spokenText;
			for (let split = 1; split < contact.value.length; split += 1) {
				const prefix = "обычная вводная ".repeat(11);
				const brain = new FakeBrain([
					{
						type: "speech.delta",
						turnId: turn2,
						generationId: generation2,
						text: `${prefix}${contact.value.slice(0, split)}`,
					},
					{
						type: "speech.delta",
						turnId: turn2,
						generationId: generation2,
						text: `${contact.value.slice(split)}. Продолжение.`,
					},
					{ type: "turn.completed", turnId: turn2, generationId: generation2 },
				]);
				const tts = new FakeTts();
				const { orchestrator } = fixture({
					bookings,
					brain,
					tts,
					initialState: {
						...createInitialConversationState(),
						stage: "POST_BOOKING_QUALIFICATION",
						booking,
						contactConsentConfirmed: true,
						bookingConfirmationDelivered: true,
					},
				});
				await collect(
					orchestrator.acceptTextSubmit({
						turnId: turn2,
						generationId: generation2,
						text: "Продолжайте.",
						knownFacts: facts,
					}),
				);
				expect(
					tts.inputs.filter((input) => input.text.includes(contactOnly)),
					`${contact.channel} split ${split}`,
				).toHaveLength(1);
			}
		}
	});

	test("recording retry TTS keeps multiple approved contacts ordered and atomic", async () => {
		const approvedContacts = [
			{ channel: "email", value: "atomic.contact@example.com" },
			{ channel: "phone", value: "+79555678955" },
			{ channel: "telegram", value: "@Atomic_Sales" },
		] as const;
		const bookings = new FakeBookingService();
		await bookings.createBooking({
			...bookingInput,
			contacts: [...approvedContacts],
		});
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const visible = `${"вводная ".repeat(31)}${approvedContacts[0].value}; телефон ${approvedContacts[1].value}, Telegram ${approvedContacts[2].value}. ${"суффикс ".repeat(20)}`;
		const tts = new RetryTts();
		const { orchestrator } = fixture({
			bookings,
			brain: new FakeBrain(speechScript(visible, turn2, generation2)),
			tts,
			initialState: {
				...createInitialConversationState(),
				stage: "POST_BOOKING_QUALIFICATION",
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: true,
			},
		});
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn2,
				generationId: generation2,
				text: "Продолжайте.",
				knownFacts: facts,
			}),
		);
		const spokenContacts = approvedContacts.map(
			(contact) =>
				prepareSpeech(contact.value, {
					contactProcessing: true,
					approvedContacts: [contact],
				}).spokenText,
		);
		for (const spokenContact of spokenContacts) {
			expect(
				tts.inputs.filter((input) => input.text.includes(spokenContact)),
			).toHaveLength(1);
		}
		const providerText = tts.inputs.map((input) => input.text).join(" ");
		expect(
			spokenContacts.map((contact) => providerText.indexOf(contact)),
		).toEqual(
			[...spokenContacts]
				.map((contact) => providerText.indexOf(contact))
				.sort((left, right) => left - right),
		);
		expect(tts.inputs.every((input) => [...input.text].length <= 240)).toBe(
			true,
		);
		expect(tts.attempts).toBe(tts.inputs.length * 2);
	});

	test("actual TTS forwards only committed contacts and redacts an unknown model contact", async () => {
		const bookings = new FakeBookingService();
		await bookings.createBooking(bookingInput);
		const booking = await bookings.findByConversationId(conversationId);
		if (!booking) throw new Error("booking missing");
		const approvedEmail = booking.contacts.find(
			(contact) => contact.channel === "email",
		)?.value;
		if (!approvedEmail) throw new Error("approved email missing");
		const visible = `Контакты ${approvedEmail}, unknown@example.com и +7;999•123/45,67.`;
		const tts = new FakeTts();
		const brain = new FakeBrain(speechScript(visible, turn2, generation2));
		const { orchestrator } = fixture({
			bookings,
			brain,
			tts,
			initialState: {
				...createInitialConversationState(),
				stage: "POST_BOOKING_QUALIFICATION",
				booking,
				contactConsentConfirmed: true,
				bookingConfirmationDelivered: true,
			},
		});
		const events = await collect(
			orchestrator.acceptTextSubmit({
				turnId: turn2,
				generationId: generation2,
				text: "Продолжайте.",
				knownFacts: facts,
			}),
		);
		expect(events.find((event) => event.type === "text.done")).toMatchObject({
			text: visible,
		});
		const spoken = tts.inputs.map((input) => input.text).join(" ");
		expect(spoken).toContain("собака");
		expect(spoken).toContain("контакт скрыт");
		expect(spoken).not.toContain("unknown@example.com");
		expect(spoken).not.toMatch(/999|123\/45/u);
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
		expect(failing.inputs).toHaveLength(2);
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

	test("prefetch starts two complete phrases before the first settles and publishes in source order", async () => {
		const source =
			"Первый полезный ответ объясняет основной сценарий и следующий безопасный шаг. Второй полезный ответ уточняет детали и завершает объяснение.";
		const tts = new ControlledTts();
		const { orchestrator } = fixture({
			brain: new FakeBrain(speechScript(source)),
			tts,
			initialState: valueState(),
		});
		const events: OrchestratorEvent[] = [];
		const run = (async () => {
			for await (const event of orchestrator.acceptAudioCommit(commit())) {
				events.push(event);
			}
		})();

		await waitForTtsInputs(tts, 2);
		expect(tts.inputs).toHaveLength(2);
		expect(tts.inputs.every((request) => Object.isFrozen(request))).toBe(true);
		tts.succeed(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(events.some((event) => event.type === "audio.segment")).toBe(false);
		tts.succeed(0);
		await run;

		const audio = events.filter((event) => event.type === "audio.segment");
		expect(audio.map((event) => event.segmentId)).toEqual(
			tts.inputs.map((request) => request.segmentId),
		);
		expect(audio.map((event) => event.sequence)).toEqual([0, 1]);
		expect(new Set(tts.inputs.map((request) => request.segmentId)).size).toBe(
			2,
		);
		expect(tts.inputs.map((request) => request.text).join(" ")).toBe(source);
	});

	test("an ordered first-segment failure aborts and suppresses successful prefetched audio", async () => {
		const source =
			"Первый полезный ответ объясняет основной сценарий и следующий безопасный шаг. Второй полезный ответ уточняет детали и завершает объяснение.";
		const tts = new ControlledTts();
		const { orchestrator } = fixture({
			brain: new FakeBrain(speechScript(source)),
			tts,
			initialState: valueState(),
		});
		const events: OrchestratorEvent[] = [];
		const run = (async () => {
			for await (const event of orchestrator.acceptAudioCommit(commit())) {
				events.push(event);
			}
		})();
		await waitForTtsInputs(tts, 2);
		tts.fail(0);
		await run;

		expect(tts.inputs[1]?.signal.aborted).toBe(true);
		expect(events.filter((event) => event.type === "audio.segment")).toEqual(
			[],
		);
		expect(events.filter((event) => event.type === "degraded")).toHaveLength(1);
		tts.succeed(1);
		await Promise.resolve();
		expect(events.filter((event) => event.type === "audio.segment")).toEqual(
			[],
		);
	});

	test("an ordered second-segment failure keeps only the first audio event", async () => {
		const source =
			"Первый полезный ответ объясняет основной сценарий и следующий безопасный шаг. Второй полезный ответ уточняет детали и завершает объяснение.";
		const tts = new ControlledTts();
		const { orchestrator } = fixture({
			brain: new FakeBrain(speechScript(source)),
			tts,
			initialState: valueState(),
		});
		const events: OrchestratorEvent[] = [];
		const run = (async () => {
			for await (const event of orchestrator.acceptAudioCommit(commit())) {
				events.push(event);
			}
		})();
		await waitForTtsInputs(tts, 2);
		tts.fail(1);
		tts.succeed(0);
		await run;

		const audioIndex = events.findIndex(
			(event) => event.type === "audio.segment",
		);
		const degradedIndex = events.findIndex(
			(event) => event.type === "degraded",
		);
		expect(audioIndex).toBeGreaterThanOrEqual(0);
		expect(degradedIndex).toBeGreaterThan(audioIndex);
		expect(
			events.filter((event) => event.type === "audio.segment"),
		).toHaveLength(1);
		expect(events.filter((event) => event.type === "degraded")).toHaveLength(1);
	});

	test("barge-in aborts both prefetched requests and suppresses every late result", async () => {
		const source =
			"Первый полезный ответ объясняет основной сценарий и следующий безопасный шаг. Второй полезный ответ уточняет детали и завершает объяснение.";
		const tts = new ControlledTts();
		const { orchestrator } = fixture({
			brain: new FakeBrain(speechScript(source)),
			tts,
			initialState: valueState(),
		});
		const events: OrchestratorEvent[] = [];
		const run = (async () => {
			for await (const event of orchestrator.acceptAudioCommit(commit())) {
				events.push(event);
			}
		})();
		await waitForTtsInputs(tts, 2);
		await orchestrator.interrupt(generation1);
		expect(tts.inputs.every((request) => request.signal.aborted)).toBe(true);
		tts.succeed(1);
		tts.succeed(0);
		await run;
		expect(events.some((event) => event.type === "audio.segment")).toBe(false);
		expectNoTerminalCompletion(events);
	});

	test("prefetched provider-owned retries retain text and IDs while budgets charge once", async () => {
		const source =
			"Первый полезный ответ объясняет основной сценарий и следующий безопасный шаг. Второй полезный ответ уточняет детали и завершает объяснение.";
		const tts = new RetryTts();
		const { orchestrator } = fixture({
			brain: new FakeBrain(speechScript(source)),
			tts,
			initialState: valueState(),
			speechBudgets: {
				maxCharsPerSegment: 100,
				maxCharsPerTurn: 145,
				maxCharsPerSession: 300,
			},
		});
		const events = await collect(orchestrator.acceptAudioCommit(commit()));
		expect(tts.inputs.map((request) => request.text).join(" ")).toBe(source);
		expect(tts.inputs).toHaveLength(2);
		expect(tts.attempts).toBe(4);
		expect(new Set(tts.inputs.map((request) => request.segmentId)).size).toBe(
			2,
		);
		expect(
			events.filter((event) => event.type === "audio.segment"),
		).toHaveLength(2);
		expect(events.some((event) => event.type === "degraded")).toBe(false);
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
		expectNoTerminalCompletion(seen);
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
		expectNoTerminalCompletion([
			...(late.done ? [] : [late.value]),
			...remaining,
		]);
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
