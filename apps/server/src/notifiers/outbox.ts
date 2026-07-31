import { BookingDomainEventSchema } from "@botamin/contracts";
import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";
import type { DomainDatabase } from "../db/database";
import { notificationOutbox } from "../db/schema";
import type { Clock } from "../domain/booking/support";
import { safeOperationalError } from "../domain/privacy/redaction";
import type { NamedLeadNotifier } from "./notifier";

export interface OutboxDeliveryResult {
	eventId: string;
	delivered: boolean;
}

interface ClaimedNotification {
	id: string;
	payloadJson: string;
	attemptCount: number;
}

export class NotificationOutboxWorker {
	private readonly now: Clock;
	private readonly leaseMs: number;

	constructor(
		private readonly database: DomainDatabase,
		private readonly notifier: NamedLeadNotifier,
		options: { now?: Clock; leaseMs?: number } = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.leaseMs = options.leaseMs ?? 30_000;
	}

	async processEvent(eventId: string): Promise<OutboxDeliveryResult> {
		const claimed = this.claim(eventId);
		if (claimed === null) {
			const sent = this.database
				.select({ status: notificationOutbox.status })
				.from(notificationOutbox)
				.where(
					and(
						eq(notificationOutbox.eventId, eventId),
						eq(notificationOutbox.notifierKind, this.notifier.kind),
					),
				)
				.get();
			return { eventId, delivered: sent?.status === "sent" };
		}

		try {
			const event = BookingDomainEventSchema.parse(
				JSON.parse(claimed.payloadJson),
			);
			await this.notifier.publish(event);
			this.database
				.update(notificationOutbox)
				.set({
					lastError: null,
					sentAt: this.now().toISOString(),
					status: "sent",
				})
				.where(
					and(
						eq(notificationOutbox.id, claimed.id),
						eq(notificationOutbox.attemptCount, claimed.attemptCount),
						ne(notificationOutbox.status, "sent"),
					),
				)
				.run();
			return { eventId, delivered: true };
		} catch (error) {
			const retryDelayMs = Math.min(
				60_000,
				1_000 * 2 ** (claimed.attemptCount - 1),
			);
			this.database
				.update(notificationOutbox)
				.set({
					lastError: safeOperationalError(error),
					nextAttemptAt: new Date(
						this.now().getTime() + retryDelayMs,
					).toISOString(),
					status: "failed",
				})
				.where(
					and(
						eq(notificationOutbox.id, claimed.id),
						eq(notificationOutbox.attemptCount, claimed.attemptCount),
						ne(notificationOutbox.status, "sent"),
					),
				)
				.run();
			return { eventId, delivered: false };
		}
	}

	async processDue(limit = 50): Promise<OutboxDeliveryResult[]> {
		const due = this.database
			.select({ eventId: notificationOutbox.eventId })
			.from(notificationOutbox)
			.where(
				and(
					inArray(notificationOutbox.status, ["pending", "failed"]),
					lte(notificationOutbox.nextAttemptAt, this.now().toISOString()),
					eq(notificationOutbox.notifierKind, this.notifier.kind),
				),
			)
			.orderBy(asc(notificationOutbox.nextAttemptAt))
			.limit(limit)
			.all();
		const results: OutboxDeliveryResult[] = [];
		for (const row of due) {
			results.push(await this.processEvent(row.eventId));
		}
		return results;
	}

	/** Claims delivery under BEGIN IMMEDIATE; nextAttemptAt doubles as a lease. */
	private claim(eventId: string): ClaimedNotification | null {
		return this.database.transaction(
			(transaction): ClaimedNotification | null => {
				const row = transaction
					.select()
					.from(notificationOutbox)
					.where(
						and(
							eq(notificationOutbox.eventId, eventId),
							eq(notificationOutbox.notifierKind, this.notifier.kind),
						),
					)
					.get();
				const now = this.now();
				if (
					row === undefined ||
					row.status === "sent" ||
					row.nextAttemptAt > now.toISOString()
				) {
					return null;
				}
				const attemptCount = row.attemptCount + 1;
				transaction
					.update(notificationOutbox)
					.set({
						attemptCount,
						nextAttemptAt: new Date(now.getTime() + this.leaseMs).toISOString(),
						status: "pending",
					})
					.where(eq(notificationOutbox.id, row.id))
					.run();
				return { id: row.id, payloadJson: row.payloadJson, attemptCount };
			},
			{ behavior: "immediate" },
		);
	}
}
