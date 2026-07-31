import {
	ApiErrorResponseSchema,
	CreateConversationRequestSchema,
	CreateConversationResponseSchema,
	EntityIdSchema,
	LiveHealthResponseSchema,
	StopConversationRequestSchema,
	StopConversationResponseSchema,
	type SafeErrorCode,
} from "@botamin/contracts";
import { Hono, type Context } from "hono";
import { serveStatic, upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import {
	resolveRequestSourceKey,
	SourceAdmissionLimiter,
} from "./gateway/admission";
import type { GatewaySocket } from "./gateway/session";
import type { RuntimeConfig } from "./runtime/config";
import type { ServerRuntime } from "./runtime/runtime";

interface ServerAppEnv {
	Bindings: { remoteAddress?: string };
}

export const BUN_REQUEST_BODY_HARD_LIMIT_BYTES = 65_536 as const;

export function bunRequestBodyHardLimit(config: RuntimeConfig): number {
	return Math.max(
		BUN_REQUEST_BODY_HARD_LIMIT_BYTES,
		config.limits.httpBodyBytes + 1_024,
	);
}

export function createServerApp(runtime: ServerRuntime): Hono<ServerAppEnv> {
	const app = new Hono<ServerAppEnv>();
	const admissionConfig = runtime.config.admission ?? {
		trustedProxyHops: 0,
		windowMs: 60_000,
		maxCreatesPerSource: 5,
		maxSocketConnectionsPerSource: 20,
		maxActivePerSource: 2,
		clientHelloTimeoutMs: 2_000,
		abandonedSessionMs: 10_000,
	};
	const admission = new SourceAdmissionLimiter({
		windowMs: admissionConfig.windowMs,
		maxCreatesPerSource: admissionConfig.maxCreatesPerSource,
		maxSocketConnectionsPerSource:
			admissionConfig.maxSocketConnectionsPerSource,
	});

	app.use("*", async (context, next) => {
		await next();
		context.header("X-Content-Type-Options", "nosniff");
		context.header("Cache-Control", "no-store");
	});

	app.get("/health/live", (context) => {
		return context.json(LiveHealthResponseSchema.parse({ status: "ok" }), 200);
	});

	app.get("/health/ready", async (context) => {
		const response = await runtime.readiness();
		return context.json(response, response.status === "ready" ? 200 : 503);
	});

	app.post("/api/v1/conversations", async (context) => {
		if (!validRequiredOrigin(context, runtime.config.appOrigin)) {
			return apiError(context, 403, "INVALID_EVENT", false);
		}
		const sourceKey = requestSourceKey(
			context,
			admissionConfig.trustedProxyHops,
		);
		if (sourceKey === null) {
			return apiError(context, 403, "INVALID_EVENT", false);
		}
		if (!admission.allowCreate(sourceKey)) {
			return apiError(context, 429, "CAPACITY_EXCEEDED", true);
		}
		const body = await readBoundedJson(
			context,
			runtime.config.limits.httpBodyBytes,
		);
		if (!body.ok) {
			return apiError(
				context,
				body.reason === "too_large" ? 413 : 400,
				"INVALID_EVENT",
				false,
			);
		}
		const parsed = CreateConversationRequestSchema.safeParse(body.value);
		if (!parsed.success) {
			const consent =
				body.value && typeof body.value === "object" && "consent" in body.value
					? (body.value as { consent?: unknown }).consent
					: undefined;
			const code = validConsent(consent) ? "INVALID_EVENT" : "CONSENT_REQUIRED";
			return apiError(context, 400, code, false);
		}
		const ready = await runtime.readiness();
		if (ready.status !== "ready") {
			const unready = ready.checks.find((check) => check.status === "unready");
			const code: SafeErrorCode =
				unready?.name === "capacity"
					? "CAPACITY_EXCEEDED"
					: unready?.name === "database"
						? "DB_UNAVAILABLE"
						: unready?.name === "voice"
							? "STT_UNAVAILABLE"
							: "BRAIN_NOT_READY";
			return apiError(context, 503, code, true);
		}
		let session: ReturnType<ServerRuntime["registry"]["create"]>;
		try {
			session = runtime.registry.create(parsed.data, sourceKey);
		} catch {
			return apiError(context, 503, "DB_UNAVAILABLE", true);
		}
		if (!session) {
			return apiError(context, 503, "CAPACITY_EXCEEDED", true);
		}
		const response = CreateConversationResponseSchema.parse({
			conversationId: session.conversationId,
			wsUrl: `/ws/v1/conversations/${session.conversationId}`,
			clientToken: session.takeClientToken(),
			expiresAt: session.expiresAt.toISOString(),
			clientConfig: {
				inputSampleRate: 16_000,
				inputEncoding: "pcm16le",
				chunkMs: 100,
				outputContentType: "audio/mpeg",
				outputMode: "complete-phrase-segments",
			},
		});
		return context.json(response, 201);
	});

	app.post("/api/v1/conversations/:id/stop", async (context) => {
		if (!validRequiredOrigin(context, runtime.config.appOrigin)) {
			return apiError(context, 403, "INVALID_EVENT", false);
		}
		const id = context.req.param("id");
		if (!EntityIdSchema.safeParse(id).success) {
			return apiError(context, 400, "INVALID_EVENT", false);
		}
		const body = await readBoundedJson(
			context,
			runtime.config.limits.httpBodyBytes,
		);
		if (!body.ok) {
			return apiError(
				context,
				body.reason === "too_large" ? 413 : 400,
				"INVALID_EVENT",
				false,
			);
		}
		const stopped = StopConversationRequestSchema.safeParse(body.value);
		if (!stopped.success) {
			return apiError(context, 400, "INVALID_EVENT", false);
		}
		await runtime.registry.stop(
			id,
			stopped.data.reason === "user_requested" ? "completed" : "disconnected",
		);
		return context.json(
			StopConversationResponseSchema.parse({
				conversationId: id,
				stopped: true,
			}),
			200,
		);
	});

	app.get("/ws/v1/conversations/:id", async (context) => {
		if (!validRequiredOrigin(context, runtime.config.appOrigin)) {
			return apiError(context, 403, "INVALID_EVENT", false);
		}
		const sourceKey = requestSourceKey(
			context,
			admissionConfig.trustedProxyHops,
		);
		if (sourceKey === null) {
			return apiError(context, 403, "INVALID_EVENT", false);
		}
		if (!admission.allowSocket(sourceKey)) {
			return apiError(context, 429, "CAPACITY_EXCEEDED", true);
		}
		const id = context.req.param("id");
		if (!EntityIdSchema.safeParse(id).success) {
			return apiError(context, 404, "SESSION_EXPIRED", false);
		}
		const session = runtime.registry.get(id);
		if (!session) return apiError(context, 404, "SESSION_EXPIRED", false);
		let socket: GatewaySocket | null = null;
		return upgradeWebSocket(context, {
			onOpen: (_event, ws) => {
				socket = adaptSocket(ws);
				session.attach(socket);
			},
			onMessage: (event) => {
				if (!socket) return;
				void normalizeWsData(event.data)
					.then(async (data) => {
						if (data !== null && socket) {
							await session.receive(socket, data);
							return;
						}
						socket?.close(1003, "unsupported message");
					})
					.catch(() => socket?.close(1011, "session failure"));
			},
			onClose: () => {
				if (socket) session.detach(socket);
				socket = null;
			},
			onError: () => {
				if (socket) session.detach(socket);
				socket = null;
			},
		});
	});

	// The single-page landing client and its immutable assets share this origin.
	// API/health/WS namespaces never fall through to HTML on a wrong method/path.
	app.use("/assets/*", serveStatic({ root: "./apps/web/dist" }));
	app.get("/", serveStatic({ path: "./apps/web/dist/index.html" }));

	app.onError((_error, context) => {
		return apiError(context, 500, "INTERNAL_ERROR", false);
	});
	return app;
}

function adaptSocket(ws: WSContext): GatewaySocket {
	return {
		send(data) {
			if (typeof data === "string") ws.send(data);
			else ws.send(data as Uint8Array<ArrayBuffer>);
		},
		close(code, reason) {
			ws.close(code, reason);
		},
	};
}

async function normalizeWsData(
	value: unknown,
): Promise<string | Uint8Array | null> {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (typeof Blob === "function" && value instanceof Blob) {
		return new Uint8Array(await value.arrayBuffer());
	}
	return null;
}

function validRequiredOrigin(
	context: Context<ServerAppEnv>,
	expected: string,
): boolean {
	return context.req.header("origin") === expected;
}

function requestSourceKey(
	context: Context<ServerAppEnv>,
	trustedProxyHops: number,
): string | null {
	const directAddress = context.env?.remoteAddress;
	return resolveRequestSourceKey({
		headers: context.req.raw.headers,
		...(directAddress === undefined ? {} : { directAddress }),
		trustedProxyHops,
	});
}

async function readBoundedJson(
	context: Context<ServerAppEnv>,
	maximumBytes: number,
): Promise<
	{ ok: true; value: unknown } | { ok: false; reason: "invalid" | "too_large" }
> {
	const type = context.req.header("content-type")?.toLowerCase() ?? "";
	if (!type.startsWith("application/json")) {
		return { ok: false, reason: "invalid" };
	}
	const declared = context.req.header("content-length");
	if (declared && Number(declared) > maximumBytes) {
		return { ok: false, reason: "too_large" };
	}
	try {
		const text = await context.req.text();
		if (text.length === 0) return { ok: false, reason: "invalid" };
		if (new TextEncoder().encode(text).byteLength > maximumBytes) {
			return { ok: false, reason: "too_large" };
		}
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, reason: "invalid" };
	}
}

function validConsent(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"voiceProcessing" in value &&
		"contactProcessing" in value &&
		(value as { voiceProcessing?: unknown }).voiceProcessing === true &&
		(value as { contactProcessing?: unknown }).contactProcessing === true
	);
}

function apiError(
	context: Context<ServerAppEnv>,
	status: 400 | 403 | 404 | 413 | 429 | 500 | 503,
	code: SafeErrorCode,
	retryable: boolean,
): Response {
	return context.json(
		ApiErrorResponseSchema.parse({
			v: 1,
			error: { code, message: apiMessage(code), retryable },
		}),
		status,
	);
}

function apiMessage(code: SafeErrorCode): string {
	switch (code) {
		case "CONSENT_REQUIRED":
			return "Voice and contact processing consent is required.";
		case "CAPACITY_EXCEEDED":
			return "The service is temporarily at capacity.";
		case "BRAIN_NOT_READY":
			return "The conversation service is not ready.";
		case "STT_UNAVAILABLE":
			return "Voice input is not ready.";
		case "SESSION_EXPIRED":
			return "The conversation session is unavailable.";
		case "DB_UNAVAILABLE":
			return "The conversation could not be created.";
		case "INVALID_EVENT":
			return "The request is invalid.";
		default:
			return "The request could not be completed.";
	}
}
