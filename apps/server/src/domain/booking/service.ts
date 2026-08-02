import {
	type AppendQualificationInput,
	AppendQualificationInputSchema,
	type AppendQualificationResult,
	AppendQualificationResultSchema,
	BookingContactsSchema,
	BookingCreatedEventSchema,
	type BookingDomainEvent,
	type BookingService,
	type BookingSnapshot,
	BookingSnapshotSchema,
	BookingUpdatedEventSchema,
	type CreateBookingInput,
	CreateBookingInputSchema,
	type CreateBookingResult,
	CreateBookingResultSchema,
	type MeetingSlot,
	MeetingSlotSchema,
	type MeetingTimePreference,
	PersistedQualificationPatchSchema,
	type QualificationPatch,
} from "@botamin/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { DomainDatabase } from "../../db/database";
import {
	bookings,
	domainEvents,
	idempotencyKeys,
	notificationOutbox,
} from "../../db/schema";
import type { NamedLeadNotifier } from "../../notifiers/notifier";
import { NotificationOutboxWorker } from "../../notifiers/outbox";
import { redactBookingEventForAudit } from "../privacy/redaction";
import {
	type Clock,
	canonicalJson,
	createEntityId,
	generateCandidateMeetingSlots,
	type IdFactory,
	isMeetingSlotBookable,
	requestHash,
} from "./support";

const CREATE_SCOPE = "booking:create";
const QUALIFICATION_SCOPE = "booking:qualification";

function createIdempotencyScope(conversationId: string): string {
	return `${CREATE_SCOPE}:${conversationId}`;
}

function qualificationIdempotencyScope(bookingId: string): string {
	return `${QUALIFICATION_SCOPE}:${bookingId}`;
}

type BookingRow = typeof bookings.$inferSelect;

export class BookingDomainError extends Error {
	constructor(
		readonly code:
			| "BOOKING_VALIDATION_FAILED"
			| "DB_UNAVAILABLE"
			| "IDEMPOTENCY_CONFLICT",
		message: string,
	) {
		super(message);
		this.name = "BookingDomainError";
	}
}

export interface BookingDomainServiceOptions {
	notifier?: NamedLeadNotifier;
	notifierKind?: string;
	now?: Clock;
	idFactory?: IdFactory;
}

interface CommittedOperation<T> {
	result: T;
	eventId?: string;
}

function persistedQualification(qualificationJson: string): QualificationPatch {
	return PersistedQualificationPatchSchema.parse(JSON.parse(qualificationJson));
}

function bookingSnapshot(row: BookingRow): BookingSnapshot {
	if (
		row.company === null ||
		row.meetingStartAt === null ||
		row.meetingEndAt === null ||
		row.meetingTimeZone === null
	) {
		throw new BookingDomainError(
			"BOOKING_VALIDATION_FAILED",
			"Stored booking does not contain a complete internal meeting slot",
		);
	}
	return BookingSnapshotSchema.parse({
		id: row.id,
		conversationId: row.conversationId,
		status: row.status,
		name: row.name,
		contacts: BookingContactsSchema.parse(JSON.parse(row.contactsJson)),
		company: row.company,
		meetingSlot: MeetingSlotSchema.parse({
			startAt: row.meetingStartAt,
			endAt: row.meetingEndAt,
			timeZone: row.meetingTimeZone,
			durationMinutes: 20,
		}),
		qualification: persistedQualification(row.qualificationJson),
		qualificationStatus: row.qualificationStatus,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	});
}

export class SqliteBookingService implements BookingService {
	private readonly now: Clock;
	private readonly idFactory: IdFactory;
	private readonly notifierKind: string;
	private readonly outboxWorker: NotificationOutboxWorker | undefined;

	constructor(
		private readonly database: DomainDatabase,
		options: BookingDomainServiceOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.idFactory = options.idFactory ?? createEntityId;
		this.notifierKind =
			options.notifier?.kind ?? options.notifierKind ?? "console";
		this.outboxWorker = options.notifier
			? new NotificationOutboxWorker(database, options.notifier, {
					now: this.now,
				})
			: undefined;
	}

	/**
	 * Returns two deterministic internal candidates, excluding slots committed
	 * at query time. This does not reserve a slot or assert external availability.
	 */
	async candidateMeetingSlots(
		preference: MeetingTimePreference = "none",
	): Promise<[MeetingSlot, MeetingSlot]> {
		const now = this.now();
		const unavailable = new Set<string>();
		while (true) {
			const candidates = generateCandidateMeetingSlots(
				now,
				unavailable,
				preference,
			);
			const committed = this.database
				.select({ startAt: bookings.meetingStartAt })
				.from(bookings)
				.where(
					inArray(
						bookings.meetingStartAt,
						candidates.map((slot) => slot.startAt),
					),
				)
				.all();
			if (committed.length === 0) return candidates;
			for (const row of committed) {
				if (row.startAt !== null) unavailable.add(row.startAt);
			}
		}
	}

	async createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
		const parsed = this.parseCreateInput(input);
		const hash = requestHash(parsed);
		const idempotencyScope = createIdempotencyScope(parsed.conversationId);
		const committed = this.database.transaction(
			(transaction): CommittedOperation<CreateBookingResult> => {
				const replay = transaction
					.select()
					.from(idempotencyKeys)
					.where(
						and(
							eq(idempotencyKeys.scope, idempotencyScope),
							eq(idempotencyKeys.key, parsed.idempotencyKey),
						),
					)
					.get();
				if (replay !== undefined) {
					this.assertSameRequest(replay.requestHash, hash);
					const stored = CreateBookingResultSchema.parse(
						JSON.parse(replay.resultJson),
					);
					return { result: { ...stored, created: false } };
				}

				const existing = transaction
					.select()
					.from(bookings)
					.where(eq(bookings.conversationId, parsed.conversationId))
					.get();
				if (existing !== undefined) {
					bookingSnapshot(existing);
					const result = CreateBookingResultSchema.parse({
						ok: true,
						created: false,
						bookingId: existing.id,
						status: "booked",
						createdAt: existing.createdAt,
					});
					transaction
						.insert(idempotencyKeys)
						.values({
							scope: idempotencyScope,
							key: parsed.idempotencyKey,
							requestHash: hash,
							resultJson: canonicalJson(result),
							conversationId: parsed.conversationId,
							bookingId: existing.id,
							createdAt: this.now().toISOString(),
						})
						.run();
					return { result };
				}

				const now = this.now();
				if (!isMeetingSlotBookable(parsed.meetingSlot, now)) {
					throw new BookingDomainError(
						"BOOKING_VALIDATION_FAILED",
						"Meeting slot is not bookable for the current server clock",
					);
				}
				const occupied = transaction
					.select({ id: bookings.id })
					.from(bookings)
					.where(eq(bookings.meetingStartAt, parsed.meetingSlot.startAt))
					.get();
				if (occupied !== undefined) {
					throw new BookingDomainError(
						"BOOKING_VALIDATION_FAILED",
						"Meeting slot is no longer available internally",
					);
				}
				const timestamp = now.toISOString();
				const bookingId = this.idFactory();
				const eventId = this.idFactory();
				transaction
					.insert(bookings)
					.values({
						id: bookingId,
						conversationId: parsed.conversationId,
						status: "booked",
						name: parsed.name,
						contactsJson: canonicalJson(parsed.contacts),
						company: parsed.company,
						meetingStartAt: parsed.meetingSlot.startAt,
						meetingEndAt: parsed.meetingSlot.endAt,
						meetingTimeZone: parsed.meetingSlot.timeZone,
						qualificationJson: "{}",
						qualificationStatus: "none",
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();

				const event = BookingCreatedEventSchema.parse({
					v: 1,
					type: "booking.created",
					eventId,
					occurredAt: timestamp,
					data: {
						bookingId,
						conversationId: parsed.conversationId,
						name: parsed.name,
						contacts: parsed.contacts,
						company: parsed.company,
						meetingSlot: parsed.meetingSlot,
						status: "booked",
						qualificationStatus: "none",
					},
				});
				this.insertEventAndOutbox(transaction, event, timestamp);

				const result = CreateBookingResultSchema.parse({
					ok: true,
					created: true,
					bookingId,
					status: "booked",
					createdAt: timestamp,
				});
				transaction
					.insert(idempotencyKeys)
					.values({
						scope: idempotencyScope,
						key: parsed.idempotencyKey,
						requestHash: hash,
						resultJson: canonicalJson(result),
						conversationId: parsed.conversationId,
						bookingId,
						createdAt: timestamp,
					})
					.run();
				return { result, eventId };
			},
			{ behavior: "immediate" },
		);
		await this.deliverAfterCommit(committed.eventId);
		return committed.result;
	}

	async appendQualification(
		input: AppendQualificationInput,
	): Promise<AppendQualificationResult> {
		const parsed = this.parseQualificationInput(input);
		const hash = requestHash(parsed);
		const idempotencyScope = qualificationIdempotencyScope(parsed.bookingId);
		const committed = this.database.transaction(
			(transaction): CommittedOperation<AppendQualificationResult> => {
				const replay = transaction
					.select()
					.from(idempotencyKeys)
					.where(
						and(
							eq(idempotencyKeys.scope, idempotencyScope),
							eq(idempotencyKeys.key, parsed.idempotencyKey),
						),
					)
					.get();
				if (replay !== undefined) {
					this.assertSameRequest(replay.requestHash, hash);
					return {
						result: AppendQualificationResultSchema.parse(
							JSON.parse(replay.resultJson),
						),
					};
				}

				const existing = transaction
					.select()
					.from(bookings)
					.where(eq(bookings.id, parsed.bookingId))
					.get();
				if (existing === undefined || existing.status !== "booked") {
					throw new BookingDomainError(
						"BOOKING_VALIDATION_FAILED",
						"Qualification requires an existing booked booking",
					);
				}
				const current = bookingSnapshot(existing).qualification ?? {};
				const merged: QualificationPatch = { ...current, ...parsed.patch };
				const updatedFields = Object.keys(parsed.patch).sort();
				const timestamp = this.now().toISOString();
				transaction
					.update(bookings)
					.set({
						qualificationJson: canonicalJson(merged),
						qualificationStatus: parsed.completion,
						updatedAt: timestamp,
					})
					.where(eq(bookings.id, existing.id))
					.run();

				const eventId = this.idFactory();
				const event = BookingUpdatedEventSchema.parse({
					v: 1,
					type: "booking.updated",
					eventId,
					occurredAt: timestamp,
					data: {
						bookingId: existing.id,
						conversationId: existing.conversationId,
						qualificationStatus: parsed.completion,
						qualification: merged,
					},
				});
				this.insertEventAndOutbox(transaction, event, timestamp);

				const result = AppendQualificationResultSchema.parse({
					ok: true,
					bookingId: existing.id,
					qualificationStatus: parsed.completion,
					updatedFields,
					updatedAt: timestamp,
				});
				transaction
					.insert(idempotencyKeys)
					.values({
						scope: idempotencyScope,
						key: parsed.idempotencyKey,
						requestHash: hash,
						resultJson: canonicalJson(result),
						conversationId: existing.conversationId,
						bookingId: existing.id,
						createdAt: timestamp,
					})
					.run();
				return { result, eventId };
			},
			{ behavior: "immediate" },
		);
		await this.deliverAfterCommit(committed.eventId);
		return committed.result;
	}

	async findByConversationId(
		conversationId: string,
	): Promise<BookingSnapshot | null> {
		const row = this.database
			.select()
			.from(bookings)
			.where(eq(bookings.conversationId, conversationId))
			.get();
		return row === undefined ? null : bookingSnapshot(row);
	}

	async findById(bookingId: string): Promise<BookingSnapshot | null> {
		const row = this.database
			.select()
			.from(bookings)
			.where(eq(bookings.id, bookingId))
			.get();
		return row === undefined ? null : bookingSnapshot(row);
	}

	private parseCreateInput(input: CreateBookingInput) {
		const parsed = CreateBookingInputSchema.safeParse(input);
		if (!parsed.success) {
			throw new BookingDomainError(
				"BOOKING_VALIDATION_FAILED",
				"Booking input failed contract validation",
			);
		}
		return parsed.data;
	}

	private parseQualificationInput(input: AppendQualificationInput) {
		const parsed = AppendQualificationInputSchema.safeParse(input);
		if (!parsed.success) {
			throw new BookingDomainError(
				"BOOKING_VALIDATION_FAILED",
				"Qualification input failed contract validation",
			);
		}
		return parsed.data;
	}

	private assertSameRequest(storedHash: string, incomingHash: string): void {
		if (storedHash !== incomingHash) {
			throw new BookingDomainError(
				"IDEMPOTENCY_CONFLICT",
				"Idempotency key was already used for a different request",
			);
		}
	}

	private insertEventAndOutbox(
		transaction: Parameters<Parameters<DomainDatabase["transaction"]>[0]>[0],
		event: BookingDomainEvent,
		timestamp: string,
	): void {
		transaction
			.insert(domainEvents)
			.values({
				id: event.eventId,
				conversationId: event.data.conversationId,
				bookingId: event.data.bookingId,
				type: event.type,
				payloadJson: canonicalJson(redactBookingEventForAudit(event)),
				createdAt: timestamp,
			})
			.run();
		transaction
			.insert(notificationOutbox)
			.values({
				id: this.idFactory(),
				eventId: event.eventId,
				notifierKind: this.notifierKind,
				payloadJson: canonicalJson(event),
				status: "pending",
				attemptCount: 0,
				nextAttemptAt: timestamp,
				createdAt: timestamp,
			})
			.run();
	}

	private async deliverAfterCommit(eventId: string | undefined): Promise<void> {
		if (eventId !== undefined && this.outboxWorker !== undefined) {
			await this.outboxWorker.processEvent(eventId);
		}
	}
}
