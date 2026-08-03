import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BookingService,
	MeetingSlot,
	SttPort,
	SttTranscriptionRequest,
	TtsPort,
} from "@botamin/contracts";
import { count } from "drizzle-orm";
import { FakeBrain, FakeTts } from "../../../../packages/test-fixtures/src";
import { ConversationStore } from "../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../db/database";
import {
	bookings,
	conversationContexts,
	domainEvents,
	notificationOutbox,
} from "../db/schema";
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
const directories: string[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) closeDomainDatabase(database);
	for (const directory of directories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
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
	filename?: string;
	wrapBookings?: (delegate: SqliteBookingService) => BookingService;
}) {
	const database = openDomainDatabase({
		filename: options.filename ?? ":memory:",
	});
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
	const bookingsService: BookingService = options.wrapBookings
		? options.wrapBookings(delegate)
		: options.currentSlots
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
		bookingsService,
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

function preloadCommittingDraft(harness: ReturnType<typeof setup>) {
	const initial = harness.draftStore.load(harness.conversationId);
	if (!initial) throw new Error("draft missing");
	const ready = preloadReadyFacts(harness, initial.candidates[0].candidateId);
	const confirmed = harness.draftStore.confirm(harness.conversationId, {
		requestId: Bun.randomUUIDv7(),
		revision: ready.revision,
	});
	return harness.draftStore.markCommitting(
		harness.conversationId,
		confirmed.revision,
	);
}

function closeTrackedDatabase(
	database: ReturnType<typeof openDomainDatabase>,
): void {
	const index = databases.indexOf(database);
	if (index >= 0) databases.splice(index, 1);
	closeDomainDatabase(database);
}

function assistantText(events: readonly OrchestratorEvent[]): string {
	return events
		.filter((event) => event.type === "text.delta")
		.map((event) => event.text)
		.join(" ");
}

async function runRecoveryWorker(
	filename: string,
	conversationId: string,
): Promise<{ bookingId: string }> {
	const worker = join(import.meta.dir, "orphan-recovery-worker.ts");
	const child = Bun.spawn(
		[process.execPath, worker, filename, conversationId, instant],
		{ stderr: "pipe", stdout: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return JSON.parse(stdout) as { bookingId: string };
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

	test("disconnect during a blocked durable create reconciles booking and reconnect stage", async () => {
		let releaseCreate: () => void = () => undefined;
		let markCreateStarted: () => void = () => undefined;
		const createStarted = new Promise<void>((resolve) => {
			markCreateStarted = resolve;
		});
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const harness = setup({
			wrapBookings: (delegate) => ({
				candidateMeetingSlots: () => delegate.candidateMeetingSlots(),
				async createBooking(input) {
					markCreateStarted();
					await createGate;
					return delegate.createBooking(input);
				},
				appendQualification: (input) => delegate.appendQualification(input),
				findByConversationId: (id) => delegate.findByConversationId(id),
			}),
		});
		const initial = harness.draftStore.load(harness.conversationId);
		if (!initial) throw new Error("draft missing");
		const ready = preloadReadyFacts(harness, initial.candidates[0].candidateId);
		const pending = collect(
			harness.orchestrator.confirmBookingDraft({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				confirmation: {
					requestId: Bun.randomUUIDv7(),
					revision: ready.revision,
				},
			}),
		);
		await createStarted;
		await harness.orchestrator.disconnect();
		releaseCreate();
		await expect(pending).resolves.toBeArray();
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(harness.draftStore.load(harness.conversationId)).toMatchObject({
			commitStatus: "committed",
		});
		expect(harness.orchestrator.state).toMatchObject({
			stage: "DISCONNECTED",
			resumeStage: "BOOKED",
			booking: { status: "booked" },
		});
		expect(harness.orchestrator.apply({ type: "reconnect" }).ok).toBe(true);
		expect(harness.orchestrator.state).toMatchObject({
			stage: "BOOKED",
			resumeStage: null,
			booking: { status: "booked" },
		});
	});

	test("restart reconciles an existing write and recovers a crash before create", async () => {
		const committed = setup({});
		const initial = committed.draftStore.load(committed.conversationId);
		if (!initial) throw new Error("draft missing");
		const ready = preloadReadyFacts(
			committed,
			initial.candidates[0].candidateId,
		);
		const confirmed = committed.draftStore.confirm(committed.conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const committing = committed.draftStore.markCommitting(
			committed.conversationId,
			confirmed.revision,
		);
		const facts = committed.draftStore.acceptedFacts(committed.conversationId);
		if (!facts.name || !facts.company || !committing.selectedCandidate) {
			throw new Error("ready facts missing");
		}
		await committed.bookingsService.createBooking({
			conversationId: committed.conversationId,
			idempotencyKey: `booking-draft-${committed.conversationId}`,
			name: facts.name,
			company: facts.company,
			contacts: committed.draftStore.approvedContacts(committed.conversationId),
			meetingSlot: committing.selectedCandidate.meetingSlot,
			consentConfirmed: true,
		});
		const restarted = new ConversationOrchestrator({
			conversationId: committed.conversationId,
			promptVersion,
			stt: new QueueStt([]),
			brain: new FakeBrain(),
			bookings: committed.bookingsService,
			draftStore: committed.draftStore,
			initialState: {
				...createInitialConversationState({ qualificationEnabled: false }),
				stage: "DISCONNECTED",
				resumeStage: "COLLECT_BOOKING",
				contactConsentConfirmed: true,
			},
		});
		const hydrated = await restarted.reconcileDurableBooking();
		expect(hydrated?.status).toBe("booked");
		expect(restarted.state).toMatchObject({
			stage: "DISCONNECTED",
			resumeStage: "BOOKED",
			booking: { id: hydrated?.id },
		});
		expect(committed.draftStore.load(committed.conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: hydrated?.id,
		});

		const noBooking = setup({});
		const orphan = preloadCommittingDraft(noBooking);
		const recovered = await noBooking.orchestrator.reconcileDurableBooking();
		expect(recovered).toMatchObject({
			name: completeDetails.name,
			company: completeDetails.company,
			contacts: [
				{ channel: "email", value: completeDetails.workEmail },
				{ channel: "phone", value: completeDetails.phone },
			],
			meetingSlot: orphan.selectedCandidate?.meetingSlot,
		});
		expect(noBooking.orchestrator.state).toMatchObject({
			stage: "BOOKED",
			booking: { id: recovered?.id },
		});
		expect(noBooking.draftStore.load(noBooking.conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: recovered?.id,
		});
		expect(
			noBooking.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
	});

	test("explicit confirmation recovers an already committing orphan idempotently", async () => {
		const harness = setup({});
		const committing = preloadCommittingDraft(harness);
		const events = await collect(
			harness.orchestrator.confirmBookingDraft({
				turnId: Bun.randomUUIDv7(),
				generationId: Bun.randomUUIDv7(),
				confirmation: {
					requestId: Bun.randomUUIDv7(),
					revision: committing.revision,
				},
			}),
		);
		expect(events.map((event) => event.type)).toEqual([
			"booking.draft.updated",
		]);
		expect(harness.draftStore.load(harness.conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: harness.orchestrator.state.booking?.id,
		});
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
	});

	test("a new process recovers a crash after markCommitting and before create", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-orphan-restart-"));
		directories.push(directory);
		const filename = join(directory, "domain.db");
		const crashed = setup({ filename });
		const committing = preloadCommittingDraft(crashed);
		const expectedInput = crashed.draftStore.committingBookingInput(
			crashed.conversationId,
		);
		expect(expectedInput).toMatchObject({
			idempotencyKey: `booking-draft-${crashed.conversationId}`,
			name: completeDetails.name,
			company: completeDetails.company,
			meetingSlot: committing.selectedCandidate?.meetingSlot,
		});
		closeTrackedDatabase(crashed.database);

		const recovered = await runRecoveryWorker(filename, crashed.conversationId);
		const reopened = openDomainDatabase({ filename, applyMigrations: false });
		databases.push(reopened);
		const restartedStore = new SqliteBookingDraftStore(reopened, {
			now: () => new Date(instant),
		});
		expect(restartedStore.load(crashed.conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: recovered.bookingId,
		});
		expect(
			reopened.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			reopened.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
	});

	test("concurrent process orphan recovery creates exactly one booking and event", async () => {
		const directory = mkdtempSync(join(tmpdir(), "botamin-orphan-race-"));
		directories.push(directory);
		const filename = join(directory, "domain.db");
		const crashed = setup({ filename });
		preloadCommittingDraft(crashed);
		closeTrackedDatabase(crashed.database);

		const recovered = await Promise.all(
			Array.from({ length: 8 }, () =>
				runRecoveryWorker(filename, crashed.conversationId),
			),
		);
		expect(new Set(recovered.map((result) => result.bookingId)).size).toBe(1);
		const reopened = openDomainDatabase({ filename, applyMigrations: false });
		databases.push(reopened);
		expect(
			reopened.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
		expect(
			reopened.select({ value: count() }).from(domainEvents).get()?.value,
		).toBe(1);
		expect(
			reopened.select({ value: count() }).from(notificationOutbox).get()?.value,
		).toBe(1);
		expect(
			new SqliteBookingDraftStore(reopened).load(crashed.conversationId),
		).toMatchObject({
			commitStatus: "committed",
			bookingId: recovered[0]?.bookingId,
		});
	});

	test("safe validation failure unlocks an orphan without mutating confirmed data", async () => {
		const harness = setup({});
		const committing = preloadCommittingDraft(harness);
		if (!committing.selectedCandidate) throw new Error("candidate missing");
		const otherConversationId = Bun.randomUUIDv7();
		new ConversationStore(harness.database).create({
			id: otherConversationId,
			stage: "COLLECT_BOOKING",
			promptVersion,
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: false,
			consentAt: instant,
			startedAt: instant,
		});
		await new SqliteBookingService(harness.database, {
			now: () => new Date(instant),
		}).createBooking({
			conversationId: otherConversationId,
			idempotencyKey: "occupied-orphan-slot",
			name: "Другой лид",
			company: "Другая компания",
			contacts: [
				{ channel: "email", value: "other@example.com" },
				{ channel: "telegram", value: "@other_lead" },
			],
			meetingSlot: committing.selectedCandidate.meetingSlot,
			consentConfirmed: true,
		});
		const before = harness.draftStore.committingBookingInput(
			harness.conversationId,
		);

		expect(await harness.orchestrator.reconcileDurableBooking()).toBeNull();
		const failed = harness.draftStore.load(harness.conversationId);
		expect(failed).toMatchObject({
			commitStatus: "failed",
			confirmationStatus: "confirmed",
			selectedCandidate: committing.selectedCandidate,
		});
		expect(
			harness.draftStore.acceptedFacts(harness.conversationId),
		).toMatchObject(completeDetails);
		expect(before).toEqual({
			conversationId: harness.conversationId,
			idempotencyKey: `booking-draft-${harness.conversationId}`,
			name: completeDetails.name,
			company: completeDetails.company,
			contacts: [
				{ channel: "email", value: completeDetails.workEmail },
				{ channel: "phone", value: completeDetails.phone },
			],
			meetingSlot: committing.selectedCandidate.meetingSlot,
			consentConfirmed: true,
		});
		if (!failed) throw new Error("failed draft missing");
		expect(
			harness.draftStore.setSelectedCandidate(
				harness.conversationId,
				failed.revision,
				failed.candidates[1].candidateId,
			).confirmationStatus,
		).toBe("unconfirmed");
	});

	test("notifier and TTS failures cannot roll back an orphan recovery", async () => {
		const harness = setup({});
		preloadCommittingDraft(harness);
		const failingNotifier = {
			kind: "failing-test-notifier",
			publish: async () => {
				throw new Error("notifier unavailable");
			},
		};
		const failingTts: TtsPort = {
			synthesize: async () => {
				throw new Error("TTS unavailable");
			},
			health: async () => "degraded",
		};
		const recovered = new ConversationOrchestrator({
			conversationId: harness.conversationId,
			promptVersion,
			stt: new QueueStt([]),
			brain: new FakeBrain(),
			bookings: new SqliteBookingService(harness.database, {
				now: () => new Date(instant),
				notifier: failingNotifier,
			}),
			draftStore: harness.draftStore,
			tts: failingTts,
			now: () => new Date(instant),
			initialState: {
				...createInitialConversationState({ qualificationEnabled: false }),
				stage: "COLLECT_BOOKING",
				contactConsentConfirmed: true,
			},
		});
		const booking = await recovered.reconcileDurableBooking();
		expect(booking?.status).toBe("booked");
		expect(
			harness.database
				.select({ status: notificationOutbox.status })
				.from(notificationOutbox)
				.get()?.status,
		).toBe("failed");
		const events = await collect(typed(recovered, "продолжить"));
		expect(events).toContainEqual(
			expect.objectContaining({ type: "degraded", provider: "tts" }),
		);
		expect(harness.draftStore.load(harness.conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: booking?.id,
		});
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(1);
	});

	test("malformed orphan data fails closed without creating or hydrating", async () => {
		const harness = setup({});
		const committing = preloadCommittingDraft(harness);
		harness.database
			.update(conversationContexts)
			.set({
				draftJson: JSON.stringify({
					conversationId: harness.conversationId,
					revision: committing.revision,
					factRegistry: { revision: committing.revision },
					updatedAt: committing.updatedAt,
				}),
			})
			.run();
		await expect(
			harness.orchestrator.reconcileDurableBooking(),
		).rejects.toMatchObject({ code: "MALFORMED_PERSISTED_DRAFT" });
		expect(harness.orchestrator.state.booking).toBeNull();
		expect(
			harness.database.select({ value: count() }).from(bookings).get()?.value,
		).toBe(0);
	});

	test("durable booking mismatch fails closed without hydrating state", async () => {
		const harness = setup({});
		const initial = harness.draftStore.load(harness.conversationId);
		if (!initial) throw new Error("draft missing");
		const ready = preloadReadyFacts(harness, initial.candidates[0].candidateId);
		const confirmed = harness.draftStore.confirm(harness.conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const committing = harness.draftStore.markCommitting(
			harness.conversationId,
			confirmed.revision,
		);
		if (!committing.selectedCandidate) throw new Error("candidate missing");
		await harness.bookingsService.createBooking({
			conversationId: harness.conversationId,
			idempotencyKey: "mismatched-restart-booking",
			name: "Несовпадающее имя",
			company: "Ромашка",
			contacts: harness.draftStore.approvedContacts(harness.conversationId),
			meetingSlot: committing.selectedCandidate.meetingSlot,
			consentConfirmed: true,
		});
		await expect(
			harness.orchestrator.reconcileDurableBooking(),
		).rejects.toMatchObject({ code: "BOOKING_MISMATCH" });
		expect(harness.orchestrator.state.booking).toBeNull();
		expect(harness.draftStore.load(harness.conversationId)).toMatchObject({
			commitStatus: "committing",
			bookingId: null,
		});
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
