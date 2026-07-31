export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
	failureThreshold: number;
	cooldownMs: number;
	now: () => number;
}

/** Small deterministic circuit breaker shared by the two OpenRouter voice paths. */
export class OpenRouterCircuitBreaker {
	#consecutiveFailures = 0;
	#openUntil = 0;
	#probeInFlight = false;
	#state: CircuitState = "closed";
	readonly #options: CircuitBreakerOptions;

	constructor(options: CircuitBreakerOptions) {
		this.#options = options;
	}

	get state(): CircuitState {
		if (this.#state === "open" && this.#options.now() >= this.#openUntil) {
			return "half-open";
		}
		return this.#state;
	}

	/** Returns false while open or while another caller owns the half-open probe. */
	tryAcquire(): boolean {
		if (this.#state === "closed") return true;
		if (this.#state === "open" && this.#options.now() >= this.#openUntil) {
			this.#state = "half-open";
		}
		if (this.#state === "half-open" && !this.#probeInFlight) {
			this.#probeInFlight = true;
			return true;
		}
		return false;
	}

	recordSuccess(): void {
		this.#consecutiveFailures = 0;
		this.#openUntil = 0;
		this.#probeInFlight = false;
		this.#state = "closed";
	}

	/** Count one exhausted logical provider request, not each internal attempt. */
	recordFailure(options: { retryable: boolean; forceOpen?: boolean }): void {
		const wasProbe = this.#state === "half-open";
		this.#probeInFlight = false;
		if (options.forceOpen || wasProbe) {
			this.#open();
			return;
		}
		if (!options.retryable) return;
		this.#consecutiveFailures += 1;
		if (this.#consecutiveFailures >= this.#options.failureThreshold) {
			this.#open();
		}
	}

	/** An aborted half-open probe must not leave the circuit permanently occupied. */
	cancelProbe(): void {
		if (this.#state === "half-open" && this.#probeInFlight) this.#open();
	}

	#open(): void {
		this.#state = "open";
		this.#probeInFlight = false;
		this.#openUntil = this.#options.now() + this.#options.cooldownMs;
	}
}
