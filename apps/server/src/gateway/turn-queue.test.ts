import { describe, expect, test } from "bun:test";
import { BrainTurnQueue } from "./turn-queue";

const signal = (): AbortSignal => new AbortController().signal;

describe("bounded cancellable brain turn queue", () => {
	test("maxPending=1 retains one waiter and safely rejects overflow", async () => {
		const queue = new BrainTurnQueue({
			maxActive: 1,
			maxPending: 1,
			queueTimeoutMs: 1_000,
		});
		const active = await queue.acquire({
			priority: "standard",
			signal: signal(),
		});
		expect(active.ok).toBe(true);
		const waiting = queue.acquire({ priority: "standard", signal: signal() });
		expect(queue.pendingCount).toBe(1);
		expect(
			await queue.acquire({ priority: "standard", signal: signal() }),
		).toEqual({ ok: false, reason: "overflow" });
		if (active.ok) active.release();
		const admitted = await waiting;
		expect(admitted.ok).toBe(true);
		if (admitted.ok) admitted.release();
		expect(queue.activeCount).toBe(0);
	});

	test("maxPending=6 is an exact bound and preserves FIFO in a lane", async () => {
		const queue = new BrainTurnQueue({
			maxActive: 1,
			maxPending: 6,
			queueTimeoutMs: 1_000,
		});
		const active = await queue.acquire({
			priority: "standard",
			signal: signal(),
		});
		const order: number[] = [];
		const pending = Array.from({ length: 6 }, (_, index) =>
			queue
				.acquire({ priority: "standard", signal: signal() })
				.then((permit) => ({ permit, index })),
		);
		expect(queue.pendingCount).toBe(6);
		expect(
			await queue.acquire({ priority: "standard", signal: signal() }),
		).toEqual({ ok: false, reason: "overflow" });
		if (active.ok) active.release();
		for (const expected of [0, 1, 2, 3, 4, 5]) {
			const next = await Promise.race(
				pending.map((entry) =>
					entry.then((value) =>
						order.includes(value.index)
							? new Promise<never>(() => undefined)
							: value,
					),
				),
			);
			order.push(next.index);
			expect(next.index).toBe(expected);
			if (next.permit.ok) next.permit.release();
		}
		expect(order).toEqual([0, 1, 2, 3, 4, 5]);
	});

	test("committed-booking lane has priority while each lane remains FIFO", async () => {
		const queue = new BrainTurnQueue({
			maxActive: 1,
			maxPending: 6,
			queueTimeoutMs: 1_000,
		});
		const active = await queue.acquire({
			priority: "standard",
			signal: signal(),
		});
		const resolved: string[] = [];
		const standardA = queue
			.acquire({ priority: "standard", signal: signal() })
			.then((permit) => {
				resolved.push("standard-a");
				return permit;
			});
		const booked = queue
			.acquire({ priority: "booked", signal: signal() })
			.then((permit) => {
				resolved.push("booked");
				return permit;
			});
		const standardB = queue
			.acquire({ priority: "standard", signal: signal() })
			.then((permit) => {
				resolved.push("standard-b");
				return permit;
			});
		if (active.ok) active.release();
		const bookedPermit = await booked;
		expect(resolved).toEqual(["booked"]);
		if (bookedPermit.ok) bookedPermit.release();
		const firstStandard = await standardA;
		expect(resolved).toEqual(["booked", "standard-a"]);
		if (firstStandard.ok) firstStandard.release();
		const secondStandard = await standardB;
		if (secondStandard.ok) secondStandard.release();
		expect(resolved).toEqual(["booked", "standard-a", "standard-b"]);
	});

	test("abort and timeout remove queued work without consuming a permit", async () => {
		const queue = new BrainTurnQueue({
			maxActive: 1,
			maxPending: 2,
			queueTimeoutMs: 5,
		});
		const active = await queue.acquire({
			priority: "standard",
			signal: signal(),
		});
		const controller = new AbortController();
		const cancelled = queue.acquire({
			priority: "standard",
			signal: controller.signal,
		});
		controller.abort();
		expect(await cancelled).toEqual({ ok: false, reason: "cancelled" });
		const timed = queue.acquire({ priority: "standard", signal: signal() });
		expect(await timed).toEqual({ ok: false, reason: "timeout" });
		if (active.ok) active.release();
		expect(queue.activeCount).toBe(0);
	});
});
