import { describe, expect, test } from "bun:test";
import { OpenRouterCircuitBreaker } from "./circuit";

describe("OpenRouter circuit state transitions", () => {
	test("stays open while idle after cooldown and enters half-open only on acquisition", () => {
		let now = 0;
		const circuit = new OpenRouterCircuitBreaker({
			failureThreshold: 1,
			cooldownMs: 10,
			now: () => now,
		});
		expect(circuit.tryAcquire()).toBe(true);
		circuit.recordFailure({ retryable: true });
		expect(circuit.state).toBe("open");

		now = 11;
		expect(circuit.state).toBe("open");
		expect(circuit.tryAcquire()).toBe(true);
		expect(circuit.state).toBe("half-open");
		expect(circuit.tryAcquire()).toBe(false);
		circuit.recordSuccess();
		expect(circuit.state).toBe("closed");
	});

	test("reopens a failed half-open probe", () => {
		let now = 0;
		const circuit = new OpenRouterCircuitBreaker({
			failureThreshold: 1,
			cooldownMs: 10,
			now: () => now,
		});
		circuit.recordFailure({ retryable: true });
		now = 11;
		expect(circuit.tryAcquire()).toBe(true);
		expect(circuit.state).toBe("half-open");
		circuit.recordFailure({ retryable: false });
		expect(circuit.state).toBe("open");
	});
});
