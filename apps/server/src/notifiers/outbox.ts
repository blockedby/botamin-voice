import { BookingDomainEventSchema } from "@botamin/contracts";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { DomainDatabase } from "../db/database";
import { notificationOutbox } from "../db/schema";
import {
	type Clock,
	createEntityId,
	type IdFactory,
} from "../domain/booking/support";
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
	claimToken: string;
}

export interface NotificationOutboxWorkerOptions {
	now?: Clock;
	leaseMs?: number;
	claimTokenFactory?: IdFactory;
}

export class NotificationOutboxWorker {
	private readonly now: Clock;
	private readonly leaseMs: number;
	private readonly claimTokenFactory: IdFactory;

	constructor(
		private readonly database: DomainDatabase,
		private readonly notifier: NamedLeadNotifier,
		options: NotificationOutboxWorkerOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.leaseMs = options.leaseMs ?? 30_000;
		this.claimTokenFactory = options.claimTokenFactory ?? createEntityId;
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
			const completion = this.database.$client.run(
				`UPDATE notification_outbox
				 SET last_error = NULL, sent_at = ?, status = 'sent', claim_token = NULL
				 WHERE id = ? AND claim_token = ? AND status = 'pending'`,
				[this.now().toISOString(), claimed.id, claimed.claimToken],
			);
			return { eventId, delivered: completion.changes === 1 };
		} catch (error) {
			const retryDelayMs = Math.min(
				60_000,
				1_000 * 2 ** (claimed.attemptCount - 1),
			);
			const failure = this.database.$client.run(
				`UPDATE notification_outbox
				 SET last_error = ?, next_attempt_at = ?, status = 'failed', claim_token = NULL
				 WHERE id = ? AND claim_token = ? AND status = 'pending'`,
				[
					safeOperationalError(error),
					new Date(this.now().getTime() + retryDelayMs).toISOString(),
					claimed.id,
					claimed.claimToken,
				],
			);
			if (failure.changes !== 1) {
				return { eventId, delivered: false };
			}
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
				const claimToken = this.claimTokenFactory();
				transaction
					.update(notificationOutbox)
					.set({
						attemptCount,
						claimToken,
						nextAttemptAt: new Date(now.getTime() + this.leaseMs).toISOString(),
						status: "pending",
					})
					.where(eq(notificationOutbox.id, row.id))
					.run();
				return {
					id: row.id,
					payloadJson: row.payloadJson,
					attemptCount,
					claimToken,
				};
			},
			{ behavior: "immediate" },
		);
	}
}
