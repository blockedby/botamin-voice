import { websocket } from "hono/bun";
import { createServerApp } from "./app";
import { createProductionRuntime } from "./runtime/runtime";

export { createServerApp } from "./app";
export { createRuntimeConfig } from "./runtime/config";
export { createProductionRuntime } from "./runtime/runtime";

if (import.meta.main) {
	try {
		const runtime = await createProductionRuntime();
		const app = createServerApp(runtime);
		const server = Bun.serve({
			port: runtime.config.port,
			fetch: app.fetch,
			websocket: {
				...websocket,
				maxPayloadLength: Math.max(
					runtime.config.limits.wsJsonBytes,
					runtime.config.limits.wsFrameBytes,
				),
			},
			maxRequestBodySize: runtime.config.limits.httpBodyBytes,
			idleTimeout: 30,
		});
		console.info(
			JSON.stringify({
				level: "info",
				event: "server.started",
				port: server.port,
			}),
		);

		let shuttingDown = false;
		const shutdown = async (): Promise<void> => {
			if (shuttingDown) return;
			shuttingDown = true;
			server.stop(false);
			await runtime.dispose();
			process.exit(0);
		};
		process.once("SIGTERM", () => void shutdown());
		process.once("SIGINT", () => void shutdown());
	} catch (error) {
		console.error(
			JSON.stringify({
				level: "error",
				event: "server.start_failed",
				code:
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "STARTUP_INVALID",
			}),
		);
		process.exit(1);
	}
}
