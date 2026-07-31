import { LiveHealthResponseSchema } from "@botamin/contracts";
import { Hono } from "hono";

export const app = new Hono();

app.get("/health/live", (context) => {
	const response = LiveHealthResponseSchema.parse({ status: "ok" });
	return context.json(response, 200);
});
