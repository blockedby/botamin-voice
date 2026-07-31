import { createDeterministicMp3Fixture } from "./mp3";
import { createDeterministicWavFixture, parseMonoPcm16Wav } from "./wav";

export const OPENROUTER_FIXTURE_PATHS = Object.freeze({
	chat: "/api/v1/chat/completions",
	tts: "/api/v1/audio/speech",
});

export type OpenRouterFixtureStatus =
	| 200
	| 400
	| 401
	| 402
	| 403
	| 404
	| 413
	| 429
	| 500
	| 502
	| 503
	| 524
	| 529;

export interface OpenRouterFixtureBehavior {
	status?: OpenRouterFixtureStatus;
	retryAfter?: string;
	jsonBody?: unknown;
	delayMs?: number;
	/** Deterministic test barrier resolved by the test owner. */
	waitFor?: Promise<void>;
	/** Leave the request pending so caller-controlled abort/timeout is exercised. */
	timeout?: boolean;
	emptyBody?: boolean;
	wrongContentType?: boolean;
	malformedBody?: boolean;
	/** Split a successful MP3 body to exercise complete-response buffering. */
	responseChunkBytes?: number;
}

export interface OpenRouterFixtureOptions {
	expectedWav?: Uint8Array;
	/** Validated but never retained in counters or protocol violations. */
	expectedApiKey?: string;
	expectedSttModel?: string;
	expectedSttInstruction?: string;
	transcript?: string;
	mp3?: Uint8Array;
	chatBehaviors?: readonly OpenRouterFixtureBehavior[];
	ttsBehaviors?: readonly OpenRouterFixtureBehavior[];
	/** A shared queue is useful when testing a provider-wide retry sequence. */
	behaviors?: readonly OpenRouterFixtureBehavior[];
	onRequest?(event: {
		endpoint: "chat" | "tts";
		endpointRequest: number;
		total: number;
	}): void;
	expectedTts?: {
		model?: string;
		voice?: string;
		input?: string;
		responseFormat?: "mp3";
		speed?: number;
	};
}

export interface OpenRouterFixtureCounters {
	readonly total: number;
	readonly chat: number;
	readonly tts: number;
	readonly invalid: number;
	readonly statuses: Readonly<Record<string, number>>;
}

export interface OpenRouterFixtureServer {
	readonly port: number;
	stop(closeActiveConnections?: boolean): void;
}

export interface OpenRouterFixture {
	readonly fetch: typeof fetch;
	readonly counters: OpenRouterFixtureCounters;
	readonly protocolViolations: readonly string[];
	startServer(options?: {
		hostname?: string;
		port?: number;
	}): OpenRouterFixtureServer;
	stop(): void;
}

type Endpoint = keyof typeof OPENROUTER_FIXTURE_PATHS;

const DEFAULT_TRANSCRIPT = "Запишите меня на демонстрацию завтра";

function copyBytes(bytes: Uint8Array): Uint8Array {
	return bytes.slice();
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "x-request-id": "fixture-request" },
	});
}

function completeChatResult(
	transcript: string,
	model: string,
): Record<string, unknown> {
	return {
		choices: [
			{
				finish_reason: "stop",
				index: 0,
				message: { content: transcript, role: "assistant" },
			},
		],
		created: 1_677_652_288,
		id: "chatcmpl-fixture",
		model,
		object: "chat.completion",
		system_fingerprint: "fp_fixture",
		usage: { completion_tokens: 7, prompt_tokens: 12, total_tokens: 19 },
	};
}

export function createOpenRouterFixture(
	options: OpenRouterFixtureOptions = {},
): OpenRouterFixture {
	const expectedWav = copyBytes(
		options.expectedWav ?? createDeterministicWavFixture(),
	);
	parseMonoPcm16Wav(expectedWav);
	const expectedWavBase64 = encodeBase64(expectedWav);
	const mp3 = copyBytes(options.mp3 ?? createDeterministicMp3Fixture());
	const chatQueue = [...(options.chatBehaviors ?? [])];
	const ttsQueue = [...(options.ttsBehaviors ?? [])];
	const sharedQueue = [...(options.behaviors ?? [])];
	const violations: string[] = [];
	const statusCounts = new Map<string, number>();
	let total = 0;
	let chat = 0;
	let tts = 0;
	let invalid = 0;
	let server: OpenRouterFixtureServer | undefined;

	function violation(code: string): void {
		invalid += 1;
		violations.push(code);
	}

	function nextBehavior(endpoint: Endpoint): OpenRouterFixtureBehavior {
		return (
			sharedQueue.shift() ??
			(endpoint === "chat" ? chatQueue.shift() : ttsQueue.shift()) ??
			{}
		);
	}

	async function handle(request: Request): Promise<Response> {
		total += 1;
		const path = new URL(request.url).pathname;
		const endpoint =
			path === OPENROUTER_FIXTURE_PATHS.chat
				? "chat"
				: path === OPENROUTER_FIXTURE_PATHS.tts
					? "tts"
					: null;
		if (endpoint === null || request.method !== "POST") {
			violation("UNSUPPORTED_ROUTE");
			return jsonResponse({ error: "fixture protocol violation" }, 404);
		}
		if (endpoint === "chat") chat += 1;
		else tts += 1;
		if (
			options.expectedApiKey !== undefined &&
			request.headers.get("Authorization") !==
				`Bearer ${options.expectedApiKey}`
		) {
			violation("AUTHORIZATION");
		}
		if (!request.headers.get("Content-Type")?.includes("application/json")) {
			violation("CONTENT_TYPE");
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			violation("INVALID_JSON");
			return jsonResponse({ error: "fixture protocol violation" }, 400);
		}
		if (endpoint === "chat") validateChat(body, expectedWavBase64);
		else validateTts(body);
		options.onRequest?.({
			endpoint,
			endpointRequest: endpoint === "chat" ? chat : tts,
			total,
		});

		const behavior = nextBehavior(endpoint);
		if (behavior.delayMs !== undefined) {
			if (!Number.isInteger(behavior.delayMs) || behavior.delayMs < 0) {
				throw new TypeError("Fixture delayMs must be a non-negative integer");
			}
			await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
		}
		await behavior.waitFor;
		if (behavior.timeout) await new Promise<never>(() => undefined);

		const status = behavior.status ?? 200;
		statusCounts.set(
			String(status),
			(statusCounts.get(String(status)) ?? 0) + 1,
		);
		if (status !== 200) {
			if (behavior.emptyBody) return new Response(null, { status });
			const bodyText = behavior.malformedBody
				? "{malformed fixture body"
				: JSON.stringify(
						behavior.jsonBody ?? { error: { message: "fixture error" } },
					);
			return new Response(bodyText, {
				status,
				headers: {
					"Content-Type": behavior.wrongContentType
						? "text/plain"
						: "application/json",
					...(behavior.retryAfter === undefined
						? {}
						: { "Retry-After": behavior.retryAfter }),
				},
			});
		}

		if (behavior.emptyBody) return new Response(null, { status: 200 });
		if (behavior.malformedBody) {
			return new Response(endpoint === "chat" ? "{malformed" : "not-an-mp3", {
				status: 200,
				headers: {
					"Content-Type": behavior.wrongContentType
						? "text/plain"
						: endpoint === "chat"
							? "application/json"
							: "audio/mpeg",
				},
			});
		}
		if (endpoint === "chat") {
			const result =
				behavior.jsonBody ??
				completeChatResult(
					options.transcript ?? DEFAULT_TRANSCRIPT,
					options.expectedSttModel ?? "openai/gpt-audio-mini",
				);
			if (!behavior.wrongContentType) return jsonResponse(result);
			return new Response(JSON.stringify(result), {
				status: 200,
				headers: { "Content-Type": "text/plain" },
			});
		}
		const chunkBytes = behavior.responseChunkBytes;
		if (
			chunkBytes !== undefined &&
			(!Number.isInteger(chunkBytes) || chunkBytes < 1)
		) {
			throw new TypeError(
				"Fixture responseChunkBytes must be a positive integer",
			);
		}
		const responseBody: BodyInit =
			chunkBytes === undefined
				? copyArrayBuffer(mp3)
				: new ReadableStream<Uint8Array>({
						start(controller) {
							for (
								let offset = 0;
								offset < mp3.byteLength;
								offset += chunkBytes
							) {
								controller.enqueue(mp3.slice(offset, offset + chunkBytes));
							}
							controller.close();
						},
					});
		return new Response(responseBody, {
			status: 200,
			headers: {
				"Content-Type": behavior.wrongContentType
					? "application/json"
					: "audio/mpeg",
				"x-request-id": "fixture-request",
			},
		});
	}

	function validateChat(body: unknown, expectedBase64: string): void {
		if (!body || typeof body !== "object") {
			violation("CHAT_BODY");
			return;
		}
		const value = body as { model?: unknown; messages?: unknown };
		if (
			typeof value.model !== "string" ||
			(options.expectedSttModel !== undefined &&
				value.model !== options.expectedSttModel)
		) {
			violation("CHAT_MODEL");
		}
		const messages = Array.isArray(value.messages) ? value.messages : [];
		const message = messages[0] as
			| { role?: unknown; content?: unknown }
			| undefined;
		if (messages.length !== 1 || message?.role !== "user") {
			violation("CHAT_USER_MESSAGE");
		}
		const parts = Array.isArray(message?.content) ? message.content : [];
		const text = parts[0] as { type?: unknown; text?: unknown } | undefined;
		const audioPart = parts[1] as
			| {
					type?: unknown;
					input_audio?: { data?: unknown; format?: unknown };
			  }
			| undefined;
		if (
			parts.length !== 2 ||
			text?.type !== "text" ||
			typeof text.text !== "string" ||
			text.text.length === 0 ||
			audioPart?.type !== "input_audio"
		) {
			violation("CHAT_CONTENT");
		}
		if (
			options.expectedSttInstruction !== undefined &&
			text?.text !== options.expectedSttInstruction
		) {
			violation("CHAT_INSTRUCTION");
		}
		const audio = audioPart?.input_audio;
		if (audio?.format !== "wav") violation("CHAT_AUDIO_FORMAT");
		if (audio?.data !== expectedBase64) violation("CHAT_AUDIO_BYTES");
	}

	function validateTts(body: unknown): void {
		if (!body || typeof body !== "object") {
			violation("TTS_BODY");
			return;
		}
		const value = body as Record<string, unknown>;
		const expected = options.expectedTts;
		if (
			typeof value.model !== "string" ||
			(expected?.model !== undefined && value.model !== expected.model)
		)
			violation("TTS_MODEL");
		if (
			typeof value.voice !== "string" ||
			(expected?.voice !== undefined && value.voice !== expected.voice)
		)
			violation("TTS_VOICE");
		if (
			typeof value.input !== "string" ||
			value.input.length === 0 ||
			(expected?.input !== undefined && value.input !== expected.input)
		) {
			violation("TTS_INPUT");
		}
		if (value.response_format !== (expected?.responseFormat ?? "mp3"))
			violation("TTS_FORMAT");
		if (expected?.speed !== undefined && value.speed !== expected.speed)
			violation("TTS_SPEED");
	}

	const fixture: OpenRouterFixture = {
		fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
			handle(new Request(input, init))) as typeof fetch,
		get counters() {
			return Object.freeze({
				total,
				chat,
				tts,
				invalid,
				statuses: Object.freeze(Object.fromEntries(statusCounts)),
			});
		},
		get protocolViolations() {
			return violations.slice();
		},
		startServer(serverOptions = {}) {
			server?.stop(true);
			const runtime = (
				globalThis as unknown as {
					Bun?: {
						serve(options: {
							hostname: string;
							port: number;
							fetch(request: Request): Promise<Response>;
						}): OpenRouterFixtureServer;
					};
				}
			).Bun;
			if (!runtime)
				throw new Error("Bun runtime is required for the HTTP fixture");
			const started = runtime.serve({
				hostname: serverOptions.hostname ?? "127.0.0.1",
				port: serverOptions.port ?? 0,
				fetch: handle,
			});
			server = started;
			return started;
		},
		stop() {
			server?.stop(true);
			server = undefined;
		},
	};
	return fixture;
}

export const createFakeOpenRouter = createOpenRouterFixture;
