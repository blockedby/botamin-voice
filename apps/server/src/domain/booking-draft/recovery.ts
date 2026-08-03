import type { BookingService } from "@botamin/contracts";
import type { DomainDatabase } from "../../db/database";
import { BookingDraftError, type BookingDraftStore } from "./store";

export interface OrphanRecoverySweepResult {
	readonly scanned: number;
	readonly recovered: number;
	readonly ignored: number;
	readonly invalid: number;
	readonly transientFailures: number;
	readonly pending: boolean;
}

export interface OrphanRecoveryWorkerOptions {
	readonly batchSize: number;
	readonly maxPerSweep: number;
	readonly intervalMs: number;
	readonly onSweep?: (result: OrphanRecoverySweepResult) => void;
}

type CandidateRow = { conversationId: string; revision: number };
type CandidateOutcome = "recovered" | "ignored" | "invalid" | "transient";

const EMPTY_RESULT: OrphanRecoverySweepResult = {
	scanned: 0,
	recovered: 0,
	ignored: 0,
	invalid: 0,
	transientFailures: 0,
	pending: false,
};

/**
 * Bounded durable recovery for booking drafts orphaned after markCommitting.
 * Enumeration returns IDs and revisions only; complete drafts are parsed and
 * validated by BookingDraftStore one at a time and never enter logs/telemetry.
 */
export class OrphanBookingRecoveryWorker {
	readonly #batchSize: number;
	readonly #maxPerSweep: number;
	readonly #intervalMs: number;
	readonly #onSweep: ((result: OrphanRecoverySweepResult) => void) | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#running: Promise<OrphanRecoverySweepResult> | undefined;
	#stopped = false;
	#startupComplete = false;
	#cursor = "";
	#latest: OrphanRecoverySweepResult = EMPTY_RESULT;

	constructor(
		private readonly database: DomainDatabase,
		private readonly store: BookingDraftStore,
		private readonly bookings: BookingService,
		options: OrphanRecoveryWorkerOptions,
	) {
		this.#batchSize = boundedInteger(options.batchSize, 1, 100);
		this.#maxPerSweep = boundedInteger(options.maxPerSweep, 1, 1_000);
		this.#intervalMs = boundedInteger(options.intervalMs, 10, 86_400_000);
		this.#onSweep = options.onSweep;
	}

	get startupComplete(): boolean {
		return this.#startupComplete;
	}

	get latest(): OrphanRecoverySweepResult {
		return { ...this.#latest };
	}

	async runStartup(): Promise<OrphanRecoverySweepResult> {
		const result = await this.sweep();
		this.#startupComplete = true;
		return result;
	}

	start(): void {
		if (this.#timer !== undefined || this.#stopped) return;
		this.#timer = setInterval(() => {
			void this.sweep();
		}, this.#intervalMs);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		await this.#running;
	}

	sweep(): Promise<OrphanRecoverySweepResult> {
		if (this.#stopped) return Promise.resolve(this.latest);
		if (this.#running) return this.#running;
		this.#running = this.#runSweep()
			.catch(() => ({
				...EMPTY_RESULT,
				transientFailures: 1,
				pending: true,
			}))
			.then((result) => {
				this.#latest = result;
				this.#onSweep?.({ ...result });
				return result;
			})
			.finally(() => {
				this.#running = undefined;
			});
		return this.#running;
	}

	async #runSweep(): Promise<OrphanRecoverySweepResult> {
		let afterId = this.#cursor;
		let scanned = 0;
		let recovered = 0;
		let ignored = 0;
		let invalid = 0;
		let transientFailures = 0;

		while (scanned < this.#maxPerSweep) {
			const remaining = this.#maxPerSweep - scanned;
			const rows = this.#candidates(
				afterId,
				Math.min(this.#batchSize, remaining),
			);
			if (rows.length === 0) break;
			for (const row of rows) {
				afterId = row.conversationId;
				scanned += 1;
				const outcome = await this.#recover(row);
				if (outcome === "recovered") recovered += 1;
				else if (outcome === "ignored") ignored += 1;
				else if (outcome === "invalid") invalid += 1;
				else transientFailures += 1;
			}
			if (rows.length < Math.min(this.#batchSize, remaining)) break;
		}

		const following = this.#candidates(afterId, 1).length > 0;
		if (following) this.#cursor = afterId;
		else this.#cursor = "";
		// Once the cursor reaches the end, wrap so an earlier transient row is
		// retried without starving later IDs on every bounded sweep.
		const pending = following || this.#candidates("", 1).length > 0;
		return {
			scanned,
			recovered,
			ignored,
			invalid,
			transientFailures,
			pending,
		};
	}

	#candidates(afterId: string, limit: number): CandidateRow[] {
		return this.database.$client
			.query<{ conversation_id: string; revision: number }, [string, number]>(
				`SELECT conversation_id, revision
				 FROM conversation_contexts
				 WHERE conversation_id > ?
				   AND CASE WHEN json_valid(draft_json)
				     THEN json_extract(draft_json, '$.commitStatus')
				     ELSE NULL
				   END = 'committing'
				 ORDER BY conversation_id
				 LIMIT ?`,
			)
			.all(afterId, limit)
			.map((row) => ({
				conversationId: row.conversation_id,
				revision: row.revision,
			}));
	}

	async #recover(row: CandidateRow): Promise<CandidateOutcome> {
		try {
			let draft = this.store.load(row.conversationId);
			if (
				draft === null ||
				draft.revision !== row.revision ||
				draft.commitStatus !== "committing"
			) {
				return "ignored";
			}
			draft = this.store.reconcile(row.conversationId);
			if (draft.commitStatus === "committed") return "recovered";
			if (draft.commitStatus !== "committing") return "ignored";

			const input = this.store.committingBookingInput(row.conversationId);
			const result = await this.bookings.createBooking(input);
			const booking = await this.bookings.findByConversationId(
				row.conversationId,
			);
			if (booking === null || booking.id !== result.bookingId) return "invalid";
			draft = this.store.reconcile(row.conversationId);
			return draft.commitStatus === "committed" &&
				draft.bookingId === booking.id
				? "recovered"
				: "invalid";
		} catch (error) {
			try {
				const current = this.store.load(row.conversationId);
				if (current?.commitStatus === "committed") return "recovered";
				if (
					current === null ||
					current.revision !== row.revision ||
					current.commitStatus !== "committing"
				) {
					return "ignored";
				}
			} catch {
				return "invalid";
			}
			return isInvalidRecoveryError(error) ? "invalid" : "transient";
		}
	}
}

function isInvalidRecoveryError(error: unknown): boolean {
	if (error instanceof BookingDraftError) return true;
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error.code === "BOOKING_VALIDATION_FAILED" ||
			error.code === "IDEMPOTENCY_CONFLICT")
	);
}

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new TypeError("Invalid orphan recovery bound");
	}
	return value;
}
