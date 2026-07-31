export type BrainTurnPriority = "booked" | "standard";

export type BrainTurnAdmission =
	| { ok: true; release(): void }
	| {
			ok: false;
			reason: "cancelled" | "closed" | "overflow" | "timeout";
	  };

export interface BrainTurnQueueOptions {
	maxActive: number;
	maxPending: number;
	queueTimeoutMs: number;
}

interface PendingTurn {
	priority: BrainTurnPriority;
	signal: AbortSignal;
	resolve(result: BrainTurnAdmission): void;
	timer: ReturnType<typeof setTimeout>;
	onAbort(): void;
	settled: boolean;
}

/**
 * Global bounded turn admission. Already-booked conversations use the booked
 * lane; each lane is FIFO and the booked lane is selected first so committed
 * booking follow-up is not stranded behind pre-booking work.
 */
export class BrainTurnQueue {
	readonly #maxActive: number;
	readonly #maxPending: number;
	readonly #queueTimeoutMs: number;
	readonly #booked: PendingTurn[] = [];
	readonly #standard: PendingTurn[] = [];
	#active = 0;
	#closed = false;

	constructor(options: BrainTurnQueueOptions) {
		this.#maxActive = options.maxActive;
		this.#maxPending = options.maxPending;
		this.#queueTimeoutMs = options.queueTimeoutMs;
	}

	acquire(input: {
		priority: BrainTurnPriority;
		signal: AbortSignal;
	}): Promise<BrainTurnAdmission> {
		if (this.#closed) return Promise.resolve({ ok: false, reason: "closed" });
		if (input.signal.aborted) {
			return Promise.resolve({ ok: false, reason: "cancelled" });
		}
		if (this.#active < this.#maxActive && this.pendingCount === 0) {
			return Promise.resolve(this.#grant());
		}
		if (this.pendingCount >= this.#maxPending) {
			return Promise.resolve({ ok: false, reason: "overflow" });
		}

		return new Promise<BrainTurnAdmission>((resolve) => {
			const pending = {} as PendingTurn;
			pending.priority = input.priority;
			pending.signal = input.signal;
			pending.resolve = resolve;
			pending.settled = false;
			pending.onAbort = () => this.#settlePending(pending, "cancelled");
			pending.timer = setTimeout(
				() => this.#settlePending(pending, "timeout"),
				this.#queueTimeoutMs,
			);
			pending.timer.unref?.();
			input.signal.addEventListener("abort", pending.onAbort, { once: true });
			this.#lane(input.priority).push(pending);
			this.#dispatch();
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of [...this.#booked, ...this.#standard]) {
			this.#settlePending(pending, "closed");
		}
	}

	get activeCount(): number {
		return this.#active;
	}

	get pendingCount(): number {
		return this.#booked.length + this.#standard.length;
	}

	get hasPendingCapacity(): boolean {
		return !this.#closed && this.pendingCount < this.#maxPending;
	}

	get hasAdmissionCapacity(): boolean {
		return (
			!this.#closed &&
			(this.#active < this.#maxActive || this.pendingCount < this.#maxPending)
		);
	}

	#lane(priority: BrainTurnPriority): PendingTurn[] {
		return priority === "booked" ? this.#booked : this.#standard;
	}

	#grant(): Extract<BrainTurnAdmission, { ok: true }> {
		this.#active += 1;
		let released = false;
		return {
			ok: true,
			release: () => {
				if (released) return;
				released = true;
				this.#active = Math.max(0, this.#active - 1);
				this.#dispatch();
			},
		};
	}

	#dispatch(): void {
		while (!this.#closed && this.#active < this.#maxActive) {
			const pending = this.#booked.shift() ?? this.#standard.shift();
			if (!pending) return;
			if (pending.settled) continue;
			pending.settled = true;
			clearTimeout(pending.timer);
			pending.signal.removeEventListener("abort", pending.onAbort);
			if (pending.signal.aborted) {
				pending.resolve({ ok: false, reason: "cancelled" });
				continue;
			}
			pending.resolve(this.#grant());
		}
	}

	#settlePending(
		pending: PendingTurn,
		reason: "cancelled" | "closed" | "timeout",
	): void {
		if (pending.settled) return;
		pending.settled = true;
		clearTimeout(pending.timer);
		pending.signal.removeEventListener("abort", pending.onAbort);
		const lane = this.#lane(pending.priority);
		const index = lane.indexOf(pending);
		if (index >= 0) lane.splice(index, 1);
		pending.resolve({ ok: false, reason });
		this.#dispatch();
	}
}
