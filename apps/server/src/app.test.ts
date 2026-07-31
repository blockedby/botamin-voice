import { describe, expect, test } from "bun:test";
import { LiveHealthResponseSchema } from "@botamin/contracts";
import { app } from "./app";

describe("server skeleton", () => {
	test("serves a contract-valid liveness response", async () => {
		const response = await app.request("/health/live");
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(LiveHealthResponseSchema.parse(body)).toEqual({ status: "ok" });
	});
});
