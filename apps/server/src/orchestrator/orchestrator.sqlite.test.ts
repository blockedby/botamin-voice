import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BrainDelta,
	ClientWsEventSchema,
	type CreateBookingInput,
	type InternalBookingDraft,
	PLAYBACK_FLOW_MAX_BYTES,
	PLAYBACK_FLOW_MAX_SEGMENT_BYTES,
	PLAYBACK_FLOW_MAX_SEGMENTS,
	ServerWsEventSchema,
	VOICE_WS_PROTOCOL_VERSION,
} from "@botamin/contracts";
import { count } from "drizzle-orm";
import {
	createTestBookingContacts,
	FakeBrain,
	FakeStt,
	FakeTts,
} from "../../../../packages/test-fixtures/src";
import { ConversationStore } from "../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../db/database";
import { bookings, domainEvents, notificationOutbox } from "../db/schema";
import { SqliteBookingService } from "../domain/booking";
import { generateCandidateMeetingSlots } from "../domain/booking/support";
import { SqliteBookingDraftStore } from "../domain/booking-draft/store";
import { GatewaySession, type GatewaySocket } from "../gateway/session";
import type { NamedLeadNotifier } from "../notifiers/notifier";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "./orchestrator";
import { createInitialConversationState } from "./state";

const directories: string[] = [];
const promptVersion = "b".repeat(64);
const timestamp = "2026-07-30T20:22:00.000Z";

class FailingNotifier implements NamedLeadNotifier {
	readonly kind = "timeline-test";
	attempts = 0;
	async publish(): Promise<void> {
		this.attempts += 1;
		throw new Error("private notifier transport failure");
	}
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function collect(
	iterable: AsyncIterable<OrchestratorEvent>,
): Promise<OrchestratorEvent[]> {
	const events: OrchestratorEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

function protocolAccept(conversationId: string): string {
	return JSON.stringify(
		ClientWsEventSchema.parse({
			v: 1,
			type: "client.protocol.accept",
			conversationId,
			at: timestamp,
			payload: {
				version: VOICE_WS_PROTOCOL_VERSION,
				capabilities: { localReactions: null },
				playback: {
					maxBufferedSegments: PLAYBACK_FLOW_MAX_SEGMENTS,
					maxBufferedBytes: PLAYBACK_FLOW_MAX_BYTES,
					maxSegmentBytes: PLAYBACK_FLOW_MAX_SEGMENT_BYTES,
				},
			},
		}),
	);
}

class TestSocket implements GatewaySocket {
	readonly sent: Array<string | Uint8Array> = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];

	send(data: string | Uint8Array): void {
		this.sent.push(typeof data === "string" ? data : data.slice());
	}

	close(code?: number, reason?: string): void {
		this.closes.push({
			...(code === undefined ? {} : { code }),
			...(reason === undefined ? {} : { reason }),
		});
	}

	events() {
		return this.sent
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => ServerWsEventSchema.parse(JSON.parse(entry)));
	}
}

function acceptedConflictOption(
	draft: InternalBookingDraft,
	field: "name" | "company",
	value: string,
): string {
	const fact = draft.factRegistry.facts[field];
	if (fact.status !== "conflicted") throw new Error("expected conflict");
	const option = fact.conflictOptions.find(
		(candidate) => candidate.value === value,
	);
	if (!option) throw new Error("expected conflict option");
	return option.optionId;
}

describe("orchestrator with durable SQLite booking service", () => {
	test("DB/event/outbox commit survives notifier and TTS-independent confirmation timeline", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-orchestrator-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		const turnId = Bun.randomUUIDv7();
		const generationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion,
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: timestamp,
			startedAt: timestamp,
		});
		const input: CreateBookingInput = {
			conversationId,
			idempotencyKey: "sqlite-orchestrator-create-01",
			name: "Мария",
			contacts: createTestBookingContacts(),
			company: "Private Example LLC",
			meetingSlot: generateCandidateMeetingSlots(new Date(timestamp))[0],
			consentConfirmed: true,
		};
		const script: BrainDelta[] = [
			{
				type: "tool.request",
				turnId,
				generationId,
				tool: {
					name: "create_booking",
					callId: "sqlite-create-call",
					args: input,
				},
			},
			{ type: "turn.completed", turnId, generationId },
		];
		const notifier = new FailingNotifier();
		const service = new SqliteBookingService(database, {
			notifier,
			now: () => new Date(timestamp),
		});
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion,
			stt: new FakeStt({ text: "Сохраните мой контакт" }),
			brain: new FakeBrain(script),
			bookings: service,
			tts: new FakeTts(),
			initialState: {
				...createInitialConversationState(),
				stage: "COLLECT_BOOKING",
				contactConsentConfirmed: true,
			},
		});

		const events = await collect(
			orchestrator.acceptAudioCommit({
				turnId,
				generationId,
				audio: new Uint8Array([82, 73, 70, 70]),
				contentType: "audio/wav",
				knownFacts: { useCases: [], painPoints: [], objections: [] },
			}),
		);
		const types = events.map((event) => event.type);
		expect(types.indexOf("booking.committed")).toBeLessThan(
			types.indexOf("text.delta"),
		);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
		expect(
			database.select({ value: count() }).from(notificationOutbox).get()?.value,
		).toBe(1);
		expect(notifier.attempts).toBe(1);
		expect(orchestrator.state.booking?.status).toBe("booked");
		expect(JSON.stringify(events)).not.toContain(
			"private notifier transport failure",
		);
		closeDomainDatabase(database);
	});

	test("deterministic draft facts, conflict resolution, server commit, qualification, and replay", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-rc4-orchestrator-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion,
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: timestamp,
			startedAt: timestamp,
		});
		const service = new SqliteBookingService(database, {
			now: () => new Date(timestamp),
		});
		const draftStore = new SqliteBookingDraftStore(database, {
			now: () => new Date(timestamp),
		});
		const slots = await service.candidateMeetingSlots();
		draftStore.initialize(conversationId, slots);
		const tts = new FakeTts();
		const brain = new FakeBrain();
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion,
			stt: new FakeStt(),
			brain,
			bookings: service,
			draftStore,
			tts,
			now: () => new Date(timestamp),
			initialState: {
				...createInitialConversationState(),
				stage: "COLLECT_BOOKING",
				contactConsentConfirmed: true,
			},
		});
		const knownFacts = { useCases: [], painPoints: [], objections: [] };
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				text: "В нашей команде продаж около 10 человек.",
				knownFacts,
			}),
		);
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				text: "Меня зовут Алексей Петров, компания Ромашка.",
				knownFacts,
			}),
		);
		let draft = draftStore.load(conversationId);
		if (!draft) throw new Error("draft missing");
		const formRequestId = Bun.randomUUIDv7();
		draft = draftStore.applyForm(conversationId, {
			requestId: formRequestId,
			baseRevision: draft.revision,
			details: {
				name: "Петров",
				workEmail: "RosSelGosTorg@gmail.com",
				phone: "+79555678955",
			},
			selectedCandidateId: draft.candidates[0].candidateId,
		});
		expect(draft.factRegistry.facts.name.status).toBe("conflicted");
		const resolutionRequestId = Bun.randomUUIDv7();
		draft = draftStore.resolveConflict(conversationId, {
			requestId: resolutionRequestId,
			baseRevision: draft.revision,
			field: "name",
			conflictOptionId: acceptedConflictOption(draft, "name", "Алексей Петров"),
		});
		expect(draft.readiness).toBe("ready");
		expect(draftStore.acceptedFacts(conversationId)).toMatchObject({
			name: "Алексей Петров",
			company: "Ромашка",
			workEmail: "RosSelGosTorg@gmail.com",
			phone: "+79555678955",
			salesManagerCount: 10,
		});
		const confirmation = {
			requestId: Bun.randomUUIDv7(),
			revision: draft.revision,
		};
		const committedEvents = await collect(
			orchestrator.confirmBookingDraft({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				confirmation,
			}),
		);
		const eventTypes = committedEvents.map((event) => event.type);
		expect(eventTypes.indexOf("booking.committed")).toBeLessThan(
			eventTypes.indexOf("text.delta"),
		);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(draftStore.load(conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: orchestrator.state.booking?.id,
		});
		expect(orchestrator.state).toMatchObject({
			stage: "POST_BOOKING_QUALIFICATION",
			booking: {
				qualificationStatus: "partial",
				qualification: { salesManagerCount: 10 },
			},
		});
		const visible = committedEvents
			.filter((event) => event.type === "text.delta")
			.map((event) => event.text)
			.join(" ");
		expect(visible).toContain("Алексей Петров");
		expect(visible).toContain("Ромашка");
		expect(visible).toContain("RosSelGosTorg@gmail.com");
		expect(visible).toContain("+79555678955");
		expect(visible).toContain("Сколько заявок вы получаете за месяц?");
		expect(visible).not.toContain(
			"Сколько менеджеров по продажам работает в вашей команде?",
		);
		expect(visible).toContain(
			"Внешнее календарное событие и приглашение не создавались",
		);
		expect(tts.inputs.map((request) => request.text).join(" ")).toContain(
			"собака gmail точка com",
		);
		const callsBeforeReplay = database
			.select({ value: count() })
			.from(bookings)
			.get()?.value;
		const replay = await collect(
			orchestrator.confirmBookingDraft({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				confirmation,
			}),
		);
		expect(replay.map((event) => event.type)).toEqual([
			"booking.draft.updated",
		]);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(callsBeforeReplay);
		const brainTurnsBeforeAlreadyAnswered = brain.turns.length;
		const alreadyAnswered = await collect(
			orchestrator.acceptTextSubmit({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				text: "Я уже отвечал",
				knownFacts,
			}),
		);
		const alreadyAnsweredText = alreadyAnswered
			.filter((event) => event.type === "text.delta")
			.map((event) => event.text)
			.join(" ");
		expect(alreadyAnsweredText).toContain(
			"Сколько заявок вы получаете за месяц?",
		);
		expect(alreadyAnsweredText).not.toContain(
			"Сколько менеджеров по продажам работает в вашей команде?",
		);
		expect(brain.turns).toHaveLength(brainTurnsBeforeAlreadyAnswered);
		const basisQuestion = await collect(
			orchestrator.acceptTextSubmit({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				text: "10 лидов в день",
				knownFacts,
			}),
		);
		expect(
			basisQuestion.find((event) => event.type === "text.delta"),
		).toMatchObject({ text: "Это по рабочим или календарным дням?" });
		await collect(
			orchestrator.acceptTextSubmit({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				text: "По рабочим дням",
				knownFacts,
			}),
		);
		expect(orchestrator.state).toMatchObject({
			stage: "COMPLETE",
			booking: {
				qualificationStatus: "complete",
				qualification: {
					monthlyLeadVolume: "220 в месяц",
					salesManagerCount: 10,
				},
			},
		});
		expect(
			draftStore.load(conversationId)?.factRegistry.facts.monthlyLeadVolume,
		).toMatchObject({
			status: "accepted",
			provenance: { source: "server_derivation" },
		});
		closeDomainDatabase(database);
	});

	test("gateway publishes booking and meeting widgets only after typed voice-parity confirmation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-rc4-typed-gateway-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "CONNECTING",
			promptVersion,
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: false,
			consentAt: timestamp,
			startedAt: timestamp,
		});
		const service = new SqliteBookingService(database, {
			now: () => new Date(timestamp),
		});
		const draftStore = new SqliteBookingDraftStore(database, {
			now: () => new Date(timestamp),
		});
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion,
			stt: new FakeStt(),
			brain: new FakeBrain(),
			bookings: service,
			draftStore,
			tts: new FakeTts(),
			now: () => new Date(timestamp),
			initialState: {
				...createInitialConversationState({ qualificationEnabled: false }),
				contactConsentConfirmed: true,
			},
		});
		const session = new GatewaySession({
			conversationId,
			expiresAt: new Date("2027-01-01T00:00:00.000Z"),
			orchestrator,
			bookings: service,
			draftStore,
			persistence: {
				appendTurn: () => undefined,
				setConversationActive: () => undefined,
				updateConversationStage: () => undefined,
				failConversation: () => undefined,
				stopConversation: () => undefined,
			},
			brainModel: "fake-luna",
			maxUtteranceMs: 60_000,
			maxAudioBytes: 2_000_000,
			outputContentType: "audio/mpeg",
			maxFrameBytes: 3_209,
			maxJsonBytes: 8_192,
			maxHistoryEvents: 128,
			maxHistoryBytes: 5_000_000,
			acquireTurn: async () => ({ ok: true, release: () => undefined }),
			tokenFactory: () => "initial-typed-client-token-0000000000",
			now: () => new Date(timestamp),
		});
		expect(orchestrator.apply({ type: "connected" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "discovery_requested" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "value_ready" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_offered" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_accepted" }).ok).toBe(true);
		const socket = new TestSocket();
		session.attach(socket, VOICE_WS_PROTOCOL_VERSION);
		await session.receive(
			socket,
			JSON.stringify(
				ClientWsEventSchema.parse({
					v: 1,
					type: "client.hello",
					conversationId,
					at: timestamp,
					payload: {
						resumeToken: session.takeClientToken(),
						audio: {
							encoding: "pcm16le",
							sampleRate: 16_000,
							channels: 1,
							chunkMs: 100,
						},
					},
				}),
			),
		);
		await session.receive(socket, protocolAccept(conversationId));
		const textEvent = (sequence: number, text: string) =>
			JSON.stringify(
				ClientWsEventSchema.parse({
					v: 1,
					type: "visitor.text.submit",
					conversationId,
					at: timestamp,
					payload: { sequence, text },
				}),
			);
		const released = new Set<string>();
		const drainWithPlayback = async () => {
			for (let attempt = 0; attempt < 500; attempt += 1) {
				const pending = socket
					.events()
					.filter((event) => event.type === "audio.segment")
					.filter((event) => !released.has(event.payload.segmentId));
				for (const event of pending) {
					released.add(event.payload.segmentId);
					await session.receive(
						socket,
						JSON.stringify({
							v: 1,
							type: "playback.segment.released",
							conversationId,
							at: timestamp,
							payload: {
								generationId: event.payload.generationId,
								segmentId: event.payload.segmentId,
								sequence: event.payload.sequence,
								byteLength: event.payload.byteLength,
							},
						}),
					);
				}
				if (!session.processing && pending.length === 0) break;
				await Bun.sleep(1);
			}
			await session.drain();
		};
		await session.receive(
			socket,
			textEvent(
				0,
				"Меня зовут Алексей Петров, компания Ромашка. Почта alex.petrov@example.com, телефон +7 955 567-89-55. Первый вариант.",
			),
		);
		await drainWithPlayback();
		expect(
			socket.events().filter((event) => event.type === "booking.created"),
		).toHaveLength(0);
		expect(draftStore.load(conversationId)?.readiness).toBe("ready");
		await session.receive(socket, textEvent(1, "да, подтверждаю"));
		await drainWithPlayback();
		const events = socket.events();
		expect(
			events.filter((event) => event.type === "booking.created"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "internal.meeting.updated"),
		).toHaveLength(1);
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		await session.stop();
		closeDomainDatabase(database);
	});

	test("gateway correlates strict draft commands and replays one durable meeting", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-rc4-gateway-"));
		directories.push(directory);
		const database = openDomainDatabase({
			filename: join(directory, "domain.db"),
		});
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "CONNECTING",
			promptVersion,
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: timestamp,
			startedAt: timestamp,
		});
		const service = new SqliteBookingService(database, {
			now: () => new Date(timestamp),
		});
		const draftStore = new SqliteBookingDraftStore(database, {
			now: () => new Date(timestamp),
		});
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion,
			stt: new FakeStt(),
			brain: new FakeBrain(),
			bookings: service,
			draftStore,
			tts: new FakeTts(),
			now: () => new Date(timestamp),
			initialState: {
				...createInitialConversationState(),
				contactConsentConfirmed: true,
			},
		});
		const session = new GatewaySession({
			conversationId,
			expiresAt: new Date("2027-01-01T00:00:00.000Z"),
			orchestrator,
			bookings: service,
			draftStore,
			persistence: {
				appendTurn: () => undefined,
				setConversationActive: () => undefined,
				updateConversationStage: () => undefined,
				failConversation: () => undefined,
				stopConversation: () => undefined,
			},
			brainModel: "fake-luna",
			maxUtteranceMs: 60_000,
			maxAudioBytes: 2_000_000,
			outputContentType: "audio/mpeg",
			maxFrameBytes: 3_209,
			maxJsonBytes: 8_192,
			maxHistoryEvents: 128,
			maxHistoryBytes: 5_000_000,
			acquireTurn: async () => ({ ok: true, release: () => undefined }),
			tokenFactory: () => "initial-rc4-client-token-000000000000",
			now: () => new Date(timestamp),
		});
		expect(orchestrator.apply({ type: "connected" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "discovery_requested" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "value_ready" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_offered" }).ok).toBe(true);
		expect(orchestrator.apply({ type: "booking_accepted" }).ok).toBe(true);
		const socket = new TestSocket();
		session.attach(socket, VOICE_WS_PROTOCOL_VERSION);
		await session.receive(
			socket,
			JSON.stringify(
				ClientWsEventSchema.parse({
					v: 1,
					type: "client.hello",
					conversationId,
					at: timestamp,
					payload: {
						resumeToken: session.takeClientToken(),
						audio: {
							encoding: "pcm16le",
							sampleRate: 16_000,
							channels: 1,
							chunkMs: 100,
						},
					},
				}),
			),
		);
		await session.receive(socket, protocolAccept(conversationId));
		let draft = draftStore.load(conversationId);
		if (!draft) throw new Error("gateway draft missing");
		const bookingEvent = (type: string, payload: unknown) =>
			JSON.stringify(
				ClientWsEventSchema.parse({
					v: 1,
					type,
					at: timestamp,
					payload,
				}),
			);
		const staleRequestId = Bun.randomUUIDv7();
		await session.receive(
			socket,
			bookingEvent("booking.form.submit", {
				requestId: staleRequestId,
				baseRevision: draft.revision + 1,
				details: { name: "Старое значение" },
			}),
		);
		const staleCandidateRequestId = Bun.randomUUIDv7();
		await session.receive(
			socket,
			bookingEvent("booking.form.submit", {
				requestId: staleCandidateRequestId,
				baseRevision: draft.revision,
				details: {},
				selectedCandidateId: Bun.randomUUIDv7(),
			}),
		);
		const form = {
			requestId: Bun.randomUUIDv7(),
			baseRevision: draft.revision,
			details: {
				name: "Алексей Петров",
				company: "Ромашка",
				workEmail: "alex.petrov@gmail.com",
				phone: "+79555678955",
			},
			selectedCandidateId: draft.candidates[0].candidateId,
		};
		await session.receive(socket, bookingEvent("booking.form.submit", form));
		await session.receive(socket, bookingEvent("booking.form.submit", form));
		draft = draftStore.load(conversationId);
		if (!draft) throw new Error("updated gateway draft missing");
		const confirmation = {
			requestId: Bun.randomUUIDv7(),
			revision: draft.revision,
		};
		await session.receive(
			socket,
			bookingEvent("booking.draft.confirm", confirmation),
		);
		await session.receive(
			socket,
			bookingEvent("booking.draft.confirm", confirmation),
		);
		const events = socket.events();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "booking.form.rejected",
				payload: expect.objectContaining({
					requestId: staleRequestId,
					error: expect.objectContaining({ code: "INVALID_REVISION" }),
				}),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "booking.form.rejected",
				payload: expect.objectContaining({
					requestId: staleCandidateRequestId,
					error: expect.objectContaining({ code: "CANDIDATE_MISMATCH" }),
				}),
			}),
		);
		expect(
			events.filter((event) => event.type === "booking.created"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "internal.meeting.updated"),
		).not.toHaveLength(0);
		expect(
			events.find(
				(event) =>
					event.type === "booking.draft.updated" &&
					event.payload.requestId === form.requestId,
			),
		).toBeDefined();
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		const ready = events.find((event) => event.type === "session.ready");
		if (ready?.type !== "session.ready") {
			throw new Error("session.ready missing");
		}
		session.detach(socket);
		await session.drain();
		const resumed = new TestSocket();
		session.attach(resumed, VOICE_WS_PROTOCOL_VERSION);
		await session.receive(
			resumed,
			JSON.stringify(
				ClientWsEventSchema.parse({
					v: 1,
					type: "client.hello",
					conversationId,
					at: timestamp,
					payload: {
						resumeToken: ready.payload.resumeToken,
						audio: {
							encoding: "pcm16le",
							sampleRate: 16_000,
							channels: 1,
							chunkMs: 100,
						},
					},
				}),
			),
		);
		await session.receive(resumed, protocolAccept(conversationId));
		const resumedReady = resumed
			.events()
			.filter((event) => event.type === "session.ready")
			.at(-1);
		expect(resumedReady).toMatchObject({
			payload: {
				bookingDraft: { commitStatus: "committed" },
				internalMeeting: {
					kind: "internal_virtual",
					externalCalendarEventCreated: false,
					externalInviteSent: false,
				},
			},
		});
		expect(
			database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		await session.stop();
		closeDomainDatabase(database);
	});
});
