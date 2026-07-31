import { describe, expect, test } from "bun:test";
import type { CreateConversationRequest } from "@botamin/contracts";
import type { GatewaySession } from "./session";
import { SessionRegistry } from "./registry";

const request: CreateConversationRequest = {
	source: "landing",
	locale: "ru-RU",
	qualificationEnabled: true,
	consent: { voiceProcessing: true, contactProcessing: true },
};

function stubSession(options: {
	expiresAt: Date;
	stop?: () => Promise<void>;
}): GatewaySession {
	let stopped = false;
	return {
		get stopped() {
			return stopped;
		},
		get established() {
			return false;
		},
		isExpired(at = new Date()) {
			return at.getTime() >= options.expiresAt.getTime();
		},
		async stop() {
			stopped = true;
			await options.stop?.();
		},
	} as unknown as GatewaySession;
}

describe("session registry lifecycle and source bounds", () => {
	test("enforces active sessions per source and reclaims abandoned creates early", () => {
		let now = new Date("2026-07-30T20:22:00.000Z");
		const registry = new SessionRegistry({
			maxActiveConversations: 3,
			maxActiveConversationsPerSource: 1,
			maxConcurrentBrainTurns: 1,
			maxPendingBrainTurns: 1,
			brainQueueTimeoutMs: 1_000,
			sessionMaxMs: 60_000,
			abandonedSessionMs: 100,
			cleanupIntervalMs: 60_000,
			now: () => now,
			createSession: ({ expiresAt }) => stubSession({ expiresAt }),
		});
		expect(registry.create(request, "ip:one")).not.toBeNull();
		expect(registry.create(request, "ip:one")).toBeNull();
		expect(registry.create(request, "ip:two")).not.toBeNull();
		expect(registry.activeCount).toBe(2);
		now = new Date(now.getTime() + 101);
		registry.cleanupExpired();
		expect(registry.activeCount).toBe(0);
	});

	test("deduplicates removed expiry stops and dispose awaits their promise", async () => {
		let now = new Date("2026-07-30T20:22:00.000Z");
		let releaseStop: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		let stopCalls = 0;
		const registry = new SessionRegistry({
			maxActiveConversations: 1,
			maxConcurrentBrainTurns: 1,
			maxPendingBrainTurns: 1,
			brainQueueTimeoutMs: 1_000,
			sessionMaxMs: 60_000,
			abandonedSessionMs: 10,
			cleanupIntervalMs: 60_000,
			now: () => now,
			createSession: ({ expiresAt }) =>
				stubSession({
					expiresAt,
					stop: async () => {
						stopCalls += 1;
						await gate;
					},
				}),
		});
		registry.create(request);
		now = new Date(now.getTime() + 11);
		registry.cleanupExpired();
		registry.cleanupExpired();
		let disposed = false;
		const disposing = registry.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);
		expect(disposed).toBe(false);
		expect(stopCalls).toBe(1);
		releaseStop();
		await disposing;
		expect(disposed).toBe(true);
		expect(stopCalls).toBe(1);
	});
});
