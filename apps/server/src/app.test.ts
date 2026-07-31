import { describe, expect, test } from "bun:test";
import {
	ApiErrorResponseSchema,
	CreateConversationResponseSchema,
	LiveHealthResponseSchema,
	ReadyHealthResponseSchema,
	StopConversationResponseSchema,
} from "@botamin/contracts";
import { createServerApp } from "./app";
import type { RuntimeConfig } from "./runtime/config";
import type { RuntimeGatewaySession, ServerRuntime } from "./runtime/runtime";

const conversationId = "01J00000000000000000000000";
const origin = "http://localhost:5173";

function runtime(
	options: { ready?: boolean; capacity?: boolean } = {},
): ServerRuntime & { stopped: string[] } {
	const sessions = new Map<string, RuntimeGatewaySession>();
	const stopped: string[] = [];
	return {
		config: {
			appOrigin: origin,
			limits: {
				httpBodyBytes: 8_192,
				wsJsonBytes: 8_192,
				wsFrameBytes: 3_209,
				historyEvents: 128,
				historyBytes: 5_000_000,
			},
		} as RuntimeConfig,
		registry: {
			create: () => {
				if (options.capacity === false) return null;
				const session: RuntimeGatewaySession = {
					conversationId,
					expiresAt: new Date("2030-01-01T00:00:00.000Z"),
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
		expect(created.wsUrl).toBe(`/ws/v1/conversations/${conversationId}`);
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
