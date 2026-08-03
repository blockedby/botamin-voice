import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookingFormDetails, MeetingSlot } from "@botamin/contracts";
import { ConversationStore } from "../../db/conversation-store";
import { closeDomainDatabase, openDomainDatabase } from "../../db/database";
import { conversationContexts } from "../../db/schema";
import { SqliteBookingService } from "../booking/service";
import { BookingDraftError, SqliteBookingDraftStore } from "./store";

const directories: string[] = [];
const now = new Date("2026-08-02T20:00:00.000Z");
const slots: [MeetingSlot, MeetingSlot] = [
	{
		startAt: "2026-08-03T06:00:00.000Z",
		endAt: "2026-08-03T06:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	},
	{
		startAt: "2026-08-03T13:00:00.000Z",
		endAt: "2026-08-03T13:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	},
];
const refreshedSlots: [MeetingSlot, MeetingSlot] = [
	{
		startAt: "2026-08-04T07:00:00.000Z",
		endAt: "2026-08-04T07:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	},
	{
		startAt: "2026-08-04T14:00:00.000Z",
		endAt: "2026-08-04T14:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	},
];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "botamin-draft-store-"));
	directories.push(directory);
	const database = openDomainDatabase({
		filename: join(directory, "domain.db"),
	});
	const conversationId = Bun.randomUUIDv7();
	new ConversationStore(database).create({
		id: conversationId,
		stage: "COLLECT_BOOKING",
		promptVersion: "a".repeat(64),
		source: "landing",
		locale: "ru-RU",
		qualificationEnabled: true,
		consentAt: now.toISOString(),
		startedAt: now.toISOString(),
	});
	const store = new SqliteBookingDraftStore(database, { now: () => now });
	return { database, conversationId, store };
}

function form(
	revision: number,
	candidateId: string,
	details: BookingFormDetails["details"] = {
		name: "Алексей",
		company: "Example LLC",
		workEmail: "alexey@example.com",
		phone: "+79991234567",
		telegram: "@alexey",
	},
): BookingFormDetails {
	return {
		requestId: Bun.randomUUIDv7(),
		baseRevision: revision,
		details,
		selectedCandidateId: candidateId,
	};
}

function readyDraft(store: SqliteBookingDraftStore, conversationId: string) {
	const initial = store.initialize(conversationId, slots);
	return store.applyForm(
		conversationId,
		form(initial.revision, initial.candidates[0].candidateId),
	);
}

function expectDraftError(
	action: () => unknown,
	code: BookingDraftError["code"],
) {
	try {
		action();
		throw new Error("Expected BookingDraftError");
	} catch (error) {
		expect(error).toBeInstanceOf(BookingDraftError);
		expect((error as BookingDraftError).code).toBe(code);
	}
}

describe("SqliteBookingDraftStore", () => {
	test("creates one strict revision-zero draft with seven missing facts and server IDs", () => {
		const { database, conversationId, store } = setup();
		const draft = store.initialize(conversationId, slots);
		expect(draft).toMatchObject({
			conversationId,
			revision: 0,
			readiness: "not_ready",
			confirmationStatus: "unconfirmed",
			commitStatus: "uncommitted",
			bookingId: null,
		});
		expect(Object.keys(draft.factRegistry.facts)).toHaveLength(7);
		for (const fact of Object.values(draft.factRegistry.facts)) {
			expect(fact).toEqual({
				status: "missing",
				value: null,
				provenance: null,
				conflictOptions: [],
			});
		}
		expect(draft.candidates).toHaveLength(2);
		expect(draft.candidates[0].candidateId).not.toBe(
			draft.candidates[1].candidateId,
		);
		expect(store.initialize(conversationId, refreshedSlots)).toEqual(draft);
		expectDraftError(
			() => store.initialize(Bun.randomUUIDv7(), slots),
			"NOT_FOUND",
		);
		closeDomainDatabase(database);
	});

	test("merges equal canonical proposals and strips evidence from browser projection", () => {
		const { database, conversationId, store } = setup();
		store.initialize(conversationId, slots);
		const turnId = Bun.randomUUIDv7();
		const first = store.ingestProposals({
			conversationId,
			expectedRevision: 0,
			source: "voice_transcript",
			turnId,
			currentTurnText: "Меня зовут Алексей",
			proposals: [
				{ field: "name", value: "Алексей", quote: "Меня зовут Алексей" },
			],
		});
		expectDraftError(
			() =>
				store.ingestProposals({
					conversationId,
					expectedRevision: first.revision,
					source: "typed_message",
					turnId: Bun.randomUUIDv7(),
					currentTurnText: "Другая реплика",
					proposals: [{ field: "name", value: "Алексей", quote: "Алексей" }],
				}),
			"INVALID_INPUT",
		);
		const merged = store.ingestProposals({
			conversationId,
			expectedRevision: first.revision,
			source: "typed_message",
			turnId: Bun.randomUUIDv7(),
			currentTurnText: "Алексей",
			proposals: [{ field: "name", value: " Алексей ", quote: "Алексей" }],
		});
		expect(merged.factRegistry.facts.name.status).toBe("accepted");
		expect(merged.factRegistry.facts.name.value).toBe("Алексей");
		expect(merged.factRegistry.facts.name.conflictOptions).toEqual([]);
		expect(merged.revision).toBe(2);
		const browser = store.browserDraft(conversationId);
		expect(JSON.stringify(browser)).not.toContain("evidenceText");
		expect(JSON.stringify(browser)).not.toContain(turnId);
		closeDomainDatabase(database);
	});

	test("creates a bounded conflict instead of replacing an accepted fact from form", () => {
		const { database, conversationId, store } = setup();
		const initial = store.initialize(conversationId, slots);
		const accepted = store.ingestProposals({
			conversationId,
			expectedRevision: initial.revision,
			source: "typed_message",
			turnId: Bun.randomUUIDv7(),
			currentTurnText: "Acme",
			proposals: [{ field: "company", value: "Acme", quote: "Acme" }],
		});
		const conflicted = store.applyForm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: accepted.revision,
			details: { company: "Example LLC" },
		});
		expect(conflicted.factRegistry.facts.company.status).toBe("conflicted");
		if (conflicted.factRegistry.facts.company.status === "conflicted") {
			expect(
				conflicted.factRegistry.facts.company.conflictOptions,
			).toHaveLength(2);
			expect(
				conflicted.factRegistry.facts.company.conflictOptions.map(
					(option) => option.value,
				),
			).toEqual(["Acme", "Example LLC"]);
		}
		let bounded = conflicted;
		for (const company of ["Third LLC", "Fourth LLC"]) {
			bounded = store.applyForm(conversationId, {
				requestId: Bun.randomUUIDv7(),
				baseRevision: bounded.revision,
				details: { company },
			});
		}
		expectDraftError(
			() =>
				store.applyForm(conversationId, {
					requestId: Bun.randomUUIDv7(),
					baseRevision: bounded.revision,
					details: { company: "Fifth LLC" },
				}),
			"CONFLICT_LIMIT_REACHED",
		);
		closeDomainDatabase(database);
	});

	test("applies validated phone and Telegram form patches idempotently", () => {
		const { database, conversationId, store } = setup();
		const initial = store.initialize(conversationId, slots);
		const submission = form(
			initial.revision,
			initial.candidates[1].candidateId,
		);
		const updated = store.applyForm(conversationId, submission);
		expect(updated.readiness).toBe("ready");
		expect(updated.selectedCandidate).toEqual(initial.candidates[1]);
		expect(store.acceptedFacts(conversationId)).toMatchObject({
			phone: "+79991234567",
			telegram: "@alexey",
		});
		expect(store.approvedContacts(conversationId)).toEqual([
			{ channel: "email", value: "alexey@example.com" },
			{ channel: "phone", value: "+79991234567" },
			{ channel: "telegram", value: "@alexey" },
		]);
		expect(store.applyForm(conversationId, submission).revision).toBe(
			updated.revision,
		);
		expectDraftError(
			() =>
				store.applyForm(conversationId, {
					...submission,
					details: { phone: "+79990000000" },
				}),
			"IDEMPOTENCY_CONFLICT",
		);
		closeDomainDatabase(database);
	});

	test("selects and clears only an exact current candidate at the current revision", () => {
		const { database, conversationId, store } = setup();
		const initial = store.initialize(conversationId, slots);
		const selected = store.setSelectedCandidate(
			conversationId,
			initial.revision,
			initial.candidates[1].candidateId,
		);
		expect(selected.selectedCandidate).toEqual(initial.candidates[1]);
		expectDraftError(
			() =>
				store.setSelectedCandidate(
					conversationId,
					initial.revision,
					initial.candidates[0].candidateId,
				),
			"INVALID_REVISION",
		);
		expectDraftError(
			() =>
				store.setSelectedCandidate(
					conversationId,
					selected.revision,
					Bun.randomUUIDv7(),
				),
			"CANDIDATE_MISMATCH",
		);
		const cleared = store.setSelectedCandidate(
			conversationId,
			selected.revision,
			null,
		);
		expect(cleared.selectedCandidate).toBeNull();
		closeDomainDatabase(database);
	});

	test("rejects stale revisions without mutating persisted state", () => {
		const { database, conversationId, store } = setup();
		const initial = store.initialize(conversationId, slots);
		const updated = store.applyForm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: 0,
			details: { name: "Алексей" },
		});
		expectDraftError(
			() =>
				store.ingestProposals({
					conversationId,
					expectedRevision: initial.revision,
					source: "typed_message",
					turnId: Bun.randomUUIDv7(),
					currentTurnText: "Acme",
					proposals: [{ field: "company", value: "Acme", quote: "Acme" }],
				}),
			"INVALID_REVISION",
		);
		expect(store.load(conversationId)?.revision).toBe(updated.revision);
		closeDomainDatabase(database);
	});

	test("resolves only a current conflict option ID", () => {
		const { database, conversationId, store } = setup();
		store.initialize(conversationId, slots);
		const accepted = store.applyForm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: 0,
			details: { company: "Acme" },
		});
		const conflicted = store.applyForm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: accepted.revision,
			details: { company: "Example LLC" },
		});
		if (conflicted.factRegistry.facts.company.status !== "conflicted") {
			throw new Error("Expected conflict");
		}
		expectDraftError(
			() =>
				store.resolveConflict(conversationId, {
					requestId: Bun.randomUUIDv7(),
					baseRevision: conflicted.revision,
					field: "company",
					conflictOptionId: Bun.randomUUIDv7(),
				}),
			"CONFLICT_OPTION_MISMATCH",
		);
		const selected = conflicted.factRegistry.facts.company.conflictOptions[1];
		if (selected === undefined) throw new Error("Expected option");
		const resolved = store.resolveConflict(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: conflicted.revision,
			field: "company",
			conflictOptionId: selected.optionId,
		});
		expect(resolved.factRegistry.facts.company).toMatchObject({
			status: "accepted",
			value: "Example LLC",
		});
		closeDomainDatabase(database);
	});

	test("refreshes the candidate pair with server IDs and clears confirmation and selection", () => {
		const { database, conversationId, store } = setup();
		const ready = readyDraft(store, conversationId);
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const refreshed = store.refreshCandidates(
			conversationId,
			confirmed.revision,
			refreshedSlots,
		);
		expect(refreshed.selectedCandidate).toBeNull();
		expect(refreshed.confirmationStatus).toBe("unconfirmed");
		expect(refreshed.readiness).toBe("not_ready");
		expect(
			refreshed.candidates.map((candidate) => candidate.meetingSlot),
		).toEqual(refreshedSlots);
		closeDomainDatabase(database);
	});

	test("invalidates confirmation on a material fact mutation", () => {
		const { database, conversationId, store } = setup();
		const ready = readyDraft(store, conversationId);
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const changed = store.applyForm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: confirmed.revision,
			details: { company: "Different LLC" },
		});
		expect(changed.confirmationStatus).toBe("unconfirmed");
		expect(changed.readiness).toBe("not_ready");
		closeDomainDatabase(database);
	});

	test("enforces exact confirmation and commit lifecycle against the durable booking", async () => {
		const { database, conversationId, store } = setup();
		const ready = readyDraft(store, conversationId);
		expectDraftError(
			() =>
				store.confirm(conversationId, {
					requestId: Bun.randomUUIDv7(),
					revision: 0,
				}),
			"INVALID_REVISION",
		);
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const committing = store.markCommitting(conversationId, confirmed.revision);
		const failed = store.markFailed(conversationId, committing.revision);
		expect(failed.commitStatus).toBe("failed");
		const retrying = store.markCommitting(conversationId, failed.revision);
		const immutableInput = store.committingBookingInput(conversationId);
		expect(immutableInput).toEqual({
			conversationId,
			idempotencyKey: `booking-draft-${conversationId}`,
			name: "Алексей",
			company: "Example LLC",
			contacts: store.approvedContacts(conversationId),
			meetingSlot: retrying.selectedCandidate?.meetingSlot ?? slots[0],
			consentConfirmed: true,
		});
		const booking = await new SqliteBookingService(database, {
			now: () => now,
		}).createBooking(immutableInput);
		expectDraftError(
			() => store.markFailed(conversationId, retrying.revision),
			"INVALID_TRANSITION",
		);
		const committed = store.markCommitted(
			conversationId,
			retrying.revision,
			booking.bookingId,
		);
		expect(committed).toMatchObject({
			commitStatus: "committed",
			bookingId: booking.bookingId,
			confirmationStatus: "confirmed",
		});
		expectDraftError(
			() => store.refreshCandidates(conversationId, committed.revision, slots),
			"ALREADY_COMMITTED",
		);
		closeDomainDatabase(database);
	});

	test("reconciles exact durable bookings and fails closed on mismatch", async () => {
		const { database, conversationId, store } = setup();
		const ready = readyDraft(store, conversationId);
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const committing = store.markCommitting(conversationId, confirmed.revision);
		const booking = await new SqliteBookingService(database, {
			now: () => now,
		}).createBooking({
			conversationId,
			idempotencyKey: "draft-reconcile-booking-0001",
			name: "Алексей",
			company: "Example LLC",
			contacts: store.approvedContacts(conversationId),
			meetingSlot: committing.selectedCandidate?.meetingSlot ?? slots[0],
			consentConfirmed: true,
		});
		const reconciled = store.reconcile(conversationId);
		expect(reconciled).toMatchObject({
			commitStatus: "committed",
			bookingId: booking.bookingId,
		});
		expect(store.reconcile(conversationId)).toEqual(reconciled);

		const other = setup();
		const otherReady = readyDraft(other.store, other.conversationId);
		const otherConfirmed = other.store.confirm(other.conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: otherReady.revision,
		});
		const otherCommitting = other.store.markCommitting(
			other.conversationId,
			otherConfirmed.revision,
		);
		await new SqliteBookingService(other.database, {
			now: () => now,
		}).createBooking({
			conversationId: other.conversationId,
			idempotencyKey: "draft-reconcile-booking-0002",
			name: "Чужое имя",
			company: "Example LLC",
			contacts: other.store.approvedContacts(other.conversationId),
			meetingSlot: otherCommitting.selectedCandidate?.meetingSlot ?? slots[0],
			consentConfirmed: true,
		});
		expectDraftError(
			() => other.store.reconcile(other.conversationId),
			"BOOKING_MISMATCH",
		);
		closeDomainDatabase(database);
		closeDomainDatabase(other.database);
	});

	test("reconciles a confirmed uncommitted draft only after an exact durable booking exists", async () => {
		const { database, conversationId, store } = setup();
		const ready = readyDraft(store, conversationId);
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		if (!confirmed.selectedCandidate) throw new Error("candidate missing");
		const created = await new SqliteBookingService(database, {
			now: () => now,
		}).createBooking({
			conversationId,
			idempotencyKey: "confirmed-reconcile-booking-0001",
			name: "Алексей",
			company: "Example LLC",
			contacts: store.approvedContacts(conversationId),
			meetingSlot: confirmed.selectedCandidate.meetingSlot,
			consentConfirmed: true,
		});
		expect(store.reconcile(conversationId)).toMatchObject({
			commitStatus: "committed",
			bookingId: created.bookingId,
		});
		closeDomainDatabase(database);
	});

	test("does not hydrate a committing draft without a durable booking", () => {
		const { database, conversationId, store } = setup();
		const ready = readyDraft(store, conversationId);
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const committing = store.markCommitting(conversationId, confirmed.revision);
		expect(store.reconcile(conversationId)).toEqual(committing);
		closeDomainDatabase(database);
	});

	test("fails closed when persisted JSON is syntactically valid but not a strict draft", () => {
		const { database, conversationId, store } = setup();
		const draft = store.initialize(conversationId, slots);
		database.$client.run(
			`UPDATE conversation_contexts
			 SET draft_json = ?
			 WHERE conversation_id = ?`,
			[
				JSON.stringify({
					revision: draft.revision,
					factRegistry: {
						schemaVersion: 1,
						revision: draft.revision,
						facts: {},
					},
					updatedAt: draft.updatedAt,
				}),
				conversationId,
			],
		);
		expectDraftError(
			() => store.load(conversationId),
			"MALFORMED_PERSISTED_DRAFT",
		);
		expect(database.select().from(conversationContexts).get()).toBeDefined();
		closeDomainDatabase(database);
	});
});
