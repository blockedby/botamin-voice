export type MonotonicClock = () => number;

/**
 * Process-local monotonic milliseconds for elapsed-time measurements.
 * Bun exposes nanoseconds from its monotonic process clock; performance.now()
 * is the portable fallback for non-Bun test/tooling runtimes.
 */
export function monotonicNowMs(): number {
	if (typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function") {
		return Bun.nanoseconds() / 1_000_000;
	}
	return performance.now();
}
