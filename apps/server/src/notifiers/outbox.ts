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

export interface PollingNotificationWorkerOptions {
	pollIntervalMs?: number;
	batchLimit?: number;
	drainTimeoutMs?: number;
	schedule?: (callback: () => void, delayMs: number) => unknown;
	cancel?: (handle: unknown) => void;
	workerOptions?: NotificationOutboxWorkerOptions;
}

/** Continuously drains persisted outbox rows without overlapping poll cycles. */
export class PollingNotificationWorker {
	readonly #worker: NotificationOutboxWorker;
	readonly #notifier: NamedLeadNotifier;
	readonly #pollIntervalMs: number;
	readonly #batchLimit: number;
	readonly #drainTimeoutMs: number;
	readonly #schedule: (callback: () => void, delayMs: number) => unknown;
	readonly #cancel: (handle: unknown) => void;
	#timer: unknown = null;
	#inFlight: Promise<void> | null = null;
	#running = false;
	#healthy = true;

	constructor(
		database: DomainDatabase,
		notifier: NamedLeadNotifier,
		options: PollingNotificationWorkerOptions = {},
	) {
		this.#worker = new NotificationOutboxWorker(
			database,
			notifier,
			options.workerOptions,
		);
		this.#notifier = notifier;
		this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
		this.#batchLimit = options.batchLimit ?? 20;
		this.#drainTimeoutMs = options.drainTimeoutMs ?? 6_000;
		this.#schedule =
			options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
		this.#cancel =
			options.cancel ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#arm(0);
	}

	async stop(): Promise<void> {
		if (!this.#running && !this.#inFlight) return;
		this.#running = false;
		if (this.#timer !== null) this.#cancel(this.#timer);
		this.#timer = null;
		await Promise.resolve(this.#notifier.close?.()).catch(() => undefined);
		const inFlight = this.#inFlight;
		if (inFlight) await settleWithin(inFlight, this.#drainTimeoutMs);
	}

	get ready(): boolean {
		return this.#running && this.#healthy;
	}

	#arm(delayMs: number): void {
		if (!this.#running || this.#timer !== null || this.#inFlight) return;
		this.#timer = this.#schedule(() => {
			this.#timer = null;
			if (!this.#running) return;
			const cycle = this.#runCycle();
			this.#inFlight = cycle;
			void cycle.finally(() => {
				if (this.#inFlight === cycle) this.#inFlight = null;
				this.#arm(this.#pollIntervalMs);
			});
		}, delayMs);
		(this.#timer as { unref?: () => void } | null)?.unref?.();
	}

	async #runCycle(): Promise<void> {
		try {
			for (
				let index = 0;
				index < this.#batchLimit && this.#running;
				index += 1
			) {
				const result = await this.#worker.processDue(1);
				if (result.length === 0) break;
			}
			this.#healthy = true;
		} catch {
			this.#healthy = false;
		}
	}
}

async function settleWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.then(
			() => undefined,
			() => undefined,
		),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
