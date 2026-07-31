import { eq, inArray, or } from "drizzle-orm";
import type { DomainDatabase } from "../../db/database";
import {
	bookings,
	conversations,
	domainEvents,
	idempotencyKeys,
	notificationOutbox,
	turns,
} from "../../db/schema";
import {
	type Clock,
	canonicalJson,
	createEntityId,
	type IdFactory,
} from "../booking/support";

export interface DeletionResult {
	conversationId: string;
	deleted: boolean;
	deletedBookings: number;
	deletedTurns: number;
	deletedOutboxEntries: number;
	auditEventId?: string;
}

export class LeadDataDeletionService {
	private readonly now: Clock;
	private readonly idFactory: IdFactory;

	constructor(
		private readonly database: DomainDatabase,
		options: { now?: Clock; idFactory?: IdFactory } = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.idFactory = options.idFactory ?? createEntityId;
	}

	deleteConversation(conversationId: string): DeletionResult {
		return this.database.transaction(
			(transaction): DeletionResult => {
				const conversation = transaction
					.select({ id: conversations.id })
					.from(conversations)
					.where(eq(conversations.id, conversationId))
					.get();
				const bookingRows = transaction
					.select({ id: bookings.id })
					.from(bookings)
					.where(eq(bookings.conversationId, conversationId))
					.all();
				const turnRows = transaction
					.select({ id: turns.id })
					.from(turns)
					.where(eq(turns.conversationId, conversationId))
					.all();
				if (conversation === undefined && bookingRows.length === 0) {
					return {
						conversationId,
						deleted: false,
						deletedBookings: 0,
						deletedTurns: 0,
						deletedOutboxEntries: 0,
					};
				}

				const eventRows = transaction
					.select({ id: domainEvents.id })
					.from(domainEvents)
					.where(eq(domainEvents.conversationId, conversationId))
					.all();
				const eventIds = eventRows.map((row) => row.id);
				let deletedOutboxEntries = 0;
				if (eventIds.length > 0) {
					deletedOutboxEntries = transaction
						.select({ id: notificationOutbox.id })
						.from(notificationOutbox)
						.where(inArray(notificationOutbox.eventId, eventIds))
						.all().length;
					transaction
						.delete(notificationOutbox)
						.where(inArray(notificationOutbox.eventId, eventIds))
						.run();
				}

				const bookingIds = bookingRows.map((row) => row.id);
				transaction
					.delete(idempotencyKeys)
					.where(
						bookingIds.length === 0
							? eq(idempotencyKeys.conversationId, conversationId)
							: or(
									eq(idempotencyKeys.conversationId, conversationId),
									inArray(idempotencyKeys.bookingId, bookingIds),
								),
					)
					.run();
				transaction
					.delete(turns)
					.where(eq(turns.conversationId, conversationId))
					.run();
				transaction
					.delete(bookings)
					.where(eq(bookings.conversationId, conversationId))
					.run();
				transaction
					.delete(conversations)
					.where(eq(conversations.id, conversationId))
					.run();

				const timestamp = this.now().toISOString();
				const auditEventId = this.idFactory();
				transaction
					.insert(domainEvents)
					.values({
						id: auditEventId,
						conversationId,
						bookingId: null,
						type: "privacy.deleted",
						payloadJson: canonicalJson({
							v: 1,
							type: "privacy.deleted",
							eventId: auditEventId,
							occurredAt: timestamp,
							data: {
								conversationId,
								deletedBookingCount: bookingRows.length,
								deletedTurnCount: turnRows.length,
							},
						}),
						createdAt: timestamp,
					})
					.run();
				return {
					conversationId,
					deleted: true,
					deletedBookings: bookingRows.length,
					deletedTurns: turnRows.length,
					deletedOutboxEntries,
					auditEventId,
				};
			},
			{ behavior: "immediate" },
		);
	}
}
