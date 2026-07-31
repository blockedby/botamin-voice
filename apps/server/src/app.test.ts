import { describe, expect, test } from "bun:test";
import {
	AudioCommitEventSchema,
	LiveHealthResponseSchema,
	TranscriptFinalEventSchema,
} from "@botamin/contracts";
import { app } from "./app";

describe("server skeleton", () => {
	test("serves a contract-valid liveness response", async () => {
		const response = await app.request("/health/live");
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(LiveHealthResponseSchema.parse(body)).toEqual({ status: "ok" });
	});

	test("compiles the server baseline against atomic STT WebSocket events", () => {
		const conversationId = "01J00000000000000000000000";
		const at = "2026-07-30T20:22:00.000Z";
		expect(
			AudioCommitEventSchema.parse({
				v: 1,
				type: "audio.commit",
				conversationId,
				at,
				payload: {},
			}).type,
		).toBe("audio.commit");
		expect(
			TranscriptFinalEventSchema.parse({
				v: 1,
				type: "transcript.final",
				conversationId,
				seq: 1,
				at,
				payload: {
					turnId: "01J00000000000000000000003",
					text: "Финальный текст",
				},
			}).type,
		).toBe("transcript.final");
	});
});
