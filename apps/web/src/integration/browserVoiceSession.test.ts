/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
	BINARY_AUDIO_FRAME_KIND,
	encodeBinaryAudioFrame,
} from "@botamin/contracts";
import { createDeterministicMp3Fixture } from "../../../../packages/test-fixtures/src";
import type {
	CaptureAdapter,
	CaptureFactoryOptions,
	FetchLike,
	PlaybackAdapter,
	PlaybackFactoryOptions,
} from "./browserVoiceSession";
import {
	BrowserVoiceSession,
	resolveSameOriginWebSocketUrl,
} from "./browserVoiceSession";
import type { ReconnectScheduler, WebSocketLike } from "../transport/ws";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000003";
const generationId = "01J00000000000000000000004";
const segmentId = "01J00000000000000000000005";
const bookingId = "01J00000000000000000000006";
const at = "2026-07-30T20:22:00.000Z";
const consent = { voiceProcessing: true, contactProcessing: true } as const;

class FakeSocket implements WebSocketLike {
	readyState = 0;
	binaryType?: BinaryType;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<string | Uint8Array> = [];
	closed = false;

	send(data: string | Uint8Array): void {
		if (this.readyState !== 1) throw new Error("socket closed");
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
		this.readyState = 3;
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	disconnect(): void {
		this.readyState = 3;
		this.onclose?.();
	}
	server(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
	binary(value: Uint8Array): void {
		this.onmessage?.({ data: value });
	}
}

class FakeCapture implements CaptureAdapter {
	active = false;
	startCalls = 0;
	finishCalls = 0;
	stopCalls = 0;
	muted = false;

	constructor(
		readonly options: CaptureFactoryOptions,
		private readonly startError?: Error,
		private readonly startGate?: Promise<void>,
	) {}
	async start(): Promise<void> {
		this.startCalls += 1;
		await this.startGate;
		if (this.startError) throw this.startError;
		this.active = true;
	}
	async finish() {
		this.finishCalls += 1;
		this.active = false;
		return { bytes: 3_200, durationMs: 100, limitedBy: null } as const;
	}
	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.active = false;
	}
	setMuted(muted: boolean): void {
		this.muted = muted;
	}
	get isActive(): boolean {
		return this.active;
	}
	emit(frame = new Uint8Array([0, 0])): void {
		this.options.onFrame(frame);
	}
}

class FakePlayback implements PlaybackAdapter {
	generation: string | null = null;
	bargeInCalls = 0;
	disposeCalls = 0;
	bufferedSegmentCount = 0;
	readonly enqueued: number[] = [];

	constructor(readonly options: PlaybackFactoryOptions) {}
	beginGeneration(generationIdValue: string): void {
		this.generation = generationIdValue;
	}
	async enqueue(segment: { sequence: number }): Promise<boolean> {
		this.enqueued.push(segment.sequence);
		this.bufferedSegmentCount += 1;
		return true;
	}
	bargeIn(): string | null {
		this.bargeInCalls += 1;
		const generation = this.generation;
		this.generation = null;
		this.bufferedSegmentCount = 0;
		return generation;
	}
	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.generation = null;
		this.bufferedSegmentCount = 0;
	}
	get activeGenerationId(): string | null {
		return this.generation;
	}
	idle(): void {
		if (!this.generation) return;
		const generation = this.generation;
		this.generation = null;
		this.bufferedSegmentCount = 0;
		this.options.onIdle(generation);
	}
}

class FakeScheduler implements ReconnectScheduler {
	readonly jobs: Array<{ callback: () => void; delayMs: number }> = [];
	schedule(callback: () => void, delayMs: number): unknown {
		const job = { callback, delayMs };
		this.jobs.push(job);
		return job;
	}
	cancel(handle: unknown): void {
		const index = this.jobs.indexOf(
			handle as { callback: () => void; delayMs: number },
		);
		if (index >= 0) this.jobs.splice(index, 1);
	}
}

function response() {
	return {
		conversationId,
		wsUrl: `/ws/v1/conversations/${conversationId}`,
		expiresAt: "2026-07-30T21:30:00.000Z",
		clientConfig: {
			inputSampleRate: 16_000,
			inputEncoding: "pcm16le",
			chunkMs: 100,
			outputContentType: "audio/mpeg",
			outputMode: "complete-phrase-segments",
		},
	};
}

function sessionReady(seq = 1, token = "resume-token-0001") {
	return event("session.ready", seq, {
		state: "GREETING",
		resumeToken: token,
		clientConfig: response().clientConfig,
	});
}

function event(type: string, seq: number, payload: Record<string, unknown>) {
	return { v: 1, conversationId, seq, at, type, payload };
}

function sentJson(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.sent
		.filter((item): item is string => typeof item === "string")
		.map((item) => JSON.parse(item) as Record<string, unknown>);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(
	options: {
		fetch?: FetchLike;
		captureError?: Error;
		firstCaptureGate?: Promise<void>;
	} = {},
) {
	const sockets: FakeSocket[] = [];
	const captures: FakeCapture[] = [];
	const playbacks: FakePlayback[] = [];
	const requests: Array<{ input: string; init?: RequestInit }> = [];
	const scheduler = new FakeScheduler();
	const fetch: FetchLike =
		options.fetch ??
		(async (input, init) => {
			requests.push({ input, ...(init ? { init } : {}) });
			return { ok: true, status: 201, json: async () => response() };
		});
	const session = new BrowserVoiceSession({
		baseUrl: "https://botamin.test/landing",
		fetch,
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		createCapture: (captureOptions) => {
			const capture = new FakeCapture(
				captureOptions,
				options.captureError,
				captures.length === 0 ? options.firstCaptureGate : undefined,
			);
			captures.push(capture);
			return capture;
		},
		createPlayback: (playbackOptions) => {
			const playback = new FakePlayback(playbackOptions);
			playbacks.push(playback);
			return playback;
		},
		reconnectScheduler: scheduler,
		now: () => new Date(at),
	});
	return { session, sockets, captures, playbacks, requests, scheduler };
}

async function readySession(value = harness()) {
	expect(await value.session.start(consent)).toBe(true);
	const socket = value.sockets[0] as FakeSocket;
	socket.open();
	socket.server(sessionReady());
	await flush();
	return { ...value, socket, capture: value.captures[0] as FakeCapture };
}

describe("production browser voice integration", () => {
	test("requires consent before microphone, REST, or WebSocket effects", async () => {
		const value = harness();
		expect(
			await value.session.start({
				voiceProcessing: true,
				contactProcessing: false,
			}),
		).toBe(false);
		expect(value.requests).toHaveLength(0);
		expect(value.sockets).toHaveLength(0);
		expect(value.captures).toHaveLength(0);
	});

	test("start POSTs consent, resolves same-origin WS, requests media, sends PCM and one commit", async () => {
		const value = await readySession();
		expect(value.requests[0]?.input).toBe("/api/v1/conversations");
		expect(value.requests[0]?.init).toMatchObject({
			method: "POST",
			credentials: "same-origin",
		});
		expect(JSON.parse(String(value.requests[0]?.init?.body))).toEqual({
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consent,
		});
		expect(value.sockets).toHaveLength(1);
		expect(value.capture.startCalls).toBe(1);
		expect(sentJson(value.socket)[0]).toMatchObject({
			type: "client.hello",
			payload: {
				audio: {
					encoding: "pcm16le",
					sampleRate: 16_000,
					channels: 1,
					chunkMs: 100,
				},
			},
		});

		value.capture.emit(new Uint8Array([1, 0, 2, 0]));
		expect(await value.session.commit()).toBe(true);
		expect(await value.session.commit()).toBe(false);
		expect(value.capture.finishCalls).toBe(1);
		expect(value.socket.sent.some((item) => item instanceof Uint8Array)).toBe(
			true,
		);
		expect(
			sentJson(value.socket).filter((item) => item.type === "audio.commit"),
		).toHaveLength(1);
		expect(value.session.getSnapshot().state.kind).toBe("processing");
	});

	test("keeps only final visitor and completed assistant text", async () => {
		const value = await readySession();
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.partial", 2, { turnId, text: "Черновик" }),
		);
		expect(value.session.getSnapshot().transcript).toEqual([]);
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Финальная реплика" }),
		);
		value.socket.server(
			event("assistant.text.delta", 3, {
				generationId,
				text: "Черновой фрагмент",
			}),
		);
		expect(value.session.getSnapshot().transcript).toHaveLength(1);
		value.socket.server(
			event("assistant.text.done", 4, {
				generationId,
				fullText: "Готовый ответ",
			}),
		);
		expect(value.session.getSnapshot().transcript).toEqual([
			{ id: turnId, speaker: "visitor", text: "Финальная реплика" },
			{ id: generationId, speaker: "agent", text: "Готовый ответ" },
		]);
	});

	test("mute, barge-in, and stop execute real local/network cleanup", async () => {
		const value = await readySession();
		value.session.toggleMute();
		expect(value.capture.muted).toBe(true);
		value.session.toggleMute();
		expect(value.capture.muted).toBe(false);
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Перебью" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Ответ",
			}),
		);
		const mp3 = createDeterministicMp3Fixture();
		value.socket.server(
			event("audio.segment", 4, {
				generationId,
				segmentId,
				sequence: 0,
				contentType: "audio/mpeg",
				byteLength: mp3.byteLength,
				final: true,
			}),
		);
		value.socket.binary(
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
				sequence: 0,
				payload: mp3,
			}),
		);
		await flush();
		expect(value.session.getSnapshot().state.kind).toBe("speaking");
		value.session.interrupt();
		expect(value.playbacks[0]?.bargeInCalls).toBe(1);
		expect(
			sentJson(value.socket).some(
				(item) => item.type === "playback.interrupted",
			),
		).toBe(true);
		await flush();
		expect(value.captures).toHaveLength(2);

		await value.session.stop();
		expect(value.socket.closed).toBe(true);
		expect(value.playbacks[0]?.disposeCalls).toBe(1);
		expect(value.session.getSnapshot().state).toEqual({
			kind: "complete",
			bookingOutcome: "none",
		});
		expect(value.session.getSnapshot().transcript).toHaveLength(2);
		await flush();
		expect(value.requests.at(-1)?.input).toBe(
			`/api/v1/conversations/${conversationId}/stop`,
		);
	});

	test("reconnect uses the T10 resume token and starts a fresh capture", async () => {
		const value = await readySession();
		value.socket.disconnect();
		expect(value.session.getSnapshot().state.kind).toBe("reconnecting");
		expect(value.scheduler.jobs).toHaveLength(1);
		value.session.reconnect();
		expect(value.scheduler.jobs).toHaveLength(0);
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		expect(sentJson(resumed)[0]).toMatchObject({
			type: "client.hello",
			payload: { resumeToken: "resume-token-0001" },
		});
		resumed.server(sessionReady(2, "resume-token-0002"));
		await flush();
		expect(value.captures).toHaveLength(2);
		expect(value.session.getSnapshot().state.kind).toBe("listening");
	});

	test("serializes capture startup across reconnect cleanup", async () => {
		let releaseFirst: () => void = () => undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const value = harness({ firstCaptureGate: firstGate });
		expect(await value.session.start(consent)).toBe(true);
		const firstSocket = value.sockets[0] as FakeSocket;
		firstSocket.open();
		firstSocket.server(sessionReady());
		await flush();
		expect(value.captures).toHaveLength(1);

		firstSocket.disconnect();
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		resumed.server(sessionReady(2, "resume-token-0002"));
		await flush();
		expect(value.captures).toHaveLength(1);
		releaseFirst();
		await flush();
		await flush();
		expect(value.captures).toHaveLength(2);
		expect(value.captures[0]?.stopCalls).toBeGreaterThan(0);
		expect(value.session.getSnapshot().state.kind).toBe("listening");
	});

	test("audio done releases a generation whose metadata never received bytes", async () => {
		const value = await readySession();
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Продолжайте" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Текст остаётся доступен",
			}),
		);
		value.socket.server(
			event("audio.segment", 4, {
				generationId,
				segmentId,
				sequence: 0,
				contentType: "audio/mpeg",
				byteLength: 789,
				final: true,
			}),
		);
		value.socket.server(event("assistant.audio.done", 5, { generationId }));
		await flush();
		expect(value.captures).toHaveLength(2);
		expect(value.session.getSnapshot().state.kind).toBe("listening");
		expect(value.session.getSnapshot().transcript.at(-1)?.text).toBe(
			"Текст остаётся доступен",
		);
	});

	test("booking and qualification UI require committed matching booking events", async () => {
		const value = await readySession();
		value.socket.server(
			event("state.changed", 2, {
				from: "DISCOVERY",
				to: "BOOKED",
				reason: "model stage only",
			}),
		);
		expect(value.session.getSnapshot().state.kind).not.toBe("booked");
		value.socket.server(
			event("booking.created", 3, {
				bookingId,
				status: "booked",
				qualificationStatus: "none",
				createdAt: at,
			}),
		);
		expect(value.session.getSnapshot().state).toEqual({ kind: "booked" });
		value.socket.server(
			event("booking.updated", 4, {
				bookingId,
				qualificationStatus: "complete",
				updatedFields: ["role"],
				updatedAt: at,
			}),
		);
		expect(value.session.getSnapshot().state).toEqual({
			kind: "complete",
			bookingOutcome: "committed",
			qualificationStatus: "complete",
		});
		value.socket.server(
			event("state.changed", 5, {
				from: "POST_BOOKING_QUALIFICATION",
				to: "COMPLETE",
				reason: "server completed",
			}),
		);
		await flush();
		expect(value.socket.closed).toBe(true);
	});

	test("permission/network errors are localized and never expose provider or stack details", async () => {
		const denied = await readySession(
			harness({
				captureError: new DOMException(
					"private browser detail",
					"NotAllowedError",
				),
			}),
		);
		expect(denied.session.getSnapshot().state).toEqual({
			kind: "permission-denied",
		});

		const failed = harness({
			fetch: async () => {
				throw new Error("OpenRouter secret provider stack trace");
			},
		});
		expect(await failed.session.start(consent)).toBe(false);
		const visible = JSON.stringify(failed.session.getSnapshot());
		expect(visible).toContain('"kind":"error"');
		expect(visible).not.toContain("OpenRouter");
		expect(visible).not.toContain("provider");
		expect(visible).not.toContain("stack");
		expect(visible).not.toContain("booked");
	});

	test("rejects cross-origin WS resolution", () => {
		expect(
			resolveSameOriginWebSocketUrl(
				"/ws/v1/conversations/test",
				"https://botamin.test/page",
			),
		).toBe("wss://botamin.test/ws/v1/conversations/test");
		expect(() =>
			resolveSameOriginWebSocketUrl(
				"https://elsewhere.test/ws",
				"https://botamin.test/page",
			),
		).toThrow("Cross-origin");
	});
});
