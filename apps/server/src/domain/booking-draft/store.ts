import {
	type BookingConflictResolution,
	BookingConflictResolutionSchema,
	BookingContactsSchema,
	type BookingDraftCandidate,
	BookingDraftCandidateSchema,
	type BookingFormDetails,
	BookingFormDetailsSchema,
	type BookingRevisionConfirmation,
	BookingRevisionConfirmationSchema,
	type Contact,
	type ConversationFactField,
	type ConversationFactSource,
	deriveBrowserBookingDraft,
	EntityIdSchema,
	type InternalBookingDraft,
	InternalBookingDraftSchema,
	type LunaFactProposal,
	LunaFactProposalSchema,
	type MeetingSlot,
} from "@botamin/contracts";
import { and, eq } from "drizzle-orm";
import type { DomainDatabase } from "../../db/database";
import {
	bookings,
	conversationContexts,
	conversations,
	idempotencyKeys,
} from "../../db/schema";
import {
	type Clock,
	canonicalJson,
	createEntityId,
	type IdFactory,
	requestHash,
} from "../booking/support";

const FACT_FIELDS = [
	"name",
	"company",
	"workEmail",
	"phone",
	"telegram",
	"monthlyLeadVolume",
	"salesManagerCount",
] as const satisfies readonly ConversationFactField[];

const DRAFT_SCOPE = "booking:draft";

type FactValue = string | number;
type ProposalSource = Extract<
	ConversationFactSource,
	"voice_transcript" | "typed_message"
>;
type FactProvenance = {
	source: ConversationFactSource;
	turnId: string | null;
	observedAt: string;
	evidenceText: string;
};
type ConflictOption = {
	optionId: string;
	value: FactValue;
	provenance: FactProvenance;
};
type MutableFact =
	| {
			status: "missing";
			value: null;
			provenance: null;
			conflictOptions: [];
	  }
	| {
			status: "accepted" | "needs_confirmation";
			value: FactValue;
			provenance: FactProvenance;
			conflictOptions: [];
	  }
	| {
			status: "conflicted";
			value: null;
			provenance: null;
			conflictOptions: ConflictOption[];
	  };

type MutableFacts = Record<ConversationFactField, MutableFact>;

type DraftMutation = (
	draft: InternalBookingDraft,
	timestamp: string,
) => { material: boolean } | undefined;

interface IdempotentMutation {
	operation: "form" | "resolve" | "confirm";
	requestId: string;
	hash: string;
}

export interface BookingDraftProposalInput {
	conversationId: string;
	expectedRevision: number;
	source: ProposalSource;
	turnId: string;
	currentTurnText: string;
	proposals: readonly LunaFactProposal[];
}

export interface AcceptedConversationFacts {
	name?: string;
	company?: string;
	workEmail?: string;
	phone?: string;
	telegram?: string;
	monthlyLeadVolume?: string;
	salesManagerCount?: number;
}

export type BookingDraftErrorCode =
	| "ALREADY_COMMITTED"
	| "BOOKING_MISMATCH"
	| "CANDIDATE_MISMATCH"
	| "CONFLICT_LIMIT_REACHED"
	| "CONFLICT_OPTION_MISMATCH"
	| "CONFLICT_REQUIRES_RESOLUTION"
	| "IDEMPOTENCY_CONFLICT"
	| "INVALID_INPUT"
	| "INVALID_REVISION"
	| "INVALID_TRANSITION"
	| "MALFORMED_PERSISTED_DRAFT"
	| "NOT_FOUND"
	| "NOT_READY";

const SAFE_ERROR_MESSAGES: Record<BookingDraftErrorCode, string> = {
	ALREADY_COMMITTED: "The booking draft is already committed",
	BOOKING_MISMATCH: "The durable booking does not match the confirmed draft",
	CANDIDATE_MISMATCH: "The selected booking candidate is not current",
	CONFLICT_LIMIT_REACHED: "The fact conflict has reached its safe option limit",
	CONFLICT_OPTION_MISMATCH: "The selected conflict option is not current",
	CONFLICT_REQUIRES_RESOLUTION:
		"The fact conflict requires explicit resolution",
	IDEMPOTENCY_CONFLICT: "The request identifier was already used",
	INVALID_INPUT: "The booking draft input is invalid",
	INVALID_REVISION: "The booking draft revision is stale",
	INVALID_TRANSITION: "The booking draft lifecycle transition is invalid",
	MALFORMED_PERSISTED_DRAFT: "The persisted booking draft is invalid",
	NOT_FOUND: "The conversation booking draft was not found",
	NOT_READY: "The booking draft is not ready",
};

export class BookingDraftError extends Error {
	constructor(readonly code: BookingDraftErrorCode) {
		super(SAFE_ERROR_MESSAGES[code]);
		this.name = "BookingDraftError";
	}
}

export interface BookingDraftStore {
	initialize(
		conversationId: string,
		candidateSlots: readonly [MeetingSlot, MeetingSlot],
	): InternalBookingDraft;
	load(conversationId: string): InternalBookingDraft | null;
	ingestProposals(input: BookingDraftProposalInput): InternalBookingDraft;
	applyForm(
		conversationId: string,
		submission: BookingFormDetails,
	): InternalBookingDraft;
	resolveConflict(
		conversationId: string,
		resolution: BookingConflictResolution,
	): InternalBookingDraft;
	confirm(
		conversationId: string,
		confirmation: BookingRevisionConfirmation,
	): InternalBookingDraft;
	refreshCandidates(
		conversationId: string,
		expectedRevision: number,
		candidateSlots: readonly [MeetingSlot, MeetingSlot],
	): InternalBookingDraft;
	markCommitting(
		conversationId: string,
		expectedRevision: number,
	): InternalBookingDraft;
	markCommitted(
		conversationId: string,
		expectedRevision: number,
		bookingId: string,
	): InternalBookingDraft;
	markFailed(
		conversationId: string,
		expectedRevision: number,
	): InternalBookingDraft;
	acceptedFacts(conversationId: string): AcceptedConversationFacts;
	approvedContacts(conversationId: string): Contact[];
}

function missingFact(): MutableFact {
	return {
		status: "missing",
		value: null,
		provenance: null,
		conflictOptions: [],
	};
}

function factsOf(draft: InternalBookingDraft): MutableFacts {
	return draft.factRegistry.facts as unknown as MutableFacts;
}

function sameValue(left: FactValue, right: FactValue): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function ready(draft: InternalBookingDraft): boolean {
	const facts = factsOf(draft);
	return (
		facts.name.status === "accepted" &&
		facts.company.status === "accepted" &&
		facts.workEmail.status === "accepted" &&
		(facts.phone.status === "accepted" ||
			facts.telegram.status === "accepted") &&
		draft.selectedCandidate !== null
	);
}

function sameSlot(left: MeetingSlot, right: MeetingSlot): boolean {
	return (
		left.startAt === right.startAt &&
		left.endAt === right.endAt &&
		left.timeZone === right.timeZone &&
		left.durationMinutes === right.durationMinutes
	);
}

function assertMutable(draft: InternalBookingDraft): void {
	if (draft.commitStatus === "committed") {
		throw new BookingDraftError("ALREADY_COMMITTED");
	}
	if (draft.commitStatus === "committing") {
		throw new BookingDraftError("INVALID_TRANSITION");
	}
}

export class SqliteBookingDraftStore implements BookingDraftStore {
	private readonly now: Clock;
	private readonly idFactory: IdFactory;

	constructor(
		private readonly database: DomainDatabase,
		options: { now?: Clock; idFactory?: IdFactory } = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.idFactory = options.idFactory ?? createEntityId;
	}

	initialize(
		conversationId: string,
		candidateSlots: readonly [MeetingSlot, MeetingSlot],
	): InternalBookingDraft {
		return this.database.transaction(
			(): InternalBookingDraft => {
				const existing = this.load(conversationId);
				if (existing !== null) return existing;
				const conversation = this.database
					.select({ id: conversations.id })
					.from(conversations)
					.where(eq(conversations.id, conversationId))
					.get();
				if (conversation === undefined) {
					throw new BookingDraftError("NOT_FOUND");
				}
				const timestamp = this.timestamp();
				const candidates = this.serverCandidates(candidateSlots);
				const facts = Object.fromEntries(
					FACT_FIELDS.map((field) => [field, missingFact()]),
				) as MutableFacts;
				const draft = this.parseInputDraft({
					revision: 0,
					conversationId,
					factRegistry: {
						schemaVersion: 1,
						revision: 0,
						facts,
						updatedAt: timestamp,
					},
					candidates,
					selectedCandidate: null,
					readiness: "not_ready",
					confirmationStatus: "unconfirmed",
					commitStatus: "uncommitted",
					bookingId: null,
					createdAt: timestamp,
					updatedAt: timestamp,
				});
				this.database
					.insert(conversationContexts)
					.values({
						conversationId,
						revision: 0,
						draftJson: canonicalJson(draft),
						updatedAt: timestamp,
					})
					.run();
				return draft;
			},
			{ behavior: "immediate" },
		);
	}

	load(conversationId: string): InternalBookingDraft | null {
		const row = this.database
			.select()
			.from(conversationContexts)
			.where(eq(conversationContexts.conversationId, conversationId))
			.get();
		if (row === undefined) return null;
		try {
			const draft = InternalBookingDraftSchema.parse(JSON.parse(row.draftJson));
			if (
				draft.conversationId !== conversationId ||
				draft.revision !== row.revision ||
				draft.updatedAt !== row.updatedAt
			) {
				throw new Error("row mismatch");
			}
			return draft;
		} catch {
			throw new BookingDraftError("MALFORMED_PERSISTED_DRAFT");
		}
	}

	browserDraft(conversationId: string) {
		return deriveBrowserBookingDraft(this.requireDraft(conversationId));
	}

	ingestProposals(input: BookingDraftProposalInput): InternalBookingDraft {
		if (
			(input.source !== "voice_transcript" &&
				input.source !== "typed_message") ||
			typeof input.currentTurnText !== "string" ||
			input.currentTurnText.trim().length < 1 ||
			input.currentTurnText.length > 20_000 ||
			input.proposals.length < 1 ||
			input.proposals.length > 7
		) {
			throw new BookingDraftError("INVALID_INPUT");
		}
		this.parseInput(EntityIdSchema, input.turnId);
		const proposals = input.proposals.map((proposal) =>
			this.parseInput(LunaFactProposalSchema, proposal),
		);
		if (
			proposals.some(
				(proposal) => !input.currentTurnText.includes(proposal.quote),
			)
		) {
			throw new BookingDraftError("INVALID_INPUT");
		}
		return this.mutate(
			input.conversationId,
			input.expectedRevision,
			(draft, timestamp) => {
				assertMutable(draft);
				let material = false;
				for (const proposal of proposals) {
					const provenance: FactProvenance = {
						source: input.source,
						turnId: input.turnId,
						observedAt: timestamp,
						evidenceText: proposal.quote,
					};
					material =
						this.mergeAccepted(
							factsOf(draft),
							proposal.field,
							proposal.value,
							provenance,
						) || material;
				}
				return { material };
			},
		);
	}

	applyForm(
		conversationId: string,
		submission: BookingFormDetails,
	): InternalBookingDraft {
		const parsed = this.parseInput(BookingFormDetailsSchema, submission);
		return this.mutate(
			conversationId,
			parsed.baseRevision,
			(draft, timestamp) => {
				assertMutable(draft);
				let material = false;
				const facts = factsOf(draft);
				for (const field of FACT_FIELDS) {
					if (!Object.hasOwn(parsed.details, field)) continue;
					const value = parsed.details[field];
					if (value === undefined) {
						throw new BookingDraftError("INVALID_INPUT");
					}
					if (value === null) {
						if (facts[field].status === "conflicted") {
							throw new BookingDraftError("CONFLICT_REQUIRES_RESOLUTION");
						}
						if (facts[field].status !== "missing") {
							facts[field] = missingFact();
							material = true;
						}
						continue;
					}
					material =
						this.mergeAccepted(facts, field, value, {
							source: "booking_form",
							turnId: null,
							observedAt: timestamp,
							evidenceText: "Structured booking form submission",
						}) || material;
				}

				if (parsed.selectedCandidateId !== undefined) {
					if (parsed.selectedCandidateId === null) {
						if (draft.selectedCandidate !== null) material = true;
						draft.selectedCandidate = null;
					} else {
						const selected = draft.candidates.find(
							(candidate) =>
								candidate.candidateId === parsed.selectedCandidateId,
						);
						if (selected === undefined) {
							throw new BookingDraftError("CANDIDATE_MISMATCH");
						}
						if (draft.selectedCandidate?.candidateId !== selected.candidateId) {
							material = true;
						}
						draft.selectedCandidate = selected;
					}
				}
				return { material };
			},
			{
				operation: "form",
				requestId: parsed.requestId,
				hash: requestHash(parsed),
			},
		);
	}

	resolveConflict(
		conversationId: string,
		resolution: BookingConflictResolution,
	): InternalBookingDraft {
		const parsed = this.parseInput(BookingConflictResolutionSchema, resolution);
		return this.mutate(
			conversationId,
			parsed.baseRevision,
			(draft, timestamp) => {
				assertMutable(draft);
				const facts = factsOf(draft);
				const current = facts[parsed.field];
				if (current.status !== "conflicted") {
					throw new BookingDraftError("CONFLICT_REQUIRES_RESOLUTION");
				}
				const selected = current.conflictOptions.find(
					(option) => option.optionId === parsed.conflictOptionId,
				);
				if (selected === undefined) {
					throw new BookingDraftError("CONFLICT_OPTION_MISMATCH");
				}
				facts[parsed.field] = {
					status: "accepted",
					value: selected.value,
					provenance: {
						source: "conflict_resolution",
						turnId: null,
						observedAt: timestamp,
						evidenceText: "Selected current conflict option",
					},
					conflictOptions: [],
				};
				return { material: true };
			},
			{
				operation: "resolve",
				requestId: parsed.requestId,
				hash: requestHash(parsed),
			},
		);
	}

	confirm(
		conversationId: string,
		confirmation: BookingRevisionConfirmation,
	): InternalBookingDraft {
		const parsed = this.parseInput(
			BookingRevisionConfirmationSchema,
			confirmation,
		);
		return this.mutate(
			conversationId,
			parsed.revision,
			(draft) => {
				if (
					(draft.commitStatus !== "uncommitted" &&
						draft.commitStatus !== "failed") ||
					!ready(draft)
				) {
					throw new BookingDraftError("NOT_READY");
				}
				draft.confirmationStatus = "confirmed";
				return { material: false };
			},
			{
				operation: "confirm",
				requestId: parsed.requestId,
				hash: requestHash(parsed),
			},
		);
	}

	refreshCandidates(
		conversationId: string,
		expectedRevision: number,
		candidateSlots: readonly [MeetingSlot, MeetingSlot],
	): InternalBookingDraft {
		const candidates = this.serverCandidates(candidateSlots);
		return this.mutate(conversationId, expectedRevision, (draft) => {
			assertMutable(draft);
			draft.candidates = candidates;
			draft.selectedCandidate = null;
			return { material: true };
		});
	}

	markCommitting(
		conversationId: string,
		expectedRevision: number,
	): InternalBookingDraft {
		return this.mutate(conversationId, expectedRevision, (draft) => {
			if (
				(draft.commitStatus !== "uncommitted" &&
					draft.commitStatus !== "failed") ||
				draft.confirmationStatus !== "confirmed" ||
				!ready(draft) ||
				draft.bookingId !== null
			) {
				throw new BookingDraftError("INVALID_TRANSITION");
			}
			draft.commitStatus = "committing";
			return { material: false };
		});
	}

	markCommitted(
		conversationId: string,
		expectedRevision: number,
		bookingId: string,
	): InternalBookingDraft {
		return this.mutate(conversationId, expectedRevision, (draft) => {
			if (
				draft.commitStatus !== "committing" ||
				draft.confirmationStatus !== "confirmed" ||
				!ready(draft) ||
				draft.bookingId !== null
			) {
				throw new BookingDraftError("INVALID_TRANSITION");
			}
			this.assertBookingMatches(draft, bookingId);
			draft.commitStatus = "committed";
			draft.bookingId = bookingId;
			return { material: false };
		});
	}

	markFailed(
		conversationId: string,
		expectedRevision: number,
	): InternalBookingDraft {
		return this.mutate(conversationId, expectedRevision, (draft) => {
			if (draft.commitStatus !== "committing" || draft.bookingId !== null) {
				throw new BookingDraftError("INVALID_TRANSITION");
			}
			const durableBooking = this.database
				.select({ id: bookings.id })
				.from(bookings)
				.where(eq(bookings.conversationId, conversationId))
				.get();
			if (durableBooking !== undefined) {
				throw new BookingDraftError("INVALID_TRANSITION");
			}
			draft.commitStatus = "failed";
			return { material: false };
		});
	}

	acceptedFacts(conversationId: string): AcceptedConversationFacts {
		const accepted: AcceptedConversationFacts = {};
		const facts = factsOf(this.requireDraft(conversationId));
		for (const field of FACT_FIELDS) {
			const fact = facts[field];
			if (fact.status !== "accepted") continue;
			Object.assign(accepted, { [field]: fact.value });
		}
		return accepted;
	}

	approvedContacts(conversationId: string): Contact[] {
		const facts = factsOf(this.requireDraft(conversationId));
		const contacts: Contact[] = [];
		if (facts.workEmail.status === "accepted") {
			contacts.push({ channel: "email", value: String(facts.workEmail.value) });
		}
		if (facts.phone.status === "accepted") {
			contacts.push({ channel: "phone", value: String(facts.phone.value) });
		}
		if (facts.telegram.status === "accepted") {
			contacts.push({
				channel: "telegram",
				value: String(facts.telegram.value),
			});
		}
		return contacts;
	}

	private mergeAccepted(
		facts: MutableFacts,
		field: ConversationFactField,
		value: FactValue,
		provenance: FactProvenance,
	): boolean {
		const current = facts[field];
		if (current.status === "missing") {
			facts[field] = {
				status: "accepted",
				value,
				provenance,
				conflictOptions: [],
			};
			return true;
		}
		if (current.status === "conflicted") {
			if (
				current.conflictOptions.some((option) => sameValue(option.value, value))
			) {
				return false;
			}
			if (current.conflictOptions.length >= 4) {
				throw new BookingDraftError("CONFLICT_LIMIT_REACHED");
			}
			current.conflictOptions.push({
				optionId: this.idFactory(),
				value,
				provenance,
			});
			return true;
		}
		if (sameValue(current.value, value)) {
			if (current.status === "needs_confirmation") {
				facts[field] = {
					status: "accepted",
					value,
					provenance,
					conflictOptions: [],
				};
				return true;
			}
			return false;
		}
		facts[field] = {
			status: "conflicted",
			value: null,
			provenance: null,
			conflictOptions: [
				{
					optionId: this.idFactory(),
					value: current.value,
					provenance: current.provenance,
				},
				{ optionId: this.idFactory(), value, provenance },
			],
		};
		return true;
	}

	private mutate(
		conversationId: string,
		expectedRevision: number,
		mutation: DraftMutation,
		idempotency?: IdempotentMutation,
	): InternalBookingDraft {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			throw new BookingDraftError("INVALID_REVISION");
		}
		return this.database.transaction(
			(): InternalBookingDraft => {
				if (idempotency !== undefined) {
					const scope = `${DRAFT_SCOPE}:${idempotency.operation}:${conversationId}`;
					const replay = this.database
						.select()
						.from(idempotencyKeys)
						.where(
							and(
								eq(idempotencyKeys.scope, scope),
								eq(idempotencyKeys.key, idempotency.requestId),
							),
						)
						.get();
					if (replay !== undefined) {
						if (replay.requestHash !== idempotency.hash) {
							throw new BookingDraftError("IDEMPOTENCY_CONFLICT");
						}
						return this.requireDraft(conversationId);
					}
				}

				const draft = this.requireDraft(conversationId);
				if (draft.revision !== expectedRevision) {
					throw new BookingDraftError("INVALID_REVISION");
				}
				if (draft.revision >= Number.MAX_SAFE_INTEGER) {
					throw new BookingDraftError("INVALID_REVISION");
				}
				const timestamp = this.timestamp(draft.updatedAt);
				const result = mutation(draft, timestamp);
				if (result?.material) draft.confirmationStatus = "unconfirmed";
				draft.readiness = ready(draft) ? "ready" : "not_ready";
				draft.revision += 1;
				draft.factRegistry.revision = draft.revision;
				draft.factRegistry.updatedAt = timestamp;
				draft.updatedAt = timestamp;
				const parsed = this.parseInputDraft(draft);
				const changed = this.database
					.update(conversationContexts)
					.set({
						revision: parsed.revision,
						draftJson: canonicalJson(parsed),
						updatedAt: parsed.updatedAt,
					})
					.where(
						and(
							eq(conversationContexts.conversationId, conversationId),
							eq(conversationContexts.revision, expectedRevision),
						),
					)
					.returning({ revision: conversationContexts.revision })
					.get();
				if (changed === undefined) {
					throw new BookingDraftError("INVALID_REVISION");
				}
				if (idempotency !== undefined) {
					this.database
						.insert(idempotencyKeys)
						.values({
							scope: `${DRAFT_SCOPE}:${idempotency.operation}:${conversationId}`,
							key: idempotency.requestId,
							requestHash: idempotency.hash,
							resultJson: canonicalJson({ revision: parsed.revision }),
							conversationId,
							bookingId: parsed.bookingId,
							createdAt: timestamp,
						})
						.run();
				}
				return parsed;
			},
			{ behavior: "immediate" },
		);
	}

	private requireDraft(conversationId: string): InternalBookingDraft {
		const draft = this.load(conversationId);
		if (draft === null) throw new BookingDraftError("NOT_FOUND");
		return draft;
	}

	private parseInputDraft(value: unknown): InternalBookingDraft {
		try {
			return InternalBookingDraftSchema.parse(value);
		} catch {
			throw new BookingDraftError("INVALID_INPUT");
		}
	}

	private parseInput<T>(
		schema: { parse(value: unknown): T },
		value: unknown,
	): T {
		try {
			return schema.parse(value);
		} catch {
			throw new BookingDraftError("INVALID_INPUT");
		}
	}

	private timestamp(notBefore?: string): string {
		const current = this.now();
		if (!Number.isFinite(current.getTime())) {
			throw new BookingDraftError("INVALID_INPUT");
		}
		const floor =
			notBefore === undefined ? current.getTime() : Date.parse(notBefore);
		return new Date(Math.max(current.getTime(), floor)).toISOString();
	}

	private serverCandidates(
		candidateSlots: readonly [MeetingSlot, MeetingSlot],
	): [BookingDraftCandidate, BookingDraftCandidate] {
		return this.parseInputDraftCandidates([
			{ candidateId: this.idFactory(), meetingSlot: candidateSlots[0] },
			{ candidateId: this.idFactory(), meetingSlot: candidateSlots[1] },
		]);
	}

	private parseInputDraftCandidates(
		value: readonly [unknown, unknown],
	): [BookingDraftCandidate, BookingDraftCandidate] {
		const first = this.parseInput(BookingDraftCandidateSchema, value[0]);
		const second = this.parseInput(BookingDraftCandidateSchema, value[1]);
		if (
			first.candidateId === second.candidateId ||
			sameSlot(first.meetingSlot, second.meetingSlot)
		) {
			throw new BookingDraftError("INVALID_INPUT");
		}
		return [first, second];
	}

	private assertBookingMatches(
		draft: InternalBookingDraft,
		bookingId: string,
	): void {
		const row = this.database
			.select()
			.from(bookings)
			.where(
				and(
					eq(bookings.id, bookingId),
					eq(bookings.conversationId, draft.conversationId),
				),
			)
			.get();
		if (row === undefined || draft.selectedCandidate === null) {
			throw new BookingDraftError("BOOKING_MISMATCH");
		}
		const accepted = this.acceptedFacts(draft.conversationId);
		let contacts: Contact[];
		try {
			contacts = BookingContactsSchema.parse(JSON.parse(row.contactsJson));
		} catch {
			throw new BookingDraftError("BOOKING_MISMATCH");
		}
		const expectedContacts = this.approvedContacts(draft.conversationId);
		const contactsMatch =
			contacts.length === expectedContacts.length &&
			contacts.every((contact) =>
				expectedContacts.some(
					(expected) =>
						expected.channel === contact.channel &&
						expected.value === contact.value,
				),
			);
		if (
			row.status !== "booked" ||
			row.name !== accepted.name ||
			row.company !== accepted.company ||
			row.meetingStartAt === null ||
			row.meetingEndAt === null ||
			row.meetingTimeZone === null ||
			!sameSlot(draft.selectedCandidate.meetingSlot, {
				startAt: row.meetingStartAt,
				endAt: row.meetingEndAt,
				timeZone: row.meetingTimeZone,
				durationMinutes: 20,
			}) ||
			!contactsMatch
		) {
			throw new BookingDraftError("BOOKING_MISMATCH");
		}
	}
}
