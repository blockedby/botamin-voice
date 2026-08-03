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
	let attachedProtocol: number | null = null;
	let attachCount = 0;
	const session: RuntimeGatewaySession = {
		conversationId,
		expiresAt: new Date("2030-01-01T00:00:00.000Z"),
		takeClientToken: () => "w".repeat(43),
		attach: (socket, protocolVersion) => {
			attached = socket;
			attachedProtocol = protocolVersion;
			attachCount += 1;
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
							maxUtteranceMs: 60_000,
							maxPcmBytes: 1_920_000,
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
				`ws://127.0.0.1:${server.port}/ws/v1/conversations/${conversationId}?voiceProtocol=2`,
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
		expect(attachedProtocol as number | null).toBe(2);
		expect(attachCount).toBe(1);
		for (const query of [
			"voiceProtocol=3",
			"voiceProtocol=2&voiceProtocol=2",
			"voiceProtocol=2&visitor=private",
		]) {
			const rejected = await fetch(
				`http://127.0.0.1:${server.port}/ws/v1/conversations/${conversationId}?${query}`,
				{ headers: { Origin: origin } },
			);
			expect(rejected.status).toBe(400);
		}
		expect(attachCount).toBe(1);
	} finally {
		server.stop(true);
	}
});
