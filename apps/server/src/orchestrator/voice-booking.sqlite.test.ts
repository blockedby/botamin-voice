import { afterEach, describe, expect, test } from "bun:test";
import type {
	BookingService,
	MeetingSlot,
	SttPort,
	SttTranscriptionRequest,
} from "@botamin/contracts";
import { count } from "drizzle-orm";
import { FakeBrain, FakeTts } from "../../../../packages/test-fixtures/src";
import { ConversationStore } from "../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../db/database";
import { bookings } from "../db/schema";
import { SqliteBookingService } from "../domain/booking";
import { generateCandidateMeetingSlots } from "../domain/booking/support";
import { SqliteBookingDraftStore } from "../domain/booking-draft/store";
import {
	ConversationOrchestrator,
	type OrchestratorEvent,
} from "./orchestrator";
import { createInitialConversationState } from "./state";

const promptVersion = "c".repeat(64);
const instant = "2026-07-30T12:00:00.000Z";
const knownFacts = { useCases: [], painPoints: [], objections: [] };
const completeDetails = {
	name: "Алексей Петров",
	company: "Ромашка",
	workEmail: "alex.petrov@example.com",
	phone: "+79555678955",
};
const fullTurn =
	"Меня зовут Алексей Петров, компания Ромашка. Рабочая почта alex.petrov@example.com, телефон +7 955 567-89-55.";

const databases: ReturnType<typeof openDomainDatabase>[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) closeDomainDatabase(database);
});

async function collect(
	iterable: AsyncIterable<OrchestratorEvent>,
): Promise<OrchestratorEvent[]> {
	const events: OrchestratorEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

class QueueStt implements SttPort {
	readonly requests: SttTranscriptionRequest[] = [];
	constructor(private readonly texts: string[]) {}

	async transcribe(request: SttTranscriptionRequest) {
		this.requests.push(request);
		const text = this.texts.shift();
		if (!text) throw new Error("missing deterministic transcript");
		return {
			conversationId: request.conversationId,
			turnId: request.turnId,
			text,
			final: true as const,
		};
	}

	async health() {
		return "ready" as const;
	}
}

function shiftedSlot(slot: MeetingSlot, days: number): MeetingSlot {
	const shift = days * 86_400_000;
	return {
		...slot,
		startAt: new Date(new Date(slot.startAt).getTime() + shift).toISOString(),
		endAt: new Date(new Date(slot.endAt).getTime() + shift).toISOString(),
	};
}

function setup(options: {
	stt?: SttPort;
	initialSlots?: [MeetingSlot, MeetingSlot];
	currentSlots?: [MeetingSlot, MeetingSlot];
}) {
	const database = openDomainDatabase({ filename: ":memory:" });
	databases.push(database);
	const conversationId = Bun.randomUUIDv7();
	new ConversationStore(database).create({
		id: conversationId,
		stage: "COLLECT_BOOKING",
		promptVersion,
		source: "landing",
		locale: "ru-RU",
		qualificationEnabled: false,
		consentAt: instant,
		startedAt: instant,
	});
	const delegate = new SqliteBookingService(database, {
		now: () => new Date(instant),
	});
	const bookingsService: BookingService = options.currentSlots
		? {
				candidateMeetingSlots: async () =>
					options.currentSlots as [MeetingSlot, MeetingSlot],
				createBooking: (input) => delegate.createBooking(input),
				appendQualification: (input) => delegate.appendQualification(input),
				findByConversationId: (id) => delegate.findByConversationId(id),
			}
		: delegate;
	const draftStore = new SqliteBookingDraftStore(database, {
		now: () => new Date(instant),
	});
	const initialSlots =
		options.initialSlots ?? generateCandidateMeetingSlots(new Date(instant));
	draftStore.initialize(conversationId, initialSlots);
	const tts = new FakeTts();
	const brain = new FakeBrain();
	const orchestrator = new ConversationOrchestrator({
		conversationId,
		promptVersion,
		stt: options.stt ?? new QueueStt([]),
		brain,
		bookings: bookingsService,
		draftStore,
		tts,
		now: () => new Date(instant),
		initialState: {
			...createInitialConversationState({ qualificationEnabled: false }),
			stage: "COLLECT_BOOKING",
			contactConsentConfirmed: true,
		},
	});
	return {
		database,
		conversationId,
		draftStore,
		tts,
		brain,
		orchestrator,
		initialSlots,
	};
}

function typed(
	orchestrator: ConversationOrchestrator,
	text: string,
): AsyncIterable<OrchestratorEvent> {
	return orchestrator.acceptTextSubmit({
		turnId: Bun.randomUUIDv7(),
		generationId: Bun.randomUUIDv7(),
		text,
		knownFacts,
	});
}

function spoken(
	orchestrator: ConversationOrchestrator,
): AsyncIterable<OrchestratorEvent> {
	return orchestrator.acceptAudioCommit({
		turnId: Bun.randomUUIDv7(),
		generationId: Bun.randomUUIDv7(),
		audio: new Uint8Array([82, 73, 70, 70]),
		contentType: "audio/wav",
		knownFacts,
	});
}

function preloadReadyFacts(
	harness: ReturnType<typeof setup>,
	selectedCandidateId?: string,
) {
	const draft = harness.draftStore.load(harness.conversationId);
	if (!draft) throw new Error("draft missing");
	return harness.draftStore.applyForm(harness.conversationId, {
		requestId: Bun.randomUUIDv7(),
		baseRevision: draft.revision,
		details: completeDetails,
		...(selectedCandidateId ? { selectedCandidateId } : {}),
	});
}

function assistantText(events: readonly OrchestratorEvent[]): string {
	return events
		.filter((event) => event.type === "text.delta")
		.map((event) => event.text)
		.join(" ");
}

describe("typed and spoken server-owned draft completion", () => {
	test("typed facts plus first choice wait for explicit confirmation and commit once", async () => {
		const harness = setup({});
		const proposed = await collect(
			typed(harness.orchestrator, `${fullTurn} Первый вариант.`),
		);
		const ready = harness.draftStore.load(harness.conversationId);
		expect(ready).toMatchObject({
			readiness: "ready",
			selectedCandidate: {
				candidateId: ready?.candidates[0].candidateId,
			},
		});
		expect(assistantText(proposed)).toContain("Подтвердите, пожалуйста");
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(0);
		const confirmationSpeech = harness.tts.inputs
			.map((request) => request.text)
			.join(" ");
		expect(confirmationSpeech).toContain("alex точка petrov");
		expect(confirmationSpeech).toContain("собака example точка com");
		expect(confirmationSpeech).toContain("плюс семь");
		expect(confirmationSpeech).toContain("восемьдесят девять, пятьдесят пять");

		const committed = await collect(
			typed(harness.orchestrator, "да, подтверждаю"),
		);
		expect(committed.some((event) => event.type === "booking.committed")).toBe(
			true,
		);
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		await collect(typed(harness.orchestrator, "да, подтверждаю"));
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(harness.brain.turns).toHaveLength(0);
	});

	test("spoken facts plus second choice use the same exact-revision commit path", async () => {
		const stt = new QueueStt([
			`${fullTurn} Второй вариант.`,
			"Всё верно, записывайте",
		]);
		const harness = setup({ stt });
		const proposed = await collect(spoken(harness.orchestrator));
		const ready = harness.draftStore.load(harness.conversationId);
		expect(ready?.selectedCandidate?.candidateId).toBe(
			ready?.candidates[1].candidateId,
		);
		expect(assistantText(proposed)).toContain("Всё верно?");
		const committed = await collect(spoken(harness.orchestrator));
		expect(committed.some((event) => event.type === "booking.committed")).toBe(
			true,
		);
		expect(stt.requests).toHaveLength(2);
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(harness.brain.turns).toHaveLength(0);
	});

	test("exact time selects the unique current candidate while ambiguity stays unset", async () => {
		const exact = setup({});
		preloadReadyFacts(exact);
		await collect(typed(exact.orchestrator, "Выбираю 16:00"));
		const selected = exact.draftStore.load(exact.conversationId);
		expect(selected?.selectedCandidate?.candidateId).toBe(
			selected?.candidates[1].candidateId,
		);

		const base = generateCandidateMeetingSlots(new Date(instant));
		const ambiguousSlots: [MeetingSlot, MeetingSlot] = [
			base[0],
			shiftedSlot(base[0], 3),
		];
		const ambiguous = setup({
			initialSlots: ambiguousSlots,
			currentSlots: ambiguousSlots,
		});
		preloadReadyFacts(ambiguous);
		const events = await collect(
			typed(ambiguous.orchestrator, "Выбираю 09:00"),
		);
		expect(
			ambiguous.draftStore.load(ambiguous.conversationId)?.selectedCandidate,
		).toBeNull();
		expect(assistantText(events)).toContain("однозначно");
		expect(ambiguous.brain.turns).toHaveLength(0);
	});

	test("candidate refresh rejects a stale exact time instead of selecting a replacement", async () => {
		const oldSlots = generateCandidateMeetingSlots(new Date(instant));
		const refreshedSlots: [MeetingSlot, MeetingSlot] = [
			{
				...oldSlots[0],
				startAt: new Date(
					new Date(oldSlots[0].startAt).getTime() + 20 * 60_000,
				).toISOString(),
				endAt: new Date(
					new Date(oldSlots[0].endAt).getTime() + 20 * 60_000,
				).toISOString(),
			},
			oldSlots[1],
		];
		const harness = setup({
			initialSlots: oldSlots,
			currentSlots: refreshedSlots,
		});
		preloadReadyFacts(harness);
		const events = await collect(typed(harness.orchestrator, "Выбираю 09:00"));
		const draft = harness.draftStore.load(harness.conversationId);
		expect(draft?.selectedCandidate).toBeNull();
		expect(draft?.candidates.map((candidate) => candidate.meetingSlot)).toEqual(
			refreshedSlots,
		);
		expect(assistantText(events)).toContain("нет среди текущих вариантов");
	});

	test("generic yes needs pending server confirmation and mutation invalidates it", async () => {
		const harness = setup({});
		const draft = harness.draftStore.load(harness.conversationId);
		if (!draft) throw new Error("draft missing");
		const ready = preloadReadyFacts(harness, draft.candidates[0].candidateId);
		const firstYes = await collect(typed(harness.orchestrator, "да"));
		expect(firstYes.some((event) => event.type === "booking.committed")).toBe(
			false,
		);
		expect(assistantText(firstYes)).toContain("Подтвердите, пожалуйста");

		harness.draftStore.applyForm(harness.conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: ready.revision,
			details: { company: "Другая компания" },
		});
		const staleYes = await collect(typed(harness.orchestrator, "да"));
		expect(staleYes.some((event) => event.type === "booking.committed")).toBe(
			false,
		);
		expect(assistantText(staleYes)).toContain("изменились");
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(0);
	});

	test("refusal, interruption, and reconnect clear pending confirmation without committing", async () => {
		const refusal = setup({});
		const refusalDraft = refusal.draftStore.load(refusal.conversationId);
		if (!refusalDraft) throw new Error("draft missing");
		preloadReadyFacts(refusal, refusalDraft.candidates[0].candidateId);
		await collect(typed(refusal.orchestrator, "да"));
		const declined = await collect(
			typed(refusal.orchestrator, "нет, не подтверждаю"),
		);
		expect(assistantText(declined)).toContain("встречу не сохраняю");
		expect(
			refusal.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(0);

		const interrupted = setup({});
		const interruptedDraft = interrupted.draftStore.load(
			interrupted.conversationId,
		);
		if (!interruptedDraft) throw new Error("draft missing");
		preloadReadyFacts(interrupted, interruptedDraft.candidates[0].candidateId);
		const presented = await collect(typed(interrupted.orchestrator, "да"));
		const presentedGeneration = presented.find(
			(event) => event.type === "text.delta",
		)?.generationId;
		if (!presentedGeneration)
			throw new Error("confirmation generation missing");
		await interrupted.orchestrator.interrupt(presentedGeneration);
		const afterInterruption = await collect(
			typed(interrupted.orchestrator, "да"),
		);
		expect(
			afterInterruption.some((event) => event.type === "booking.committed"),
		).toBe(false);
		expect(assistantText(afterInterruption)).toContain(
			"Подтвердите, пожалуйста",
		);

		const reconnect = setup({});
		const reconnectDraft = reconnect.draftStore.load(reconnect.conversationId);
		if (!reconnectDraft) throw new Error("draft missing");
		preloadReadyFacts(reconnect, reconnectDraft.candidates[0].candidateId);
		await collect(typed(reconnect.orchestrator, "да"));
		await reconnect.orchestrator.disconnect();
		expect(reconnect.orchestrator.apply({ type: "reconnect" }).ok).toBe(true);
		const afterReconnect = await collect(typed(reconnect.orchestrator, "да"));
		expect(
			afterReconnect.some((event) => event.type === "booking.committed"),
		).toBe(false);
		expect(assistantText(afterReconnect)).toContain("Подтвердите, пожалуйста");
	});
});
