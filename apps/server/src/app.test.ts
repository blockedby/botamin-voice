import { describe, expect, test } from "bun:test";
import {
	ApiErrorResponseSchema,
	CreateConversationResponseSchema,
	LiveHealthResponseSchema,
	ReadyHealthResponseSchema,
	StopConversationResponseSchema,
} from "@botamin/contracts";
import {
	bunRequestBodyHardLimit,
	createServerApp,
	staticAssetContentType,
} from "./app";
import { ObservabilityMetrics } from "./observability";
import type { RuntimeConfig } from "./runtime/config";
import type { RuntimeGatewaySession, ServerRuntime } from "./runtime/runtime";

const conversationId = "01J00000000000000000000000";
const origin = "http://localhost:5173";

function runtime(
	options: {
		ready?: boolean;
		capacity?: boolean;
		outputContentType?: "audio/mpeg" | "audio/wav";
	} = {},
): ServerRuntime & { stopped: string[] } {
	const sessions = new Map<string, RuntimeGatewaySession>();
	const stopped: string[] = [];
	return {
		config: {
			appOrigin: origin,
			voice: {
				stt: { maxUtteranceMs: 60_000, maxAudioBytes: 2_000_000 },
				tts: { outputContentType: options.outputContentType ?? "audio/mpeg" },
			},
			limits: {
				httpBodyBytes: 8_192,
				wsJsonBytes: 8_192,
				wsFrameBytes: 3_209,
				historyEvents: 128,
				historyBytes: 5_000_000,
			},
		} as RuntimeConfig,
		metrics: new ObservabilityMetrics({
			monotonicNow: () => 0,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
		}),
		registry: {
			create: () => {
				if (options.capacity === false) return null;
				const session: RuntimeGatewaySession = {
					conversationId,
					expiresAt: new Date("2030-01-01T00:00:00.000Z"),
					takeClientToken: () => "t".repeat(43),
					attach: () => undefined,
					receive: async () => undefined,
					detach: () => undefined,
				};
				sessions.set(conversationId, session);
				return session;
			},
			get: (id) => sessions.get(id) ?? null,
			stop: async (id) => {
				stopped.push(id);
				sessions.delete(id);
			},
		},
		readiness: async () =>
			ReadyHealthResponseSchema.parse({
				status: options.ready === false ? "unready" : "ready",
				checks: [
					{
						name: "capacity",
						status: options.capacity === false ? "unready" : "ready",
					},
				],
			}),
		dispose: async () => undefined,
		stopped,
	};
}

const validRequest = {
	source: "landing",
	locale: "ru-RU",
	qualificationEnabled: true,
	consent: { voiceProcessing: true, contactProcessing: true },
};

describe("production server REST contracts", () => {
	test("serves canonical WAV assets with an exact nosniff-compatible media type", () => {
		expect(
			staticAssetContentType("/assets/reactions/neutral-checking.wav"),
		).toBe("audio/wav");
		expect(
			staticAssetContentType("/assets/botamin-proactive-greeting.wav"),
		).toBe("audio/wav");
		expect(staticAssetContentType("/assets/not-a-wav.mp3")).toBeNull();
	});

	test("serves shallow liveness and dependency readiness", async () => {
		const app = createServerApp(runtime());
		const live = await app.request("/health/live");
		expect(live.status).toBe(200);
		expect(LiveHealthResponseSchema.parse(await live.json())).toEqual({
			status: "ok",
		});
		const ready = await app.request("/health/ready");
		expect(ready.status).toBe(200);
		expect(ReadyHealthResponseSchema.parse(await ready.json()).status).toBe(
			"ready",
		);
	});

	test("serves safe metrics only to a verified loopback peer", async () => {
		const app = createServerApp(runtime());
		const local = await app.fetch(
			new Request("http://public.example/metrics"),
			{
				remoteAddress: "127.0.0.2",
			},
		);
		expect(local.status).toBe(200);
		expect(await local.json()).toMatchObject({
			schemaVersion: 1,
			retention: { activeCorrelations: 0 },
		});

		for (const remoteAddress of [undefined, "203.0.113.9", "172.20.0.3"]) {
			const denied = await app.fetch(
				new Request("http://localhost/metrics", {
					headers: { "x-forwarded-for": "127.0.0.1" },
				}),
				remoteAddress === undefined ? {} : { remoteAddress },
			);
			expect(denied.status).toBe(403);
		}
	});

	test("requires both consents and returns only a safe structured error", async () => {
		const app = createServerApp(runtime());
		const response = await app.request("/api/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				...validRequest,
				consent: { voiceProcessing: true, contactProcessing: false },
			}),
		});
		expect(response.status).toBe(400);
		expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
			"CONSENT_REQUIRED",
		);
	});

	test("creates a contract-valid same-origin conversation", async () => {
		const app = createServerApp(runtime());
		const response = await app.request("/api/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(validRequest),
		});
		expect(response.status).toBe(201);
		const created = CreateConversationResponseSchema.parse(
			await response.json(),
		);
		expect(created.conversationId).toBe(conversationId);
		expect(created.wsUrl).toBe(
			`/ws/v1/conversations/${conversationId}?voiceProtocol=2`,
		);
		expect(created.clientToken).toHaveLength(43);
		expect(created.clientConfig).toEqual({
			inputSampleRate: 16_000,
			inputEncoding: "pcm16le",
			chunkMs: 100,
			maxUtteranceMs: 60_000,
			maxPcmBytes: 1_920_000,
			outputContentType: "audio/mpeg",
			outputMode: "complete-phrase-segments",
		});
		expect(created.clientConfig.maxPcmBytes + 44).toBe(1_920_044);
		expect(JSON.stringify(created)).not.toContain("OPENROUTER");
	});

	test("advertises the validated Gemini WAV output in REST configuration", async () => {
		const response = await createServerApp(
			runtime({ outputContentType: "audio/wav" }),
		).request("/api/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(validRequest),
		});
		expect(response.status).toBe(201);
		const created = CreateConversationResponseSchema.parse(
			await response.json(),
		);
		expect(created.clientConfig.outputContentType).toBe("audio/wav");
	});

	test("rate-limits valid conversation creates per direct source", async () => {
		const app = createServerApp(runtime());
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await app.request("/api/v1/conversations", {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify(validRequest),
			});
			expect(response.status).toBe(201);
		}
		const limited = await app.request("/api/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(validRequest),
		});
		expect(limited.status).toBe(429);
		expect(ApiErrorResponseSchema.parse(await limited.json()).error.code).toBe(
			"CAPACITY_EXCEEDED",
		);
	});

	test("rejects unavailable capacity before creating a session", async () => {
		const app = createServerApp(runtime({ capacity: false }));
		const response = await app.request("/api/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(validRequest),
		});
		expect(response.status).toBe(503);
		expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe(
			"CAPACITY_EXCEEDED",
		);
	});

	test("does not serve landing HTML from API paths or wrong methods", async () => {
		const app = createServerApp(runtime());
		const response = await app.request("/api/v1/conversations", {
			headers: { origin },
		});
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type") ?? "").not.toContain(
			"text/html",
		);
	});

	test("Bun passes a 9KB body to Hono for the structured application 413", async () => {
		const fake = runtime();
		const app = createServerApp(fake);
		const server = Bun.serve({
			port: 0,
			fetch: app.fetch,
			maxRequestBodySize: bunRequestBodyHardLimit(fake.config),
		});
		try {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/api/v1/conversations`,
				{
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({ padding: "x".repeat(9_000) }),
				},
			);
			expect(response.status).toBe(413);
			expect(ApiErrorResponseSchema.parse(await response.json())).toMatchObject(
				{
					error: { code: "INVALID_EVENT", retryable: false },
				},
			);
		} finally {
			server.stop(true);
		}
	});

	test("stops idempotently with the exact contract response", async () => {
		const fake = runtime();
		const app = createServerApp(fake);
		await app.request("/api/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(validRequest),
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await app.request(
				`/api/v1/conversations/${conversationId}/stop`,
				{
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({ reason: "user_requested" }),
				},
			);
			expect(response.status).toBe(200);
			expect(
				StopConversationResponseSchema.parse(await response.json()),
			).toEqual({
				conversationId,
				stopped: true,
			});
		}
		expect(fake.stopped).toEqual([conversationId, conversationId]);
	});
});
