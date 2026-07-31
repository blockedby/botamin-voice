import { describe, expect, test } from "bun:test";
import { resolveRequestSourceKey, SourceAdmissionLimiter } from "./admission";

describe("proxy-aware bounded source admission", () => {
	test("ignores forwarding headers by default and strictly selects configured hops", () => {
		const headers = new Headers({
			"x-forwarded-for": "198.51.100.10, 192.0.2.20",
		});
		expect(
			resolveRequestSourceKey({
				headers,
				directAddress: "127.0.0.1",
				trustedProxyHops: 0,
			}),
		).toBe("ip:127.0.0.1");
		expect(
			resolveRequestSourceKey({
				headers,
				directAddress: "127.0.0.1",
				trustedProxyHops: 1,
			}),
		).toBe("ip:192.0.2.20");
		expect(
			resolveRequestSourceKey({
				headers,
				directAddress: "127.0.0.1",
				trustedProxyHops: 2,
			}),
		).toBe("ip:198.51.100.10");
		expect(
			resolveRequestSourceKey({
				headers: new Headers({ "x-forwarded-for": "victim, 192.0.2.20" }),
				directAddress: "127.0.0.1",
				trustedProxyHops: 1,
			}),
		).toBeNull();
	});

	test("bounds create/socket windows and tracked source cardinality", () => {
		let now = 1_000;
		const limiter = new SourceAdmissionLimiter({
			windowMs: 1_000,
			maxCreatesPerSource: 1,
			maxSocketConnectionsPerSource: 2,
			maxTrackedSources: 2,
			now: () => now,
		});
		expect(limiter.allowCreate("ip:one")).toBe(true);
		expect(limiter.allowCreate("ip:one")).toBe(false);
		expect(limiter.allowSocket("ip:one")).toBe(true);
		expect(limiter.allowSocket("ip:one")).toBe(true);
		expect(limiter.allowSocket("ip:one")).toBe(false);
		expect(limiter.allowCreate("ip:two")).toBe(true);
		expect(limiter.allowCreate("ip:three")).toBe(false);
		expect(limiter.trackedSourceCount).toBe(2);
		now = 2_001;
		expect(limiter.allowCreate("ip:three")).toBe(true);
		expect(limiter.trackedSourceCount).toBe(1);
	});
});
