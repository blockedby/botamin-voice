import { app } from "./app";

export { app } from "./app";

if (import.meta.main) {
	const port = Number.parseInt(Bun.env.PORT ?? "3000", 10);
	Bun.serve({
		port,
		fetch: app.fetch,
	});
	console.info(`Botamin server listening on port ${port}`);
}
