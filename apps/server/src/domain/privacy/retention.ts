import type { DomainDatabase } from "../../db/database";

const DAY_MS = 86_400_000;

export interface TranscriptRetentionOptions {
	retentionDays: number;
	now?: () => Date;
	batchSize?: number;
	maxBatchesPerRun?: number;
	intervalMs?: number;
	schedule?: (callback: () => void, delayMs: number) => unknown;
	cancel?: (handle: unknown) => void;
}

/** Deletes only transcript-bearing turn rows; conversations and bookings remain. */
export function purgeExpiredTranscriptTurns(
	database: DomainDatabase,
	input: { cutoff: Date; limit: number },
): number {
	if (
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 10_000
	) {
		throw new RangeError("Transcript purge limit is invalid");
	}
	return database.transaction(
		(): number =>
			database.$client.run(
				`DELETE FROM turns
				 WHERE id IN (
				   SELECT turns.id
				   FROM turns
				   INNER JOIN conversations
				     ON conversations.id = turns.conversation_id
				   WHERE COALESCE(
				     turns.completed_at,
				     conversations.ended_at,
				     conversations.started_at
				   ) < ?
				   ORDER BY COALESCE(
				     turns.completed_at,
				     conversations.ended_at,
				     conversations.started_at
				   ), turns.id
				   LIMIT ?
				 )`,
				[input.cutoff.toISOString(), input.limit],
			).changes,
		{ behavior: "immediate" },
	);
}

/** Startup plus scheduled bounded transcript-retention runner. */
export class TranscriptRetentionWorker {
	readonly #database: DomainDatabase;
	readonly #retentionDays: number;
	readonly #now: () => Date;
	readonly #batchSize: number;
	readonly #maxBatchesPerRun: number;
	readonly #intervalMs: number;
	readonly #schedule: (callback: () => void, delayMs: number) => unknown;
	readonly #cancel: (handle: unknown) => void;
	#timer: unknown = null;
	#running = false;
	#healthy = true;

	constructor(database: DomainDatabase, options: TranscriptRetentionOptions) {
		this.#database = database;
		this.#retentionDays = options.retentionDays;
		this.#now = options.now ?? (() => new Date());
		this.#batchSize = options.batchSize ?? 100;
		this.#maxBatchesPerRun = options.maxBatchesPerRun ?? 4;
		this.#intervalMs = options.intervalMs ?? 60 * 60_000;
		this.#schedule =
			options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
		this.#cancel =
			options.cancel ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	start(): number {
		if (this.#running) return 0;
		this.#running = true;
		const purged = this.runNow();
		this.#arm();
		return purged;
	}

	runNow(): number {
		const cutoff = new Date(
			this.#now().getTime() - this.#retentionDays * DAY_MS,
		);
		let total = 0;
		try {
			for (let batch = 0; batch < this.#maxBatchesPerRun; batch += 1) {
				const changed = purgeExpiredTranscriptTurns(this.#database, {
					cutoff,
					limit: this.#batchSize,
				});
				total += changed;
				if (changed < this.#batchSize) break;
			}
			this.#healthy = true;
			return total;
		} catch {
			this.#healthy = false;
			return total;
		}
	}

	stop(): void {
		this.#running = false;
		if (this.#timer !== null) this.#cancel(this.#timer);
		this.#timer = null;
	}

	get ready(): boolean {
		return this.#running && this.#healthy;
	}

	#arm(): void {
		if (!this.#running || this.#timer !== null) return;
		this.#timer = this.#schedule(() => {
			this.#timer = null;
			if (!this.#running) return;
			this.runNow();
			this.#arm();
		}, this.#intervalMs);
		(this.#timer as { unref?: () => void } | null)?.unref?.();
	}
}
