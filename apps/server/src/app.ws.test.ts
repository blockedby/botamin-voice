import { expect, test } from "bun:test";
import { ServerWsEventSchema } from "@botamin/contracts";
import { websocket } from "hono/bun";
import { createServerApp } from "./app";
import type { GatewaySocket } from "./gateway/session";
import type { RuntimeConfig } from "./runtime/config";
import type { RuntimeGatewaySession, ServerRuntime } from "./runtime/runtime";

const origin = "http://localhost:5173";
const conversationId = "01J00000000000000000000000";

test("Bun localhost upgrades the exact conversation WebSocket route", async () => {
	let attached: GatewaySocket | null = null;
	const session: RuntimeGatewaySession = {
		conversationId,
		expiresAt: new Date("2030-01-01T00:00:00.000Z"),
		takeClientToken: () => "w".repeat(43),
		attach: (socket) => {
			attached = socket;
		},
		receive: async (socket, data) => {
			expect(attached).not.toBeNull();
			expect(socket).toBe(attached as GatewaySocket);
			expect(typeof data).toBe("string");
			socket.send(
				JSON.stringify({
					v: 1,
					type: "session.ready",
					conversationId,
					seq: 1,
					at: "2026-07-30T20:22:00.000Z",
					payload: {
						state: "GREETING",
						resumeToken: "opaque-resume-token-000000000000",
						clientConfig: {
							inputSampleRate: 16_000,
							inputEncoding: "pcm16le",
							chunkMs: 100,
							outputContentType: "audio/mpeg",
							outputMode: "complete-phrase-segments",
						},
					},
				}),
			);
		},
		detach: () => undefined,
	};
	const runtime: ServerRuntime = {
		config: {
			appOrigin: origin,
			limits: { httpBodyBytes: 8_192 },
		} as RuntimeConfig,
		registry: {
			create: () => session,
			get: (id) => (id === conversationId ? session : null),
			stop: async () => undefined,
		},
		readiness: async () => ({
			status: "ready",
			checks: [{ name: "capacity", status: "ready" }],
		}),
		dispose: async () => undefined,
	};
	const app = createServerApp(runtime);
	const server = Bun.serve({
		port: 0,
		fetch: (request, bunServer) =>
			app.fetch(request, {
				server: bunServer,
				remoteAddress: bunServer.requestIP(request)?.address,
			}),
		websocket,
	});
	try {
		const event = await new Promise<unknown>((resolve, reject) => {
			const ws = new WebSocket(
				`ws://127.0.0.1:${server.port}/ws/v1/conversations/${conversationId}`,
				{ headers: { Origin: origin } } as never,
			);
			const timer = setTimeout(
				() => reject(new Error("WS smoke timed out")),
				3_000,
			);
			ws.onopen = () => {
				ws.send(
					JSON.stringify({
						v: 1,
						type: "client.hello",
						conversationId,
						at: "2026-07-30T20:22:00.000Z",
						payload: {
							resumeToken: null,
							audio: {
								encoding: "pcm16le",
								sampleRate: 16_000,
								channels: 1,
								chunkMs: 100,
							},
						},
					}),
				);
			};
			ws.onmessage = (message) => {
				clearTimeout(timer);
				ws.close();
				resolve(JSON.parse(String(message.data)));
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("WS smoke failed"));
			};
		});
		expect(ServerWsEventSchema.parse(event).type).toBe("session.ready");
	} finally {
		server.stop(true);
	}
});
