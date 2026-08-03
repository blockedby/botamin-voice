/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
	BINARY_AUDIO_FRAME_KIND,
	type BrowserBookingDraft,
	type ConversationStage,
	encodeBinaryAudioFrame,
	type InternalVirtualMeetingProjection,
} from "@botamin/contracts";
import { createDeterministicMp3Fixture } from "../../../../packages/test-fixtures/src";
import type {
	CompletePlaybackSegment,
	PlaybackEnqueueOutcome,
} from "../audio/playback";
import type { VoiceUiState } from "../components/voiceTypes";
import {
	createBrowserBookingDraft,
	createInternalMeeting,
	RC4_IDS,
} from "../testFixtures/rc4";
import type { ReconnectScheduler, WebSocketLike } from "../transport/ws";
import type {
	CaptureAdapter,
	CaptureFactoryOptions,
	FetchLike,
	PlaybackAdapter,
	PlaybackFactoryOptions,
} from "./browserVoiceSession";
import {
	BrowserVoiceSession,
	effectiveCaptureDurationMs,
	resolveSameOriginWebSocketUrl,
} from "./browserVoiceSession";

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
	fail(): void {
		this.onerror?.(new Error("network failure"));
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
	accepting = false;
	prepareCalls = 0;
	startCalls = 0;
	finishCalls = 0;
	stopCalls = 0;
	muted = false;
	limits: { maxDurationMs: number; maxBytes: number } | null = null;

	constructor(
		readonly options: CaptureFactoryOptions,
		private readonly startError?: Error,
		private readonly startGate?: Promise<void>,
		private readonly stopGate?: Promise<void>,
		private readonly finishGate?: Promise<void>,
	) {}
	async prepare(): Promise<void> {
		this.prepareCalls += 1;
		await this.startGate;
		if (this.startError) throw this.startError;
	}
	configureLimits(maxDurationMs: number, maxBytes: number): void {
		this.limits = { maxDurationMs, maxBytes };
	}
	async start(): Promise<void> {
		this.startCalls += 1;
		this.active = true;
	}
	async finish() {
		this.finishCalls += 1;
		this.active = false;
		await this.finishGate;
		return { bytes: 3_200, durationMs: 100, limitedBy: null } as const;
	}
	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.active = false;
		await this.stopGate;
	}
	setMuted(muted: boolean): void {
		this.muted = muted;
	}
	setAccepting(accepting: boolean): void {
		this.accepting = accepting;
	}
	get isActive(): boolean {
		return this.active;
	}
	emit(frame = new Uint8Array([0, 0])): void {
		this.options.onFrame(frame);
	}
	progress(bytes: number, durationMs: number): void {
		this.options.onProgress({ bytes, durationMs, limitedBy: null });
	}
	limit(): void {
		this.options.onLimit();
	}
}

class FakePlayback implements PlaybackAdapter {
	generation: string | null = null;
	bargeInCalls = 0;
	disposeCalls = 0;
	resumeCalls = 0;
	bufferedSegmentCount = 0;
	sealed = false;
	started = false;
	readonly enqueued: number[] = [];

	constructor(
		readonly options: PlaybackFactoryOptions,
		private readonly resumeError?: Error,
		private readonly enqueueOutcome: PlaybackEnqueueOutcome = {
			status: "accepted",
		},
		private readonly enqueueGate?: Promise<void>,
		private readonly effects?: string[],
	) {}
	async resume(): Promise<void> {
		this.resumeCalls += 1;
		this.effects?.push("playback.resume");
		if (this.resumeError) throw this.resumeError;
	}
	beginGeneration(generationIdValue: string): void {
		if (this.generation !== generationIdValue) {
			this.started = false;
			this.sealed = false;
		}
		this.generation = generationIdValue;
	}
	async enqueue(segment: CompletePlaybackSegment) {
		this.enqueued.push(segment.sequence);
		await this.enqueueGate;
		if (this.enqueueOutcome.status === "rejected") {
			return this.enqueueOutcome;
		}
		this.bufferedSegmentCount += 1;
		if (!this.started) {
			this.started = true;
			this.options.onStarted(segment);
		}
		return this.enqueueOutcome;
	}
	sealGeneration(generationIdValue: string): boolean {
		if (this.generation !== generationIdValue) return false;
		this.sealed = true;
		if (this.bufferedSegmentCount === 0) this.options.onIdle(generationIdValue);
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
		this.bufferedSegmentCount = 0;
		if (this.sealed) this.options.onIdle(generation);
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
		clientToken: "initial-client-token-00000000000000000000",
		expiresAt: "2026-07-30T21:30:00.000Z",
		clientConfig: {
			inputSampleRate: 16_000,
			inputEncoding: "pcm16le",
			chunkMs: 100,
			maxUtteranceMs: 60_000,
			maxPcmBytes: 1_920_000,
			outputContentType: "audio/mpeg",
			outputMode: "complete-phrase-segments",
		},
	};
}

function sessionReady(
	seq = 1,
	token = "resume-token-0001",
	state: ConversationStage = "GREETING",
	internalMeeting: InternalVirtualMeetingProjection | null = null,
) {
	return event("session.ready", seq, {
		state,
		resumeToken: token,
		clientConfig: response().clientConfig,
		internalMeeting,
	});
}

function event(type: string, seq: number, payload: Record<string, unknown>) {
	return { v: 1, conversationId, seq, at, type, payload };
}

function bookingReady(
	seq: number,
	token: string,
	draft: BrowserBookingDraft | null,
	meeting: InternalVirtualMeetingProjection | null = null,
) {
	const ready = sessionReady(seq, token, "COLLECT_BOOKING", meeting);
	return {
		...ready,
		payload: { ...ready.payload, bookingDraft: draft },
	};
}

function conflictedNameDraft(revision = 1): BrowserBookingDraft {
	return {
		...createBrowserBookingDraft(revision),
		name: {
			required: true,
			status: "conflicted",
			value: null,
			conflictOptions: [
				{ optionId: RC4_IDS.optionOne, value: "Анна" },
				{ optionId: RC4_IDS.optionTwo, value: "Мария" },
			],
		},
		readiness: "not_ready",
	};
}

function sentJson(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.sent
		.filter((item): item is string => typeof item === "string")
		.map((item) => JSON.parse(item) as Record<string, unknown>);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function harness(
	options: {
		fetch?: FetchLike;
		captureError?: Error;
		firstCaptureGate?: Promise<void>;
		firstCaptureStopGate?: Promise<void>;
		firstCaptureFinishGate?: Promise<void>;
		createSocketError?: Error;
		playbackResumeError?: Error;
		playbackEnqueueOutcome?: PlaybackEnqueueOutcome;
		playbackEnqueueGate?: Promise<void>;
		requestIds?: string[];
	} = {},
) {
	const sockets: FakeSocket[] = [];
	const captures: FakeCapture[] = [];
	const playbacks: FakePlayback[] = [];
	const requests: Array<{ input: string; init?: RequestInit }> = [];
	const scheduler = new FakeScheduler();
	const fetchImplementation: FetchLike =
		options.fetch ??
		(async () => ({ ok: true, status: 201, json: async () => response() }));
	const fetch: FetchLike = async (input, init) => {
		requests.push({ input, ...(init ? { init } : {}) });
		return fetchImplementation(input, init);
	};
	const session = new BrowserVoiceSession({
		baseUrl: "https://botamin.test/landing",
		fetch,
		createSocket: () => {
			if (options.createSocketError) throw options.createSocketError;
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		createCapture: (captureOptions) => {
			const capture = new FakeCapture(
				captureOptions,
				options.captureError,
				captures.length === 0 ? options.firstCaptureGate : undefined,
				captures.length === 0 ? options.firstCaptureStopGate : undefined,
				captures.length === 0 ? options.firstCaptureFinishGate : undefined,
			);
			captures.push(capture);
			return capture;
		},
		createPlayback: (playbackOptions) => {
			const playback = new FakePlayback(
				playbackOptions,
				options.playbackResumeError,
				options.playbackEnqueueOutcome,
				options.playbackEnqueueGate,
			);
			playbacks.push(playback);
			return playback;
		},
		reconnectScheduler: scheduler,
		now: () => new Date(at),
		...(options.requestIds
			? {
					createRequestId: () => {
						const requestId = options.requestIds?.shift();
						if (!requestId) throw new Error("Missing deterministic request ID");
						return requestId;
					},
				}
			: {}),
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
	test("derives countdown duration from the stricter server capture ceiling", () => {
		expect(
			effectiveCaptureDurationMs({
				maxUtteranceMs: 60_000,
				maxPcmBytes: 1_000_000,
			}),
		).toBe(31_250);
		expect(
			effectiveCaptureDurationMs({
				maxUtteranceMs: 60_000,
				maxPcmBytes: 1_920_000,
			}),
		).toBe(60_000);
	});

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
		expect(value.playbacks).toHaveLength(0);
	});

	test("synchronously resumes output before permission/network awaits and gates capture until ready", async () => {
		let allowPermission: () => void = () => undefined;
		const permissionGate = new Promise<void>((resolve) => {
			allowPermission = resolve;
		});
		const value = harness({ firstCaptureGate: permissionGate });
		const starting = value.session.start(consent);

		expect(value.playbacks).toHaveLength(1);
		expect(value.playbacks[0]?.resumeCalls).toBe(1);
		expect(value.captures).toHaveLength(1);
		expect(value.captures[0]?.prepareCalls).toBe(1);
		expect(value.requests).toHaveLength(0);
		expect(value.sockets).toHaveLength(0);

		allowPermission();
		expect(await starting).toBe(true);
		expect(value.requests.map((request) => request.input)).toEqual([
			"/api/v1/conversations",
		]);
		expect(value.sockets).toHaveLength(1);

		const socket = value.sockets[0] as FakeSocket;
		const capture = value.captures[0] as FakeCapture;
		socket.open();
		capture.emit(new Uint8Array([1, 0]));
		expect(socket.sent.some((item) => item instanceof Uint8Array)).toBe(false);

		socket.server(sessionReady());
		await flush();
		capture.emit(new Uint8Array([1, 0]));
		expect(socket.sent.some((item) => item instanceof Uint8Array)).toBe(true);
		await value.session.stop();
	});

	test("fails closed when session.ready drifts from the REST audio limits", async () => {
		const value = harness();
		expect(await value.session.start(consent)).toBe(true);
		const socket = value.sockets[0] as FakeSocket;
		const capture = value.captures[0] as FakeCapture;
		socket.open();
		socket.server({
			...sessionReady(),
			payload: {
				...sessionReady().payload,
				clientConfig: {
					...response().clientConfig,
					maxUtteranceMs: 59_000,
					maxPcmBytes: 1_888_000,
				},
			},
		});
		await flush();
		await flush();

		expect(capture.active).toBe(false);
		expect(capture.accepting).toBe(false);
		expect(socket.closed).toBe(true);
		expect(value.session.getSnapshot().captureProgress).toBeNull();
		expect(value.session.getSnapshot().state).toEqual({ kind: "error" });
	});

	test("initial microphone denial has zero REST/WS effects and no live capture", async () => {
		const value = harness({
			captureError: new DOMException(
				"private browser detail",
				"NotAllowedError",
			),
		});

		expect(await value.session.start(consent)).toBe(false);
		expect(value.session.getSnapshot().state).toEqual({
			kind: "permission-denied",
		});
		expect(value.requests).toHaveLength(0);
		expect(value.sockets).toHaveLength(0);
		expect(value.playbacks).toHaveLength(1);
		expect(value.playbacks[0]?.resumeCalls).toBe(1);
		expect(value.playbacks[0]?.disposeCalls).toBe(1);
		expect(value.captures).toHaveLength(1);
		expect(value.captures[0]?.active).toBe(false);
		expect(value.captures[0]?.stopCalls).toBeGreaterThan(0);
	});

	test("stop and dispose during permission prompt suppress late startup and capture", async () => {
		for (const action of ["stop", "dispose"] as const) {
			let allowPermission: () => void = () => undefined;
			const permissionGate = new Promise<void>((resolve) => {
				allowPermission = resolve;
			});
			const value = harness({ firstCaptureGate: permissionGate });
			const starting = value.session.start(consent);
			const capture = value.captures[0] as FakeCapture;

			await value.session[action]();
			allowPermission();
			expect(await starting).toBe(false);
			expect(value.requests).toHaveLength(0);
			expect(value.sockets).toHaveLength(0);
			expect(capture.active).toBe(false);
			expect(capture.stopCalls).toBeGreaterThanOrEqual(2);
		}
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
		expect(value.capture.limits).toEqual({
			maxDurationMs: 60_000,
			maxBytes: 1_920_000,
		});
		expect(value.session.getSnapshot().captureProgress).toEqual({
			acceptedPcmBytes: 0,
			durationMs: 0,
			maxUtteranceMs: 60_000,
		});
		expect(sentJson(value.socket)[0]).toMatchObject({
			type: "client.hello",
			payload: {
				resumeToken: "initial-client-token-00000000000000000000",
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
		expect(value.session.getSnapshot().captureProgress).toBeNull();
	});

	test("reset fences a commit whose capture finish is still pending", async () => {
		let releaseFinish: () => void = () => undefined;
		const finishGate = new Promise<void>((resolve) => {
			releaseFinish = resolve;
		});
		const value = await readySession(
			harness({ firstCaptureFinishGate: finishGate }),
		);
		value.capture.emit();
		const committing = value.session.commit();
		await flush();
		expect(value.capture.finishCalls).toBe(1);

		const resetting = value.session.reset();
		await flush();
		releaseFinish();

		expect(await committing).toBe(false);
		await resetting;
		expect(value.session.getSnapshot().state).toEqual({ kind: "idle" });
		expect(
			sentJson(value.socket).filter((item) => item.type === "audio.commit"),
		).toHaveLength(0);
	});

	test("projects sample-derived progress and auto-commits a capture limit exactly once", async () => {
		const value = await readySession();
		value.capture.emit();
		value.capture.progress(1_600_000, 50_000);
		expect(value.session.getSnapshot().captureProgress).toEqual({
			acceptedPcmBytes: 1_600_000,
			durationMs: 50_000,
			maxUtteranceMs: 60_000,
		});

		value.session.toggleMute();
		value.capture.progress(1_603_200, 50_100);
		expect(value.session.getSnapshot().captureProgress?.durationMs).toBe(
			50_100,
		);
		value.capture.limit();
		value.capture.limit();
		await flush();

		expect(value.capture.finishCalls).toBe(1);
		expect(
			sentJson(value.socket).filter((item) => item.type === "audio.commit"),
		).toHaveLength(1);
		expect(value.session.getSnapshot().captureProgress).toBeNull();
		expect(value.session.getSnapshot().state.kind).toBe("processing");
	});

	test("submits typed text once, preserves retry sequence on rejection, and accepts only server final", async () => {
		const value = await readySession();
		expect(value.session.getSnapshot()).toMatchObject({
			conversationStage: "GREETING",
			textInputAvailable: true,
			textSubmission: { status: "idle" },
		});
		expect(value.session.submitText("  Текстовая реплика  ")).toBe(true);
		expect(value.session.submitText("Дубликат")).toBe(false);
		expect(value.capture.stopCalls).toBeGreaterThan(0);
		expect(sentJson(value.socket).at(-1)).toMatchObject({
			type: "visitor.text.submit",
			payload: { sequence: 0, text: "Текстовая реплика" },
		});
		expect(value.session.getSnapshot().textSubmission).toEqual({
			status: "pending",
		});

		value.socket.server(
			event("error", 2, {
				code: "CAPACITY_EXCEEDED",
				message: "Попробуйте снова.",
				retryable: true,
			}),
		);
		await flush();
		expect(value.session.getSnapshot().textSubmission).toMatchObject({
			status: "rejected",
		});
		expect(value.session.submitText("Текстовая реплика")).toBe(true);
		expect(sentJson(value.socket).at(-1)).toMatchObject({
			type: "visitor.text.submit",
			payload: { sequence: 0 },
		});
		value.socket.server(
			event("transcript.final", 3, {
				turnId,
				text: "Текстовая реплика",
			}),
		);
		expect(value.session.getSnapshot().textSubmission).toEqual({
			status: "accepted",
			turnId,
		});
		expect(value.session.getSnapshot().transcript).toEqual([
			{ id: turnId, speaker: "visitor", text: "Текстовая реплика" },
		]);
	});

	test("projects COLLECT_BOOKING only from server stage events", async () => {
		const value = await readySession();
		value.socket.server(
			event("assistant.text.done", 2, {
				generationId,
				fullText: "Оставьте имя и контакт.",
			}),
		);
		expect(value.session.getSnapshot().conversationStage).toBe("GREETING");
		value.socket.server(
			event("state.changed", 3, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "brain_stage_proposal_validated",
			}),
		);
		expect(value.session.getSnapshot().conversationStage).toBe(
			"COLLECT_BOOKING",
		);
	});

	test("chains one form action through a correlated ready draft to exact-revision confirmation", async () => {
		const requestIds = [
			"01J00000000000000000000020",
			"01J00000000000000000000021",
		];
		const value = await readySession(harness({ requestIds }));
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(value.session.getSnapshot().bookingInputAvailable).toBe(true);
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { name: "Анна Новая" },
			}),
		).toBe(true);
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { name: "Дубликат" },
			}),
		).toBe(false);
		expect(value.session.submitText("Гонка")).toBe(false);
		expect(await value.session.commit()).toBe(false);
		expect(value.session.getSnapshot().bookingSubmission).toMatchObject({
			status: "details-pending",
			requestId: "01J00000000000000000000020",
		});

		// A newer speech-origin draft is authoritative data, but cannot confirm
		// the form request because its requestId is not correlated.
		value.socket.server(
			event("booking.draft.updated", 4, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(2),
			}),
		);
		expect(
			sentJson(value.socket).filter(
				(item) => item.type === "booking.draft.confirm",
			),
		).toHaveLength(0);
		value.socket.server(
			event("booking.draft.updated", 5, {
				requestId: "01J00000000000000000000020",
				bookingDraft: createBrowserBookingDraft(3),
			}),
		);
		const bookingEvents = sentJson(value.socket).filter((item) =>
			String(item.type).startsWith("booking."),
		);
		expect(bookingEvents).toEqual([
			{
				v: 1,
				at,
				type: "booking.form.submit",
				payload: {
					requestId: "01J00000000000000000000020",
					baseRevision: 1,
					details: { name: "Анна Новая" },
				},
			},
			{
				v: 1,
				at,
				type: "booking.draft.confirm",
				payload: {
					requestId: "01J00000000000000000000021",
					revision: 3,
				},
			},
		]);
		expect(value.session.getSnapshot().bookingSubmission).toEqual({
			status: "confirmation-pending",
			requestId: "01J00000000000000000000021",
			revision: 3,
		});
		value.socket.server(
			event("internal.meeting.updated", 6, {
				meeting: createInternalMeeting(),
			}),
		);
		expect(value.session.getSnapshot().bookingSubmission).toEqual({
			status: "committed",
			requestId: "01J00000000000000000000021",
			bookingId,
		});
	});

	test("keeps an in-flight form request fenced across authoritative reconnect resync", async () => {
		const value = await readySession(
			harness({
				requestIds: [
					"01J00000000000000000000024",
					"01J00000000000000000000025",
				],
			}),
		);
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { name: "После reconnect" },
			}),
		).toBe(true);
		value.socket.disconnect();
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		const ready = sessionReady(4, "resume-token-booking-pending");
		resumed.server({
			...ready,
			payload: {
				...ready.payload,
				state: "COLLECT_BOOKING",
				bookingDraft: createBrowserBookingDraft(1),
				internalMeeting: null,
			},
		});
		expect(value.session.getSnapshot().bookingSubmission).toMatchObject({
			status: "details-pending",
			requestId: "01J00000000000000000000024",
		});
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { name: "Дубликат" },
			}),
		).toBe(false);
		resumed.server(
			event("booking.draft.updated", 5, {
				requestId: "01J00000000000000000000024",
				bookingDraft: createBrowserBookingDraft(2),
			}),
		);
		expect(sentJson(resumed).at(-1)).toMatchObject({
			type: "booking.draft.confirm",
			payload: {
				requestId: "01J00000000000000000000025",
				revision: 2,
			},
		});
	});

	test("replays a lost form frame once per resumed ready socket with the exact request", async () => {
		const requestId = "01J00000000000000000000040";
		const value = await readySession(harness({ requestIds: [requestId] }));
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		const draft = createBrowserBookingDraft(1);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: draft,
			}),
		);
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { name: "Точный replay", phone: null },
				selectedCandidateId: RC4_IDS.candidateTwo,
			}),
		).toBe(true);
		const original = sentJson(value.socket).at(-1) as Record<string, unknown>;
		value.socket.disconnect();
		value.session.reconnect();
		const firstResume = value.sockets[1] as FakeSocket;
		firstResume.open();
		expect(
			sentJson(firstResume).filter((item) =>
				String(item.type).startsWith("booking."),
			),
		).toHaveLength(0);
		firstResume.server(bookingReady(4, "resume-form-one-0001", draft));
		expect(sentJson(firstResume).at(-1)).toEqual(original);
		firstResume.server(bookingReady(5, "resume-form-duplicate-0001", draft));
		expect(
			sentJson(firstResume).filter(
				(item) => item.type === "booking.form.submit",
			),
		).toHaveLength(1);

		firstResume.disconnect();
		value.session.reconnect();
		const secondResume = value.sockets[2] as FakeSocket;
		secondResume.open();
		secondResume.server(bookingReady(6, "resume-form-two-0002", draft));
		expect(
			sentJson(secondResume).filter(
				(item) => item.type === "booking.form.submit",
			),
		).toEqual([original]);
		expect(value.session.submitText("still fenced")).toBe(false);
		expect(await value.session.commit()).toBe(false);
	});

	test("replays lost confirmation and conflict frames without changing revision or request ID", async () => {
		const confirmationId = "01J00000000000000000000041";
		const confirmation = await readySession(
			harness({ requestIds: [confirmationId] }),
		);
		confirmation.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		const readyDraft = createBrowserBookingDraft(3);
		confirmation.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: readyDraft,
			}),
		);
		expect(
			confirmation.session.submitBookingForm({
				baseRevision: 3,
				details: {},
			}),
		).toBe(true);
		const originalConfirmation = sentJson(confirmation.socket).at(-1);
		confirmation.socket.disconnect();
		confirmation.session.reconnect();
		const confirmationResume = confirmation.sockets[1] as FakeSocket;
		confirmationResume.open();
		confirmationResume.server(
			bookingReady(4, "resume-confirmation", readyDraft),
		);
		expect(sentJson(confirmationResume).at(-1)).toEqual(originalConfirmation);

		const conflictId = "01J00000000000000000000042";
		const conflict = await readySession(harness({ requestIds: [conflictId] }));
		conflict.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		const conflicted = conflictedNameDraft(1);
		conflict.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: conflicted,
			}),
		);
		expect(
			conflict.session.resolveBookingConflict({
				baseRevision: 1,
				field: "name",
				conflictOptionId: RC4_IDS.optionTwo,
			}),
		).toBe(true);
		const originalConflict = sentJson(conflict.socket).at(-1);
		conflict.socket.disconnect();
		conflict.session.reconnect();
		const conflictResume = conflict.sockets[1] as FakeSocket;
		conflictResume.open();
		conflictResume.server(bookingReady(4, "resume-conflict-0001", conflicted));
		expect(sentJson(conflictResume).at(-1)).toEqual(originalConflict);
	});

	test("uses authoritative applied projections instead of replaying an ACK-lost command", async () => {
		const formId = "01J00000000000000000000043";
		const confirmationId = "01J00000000000000000000044";
		const value = await readySession(
			harness({ requestIds: [formId, confirmationId] }),
		);
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { company: "Применено без ACK" },
			}),
		).toBe(true);
		value.socket.disconnect();
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		const appliedBase = createBrowserBookingDraft(2);
		const applied = {
			...appliedBase,
			company: { ...appliedBase.company, value: "Применено без ACK" },
		};
		resumed.server(bookingReady(4, "resume-applied-form", applied));
		const resumedBookingEvents = sentJson(resumed).filter((item) =>
			String(item.type).startsWith("booking."),
		);
		expect(resumedBookingEvents).toEqual([
			{
				v: 1,
				at,
				type: "booking.draft.confirm",
				payload: { requestId: confirmationId, revision: 2 },
			},
		]);

		resumed.disconnect();
		value.session.reconnect();
		const confirmationResume = value.sockets[2] as FakeSocket;
		confirmationResume.open();
		const confirmed = {
			...applied,
			confirmationStatus: "confirmed" as const,
			commitStatus: "committing" as const,
		};
		confirmationResume.server(
			bookingReady(5, "resume-applied-confirmation", confirmed),
		);
		expect(
			sentJson(confirmationResume).filter((item) =>
				String(item.type).startsWith("booking."),
			),
		).toHaveLength(0);
		expect(value.session.getSnapshot().bookingSubmission).toEqual({
			status: "idle",
		});
	});

	test("settles a correlated confirmation projection without leaving inputs fenced", async () => {
		const requestId = "01J00000000000000000000050";
		const value = await readySession(harness({ requestIds: [requestId] }));
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		const draft = createBrowserBookingDraft(1);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: draft,
			}),
		);
		expect(
			value.session.submitBookingForm({ baseRevision: 1, details: {} }),
		).toBe(true);
		value.socket.server(
			event("booking.draft.updated", 4, {
				requestId,
				bookingDraft: {
					...draft,
					confirmationStatus: "confirmed",
					commitStatus: "committing",
				},
			}),
		);
		await flush();
		expect(value.session.getSnapshot().bookingSubmission).toEqual({
			status: "idle",
		});
		expect(value.session.getSnapshot().textInputAvailable).toBe(true);
		expect(value.session.getSnapshot().bookingInputAvailable).toBe(true);
	});

	test("rejects an incompatible resumed revision and allows a fresh confirmation", async () => {
		const staleId = "01J00000000000000000000045";
		const freshId = "01J00000000000000000000046";
		const value = await readySession(
			harness({ requestIds: [staleId, freshId] }),
		);
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(
			value.session.submitBookingForm({ baseRevision: 1, details: {} }),
		).toBe(true);
		value.socket.disconnect();
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		resumed.server(
			bookingReady(
				4,
				"resume-stale-confirmation",
				createBrowserBookingDraft(2),
			),
		);
		await flush();
		expect(
			sentJson(resumed).filter((item) =>
				String(item.type).startsWith("booking."),
			),
		).toHaveLength(0);
		expect(value.session.getSnapshot().bookingSubmission).toMatchObject({
			status: "rejected",
			requestId: staleId,
			retryable: true,
		});
		expect(value.session.getSnapshot().bookingInputAvailable).toBe(true);
		expect(
			value.session.submitBookingForm({ baseRevision: 2, details: {} }),
		).toBe(true);
		expect(sentJson(resumed).at(-1)).toMatchObject({
			type: "booking.draft.confirm",
			payload: { requestId: freshId, revision: 2 },
		});
	});

	test("does not replay after a committed meeting or session stop/dispose", async () => {
		const committedId = "01J00000000000000000000047";
		const committed = await readySession(
			harness({ requestIds: [committedId] }),
		);
		committed.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		committed.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(
			committed.session.submitBookingForm({
				baseRevision: 1,
				details: {},
			}),
		).toBe(true);
		committed.socket.disconnect();
		committed.session.reconnect();
		const committedResume = committed.sockets[1] as FakeSocket;
		committedResume.open();
		const committedDraft = {
			...createBrowserBookingDraft(1),
			confirmationStatus: "confirmed" as const,
			commitStatus: "committed" as const,
			bookingId,
		};
		committedResume.server(
			bookingReady(
				4,
				"resume-committed",
				committedDraft,
				createInternalMeeting(),
			),
		);
		expect(
			sentJson(committedResume).filter((item) =>
				String(item.type).startsWith("booking."),
			),
		).toHaveLength(0);
		expect(committed.session.getSnapshot().bookingSubmission).toEqual({
			status: "committed",
			requestId: committedId,
			bookingId,
		});

		for (const action of ["stop", "dispose"] as const) {
			const requestId =
				action === "stop"
					? "01J00000000000000000000048"
					: "01J00000000000000000000049";
			const value = await readySession(harness({ requestIds: [requestId] }));
			value.socket.server(
				event("state.changed", 2, {
					from: "BOOKING_OFFER",
					to: "COLLECT_BOOKING",
					reason: "server collection",
				}),
			);
			value.socket.server(
				event("booking.draft.updated", 3, {
					requestId: null,
					bookingDraft: createBrowserBookingDraft(1),
				}),
			);
			expect(
				value.session.submitBookingForm({
					baseRevision: 1,
					details: { name: action },
				}),
			).toBe(true);
			value.socket.disconnect();
			expect(value.scheduler.jobs).toHaveLength(1);
			await value.session[action]();
			expect(value.scheduler.jobs).toHaveLength(0);
			expect(
				sentJson(value.socket).filter(
					(item) => item.type === "booking.form.submit",
				),
			).toHaveLength(1);
		}
	});

	test("correlates bounded form rejection and gives an edited retry a fresh request ID", async () => {
		const value = await readySession(
			harness({
				requestIds: [
					"01J00000000000000000000022",
					"01J00000000000000000000023",
				],
			}),
		);
		value.socket.server(
			event("state.changed", 2, {
				from: "BOOKING_OFFER",
				to: "COLLECT_BOOKING",
				reason: "server collection",
			}),
		);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { company: "Первая версия" },
			}),
		).toBe(true);
		value.socket.server(
			event("booking.form.rejected", 4, {
				requestId: "01J00000000000000000000099",
				currentRevision: 1,
				error: { code: "INVALID_REVISION", retryable: true },
			}),
		);
		expect(value.session.getSnapshot().bookingSubmission.status).toBe(
			"details-pending",
		);
		value.socket.server(
			event("booking.form.rejected", 5, {
				requestId: "01J00000000000000000000022",
				currentRevision: 1,
				error: { code: "INVALID_REVISION", retryable: true },
			}),
		);
		expect(value.session.getSnapshot().bookingSubmission).toMatchObject({
			status: "rejected",
			retryable: true,
			message: expect.stringContaining("обновились"),
		});
		expect(
			value.session.submitBookingForm({
				baseRevision: 1,
				details: { company: "Исправленная версия" },
			}),
		).toBe(true);
		expect(sentJson(value.socket).at(-1)).toMatchObject({
			type: "booking.form.submit",
			payload: { requestId: "01J00000000000000000000023" },
		});
	});

	test("keeps only final visitor and completed assistant text", async () => {
		const value = await readySession();
		value.capture.emit();
		await value.session.commit();
		const retiredDraftEvent = ["transcript", "partial"].join(".");
		value.socket.server(
			event(retiredDraftEvent, 2, { turnId, text: "Черновик" }),
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

	test("enters speaking and sends playback.started only when the first source starts", async () => {
		const value = await readySession();
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Проверка запуска" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Первый и второй сегмент.",
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
		expect(value.session.getSnapshot().state.kind).not.toBe("speaking");
		expect(
			sentJson(value.socket).filter((item) => item.type === "playback.started"),
		).toHaveLength(0);
		value.socket.binary(
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
				sequence: 0,
				payload: mp3,
			}),
		);
		await flush();
		expect(value.session.getSnapshot().state.kind).toBe("speaking");

		value.socket.server(
			event("audio.segment", 5, {
				generationId,
				segmentId: "01J00000000000000000000015",
				sequence: 1,
				contentType: "audio/mpeg",
				byteLength: mp3.byteLength,
				final: true,
			}),
		);
		value.socket.binary(
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
				sequence: 1,
				payload: mp3,
			}),
		);
		await flush();
		expect(
			sentJson(value.socket).filter((item) => item.type === "playback.started"),
		).toHaveLength(1);
	});

	test("does not complete a drained generation until assistant.audio.done seals it", async () => {
		const value = await readySession();
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Дождитесь конца" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Текст уже завершён.",
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
		value.playbacks[0]?.idle();
		await flush();
		expect(value.captures).toHaveLength(1);
		expect(value.session.getSnapshot().state.kind).toBe("speaking");

		value.socket.server(event("assistant.audio.done", 5, { generationId }));
		await flush();
		expect(value.captures).toHaveLength(2);
		expect(value.session.getSnapshot().state.kind).toBe("listening");
	});

	test("preserves an early audio seal and rejects a segment arriving after it", async () => {
		const value = await readySession();
		const states: string[] = [];
		value.session.subscribe(() =>
			states.push(value.session.getSnapshot().state.kind),
		);
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Гонка seal" }),
		);
		value.socket.server(
			event("assistant.text.delta", 3, {
				generationId,
				text: "Текст",
			}),
		);
		value.socket.server(event("assistant.audio.done", 4, { generationId }));
		const mp3 = createDeterministicMp3Fixture();
		value.socket.server(
			event("audio.segment", 5, {
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
		value.socket.server(
			event("assistant.text.done", 6, {
				generationId,
				fullText: "Текст после гонки остаётся доступен.",
			}),
		);
		await flush();

		expect(states).toContain("audio-error");
		expect(
			sentJson(value.socket).filter((item) => item.type === "playback.started"),
		).toHaveLength(0);
		expect(value.session.getSnapshot().transcript.at(-1)?.text).toBe(
			"Текст после гонки остаётся доступен.",
		);
	});

	test("surfaces typed playback overflow and preserves completed text", async () => {
		const value = await readySession(
			harness({
				playbackEnqueueOutcome: {
					status: "rejected",
					reason: "overflow",
					error: new Error("queue full"),
				},
			}),
		);
		const projectedStates: string[] = [];
		value.session.subscribe(() => {
			projectedStates.push(value.session.getSnapshot().state.kind);
		});
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Покажите текст" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Текст остаётся видимым при ошибке аудио.",
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

		expect(projectedStates).toContain("audio-error");
		expect(value.session.getSnapshot().transcript.at(-1)?.text).toBe(
			"Текст остаётся видимым при ошибке аудио.",
		);
		expect(
			sentJson(value.socket).filter(
				(item) => item.type === "playback.interrupted",
			),
		).toHaveLength(1);
	});

	test("reconnect synchronously cancels local audio but keeps the output context and text", async () => {
		const value = await readySession();
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Связь" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Этот текст долговечен.",
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

		value.socket.disconnect();
		expect(value.playbacks[0]?.bargeInCalls).toBe(1);
		expect(value.playbacks[0]?.disposeCalls).toBe(0);
		expect(value.session.getSnapshot().state.kind).toBe("reconnecting");
		expect(value.session.getSnapshot().transcript.at(-1)?.text).toBe(
			"Этот текст долговечен.",
		);
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		resumed.server(sessionReady(5, "resume-token-gapless"));
		await flush();
		expect(value.playbacks).toHaveLength(1);
		expect(value.playbacks[0]?.disposeCalls).toBe(0);
		expect(value.session.getSnapshot().state.kind).toBe("listening");
	});

	test("fences a late enqueue failure after reconnect cancellation", async () => {
		const gate = deferred<void>();
		const value = await readySession(
			harness({
				playbackEnqueueGate: gate.promise,
				playbackEnqueueOutcome: {
					status: "rejected",
					reason: "decode-error",
					error: new Error("late decoder failure"),
				},
			}),
		);
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Поздний результат" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Текст сохранён.",
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
		value.socket.disconnect();
		gate.resolve();
		await flush();
		expect(
			sentJson(value.socket).filter(
				(item) => item.type === "playback.interrupted",
			),
		).toHaveLength(0);
		expect(value.session.getSnapshot().state.kind).toBe("reconnecting");
	});

	test("falls back to text-only when Safari-style output resume rejects", async () => {
		const value = await readySession(
			harness({ playbackResumeError: new Error("gesture rejected") }),
		);
		expect(value.playbacks[0]?.resumeCalls).toBe(1);
		expect(value.playbacks[0]?.disposeCalls).toBe(1);
		const states: string[] = [];
		value.session.subscribe(() =>
			states.push(value.session.getSnapshot().state.kind),
		);
		value.capture.emit();
		await value.session.commit();
		value.socket.server(
			event("transcript.final", 2, { turnId, text: "Safari" }),
		);
		value.socket.server(
			event("assistant.text.done", 3, {
				generationId,
				fullText: "Ответ доступен текстом.",
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
		expect(states).toContain("audio-error");
		expect(value.session.getSnapshot().transcript.at(-1)?.text).toBe(
			"Ответ доступен текстом.",
		);
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

	const authoritativeReadyScenarios = [
		{
			name: "BOOKED",
			stage: "BOOKED" as const,
			meeting: createInternalMeeting(),
			expectedState: { kind: "booked" },
		},
		{
			name: "qualification with no answers",
			stage: "POST_BOOKING_QUALIFICATION" as const,
			meeting: createInternalMeeting({
				qualificationStatus: "none",
				qualificationFields: {
					monthlyLeadVolume: null,
					salesManagerCount: null,
				},
			}),
			expectedState: {
				kind: "qualification",
				bookingOutcome: "committed",
				questionNumber: 1,
				questionCount: 2,
			},
		},
		{
			name: "qualification with one answer",
			stage: "POST_BOOKING_QUALIFICATION" as const,
			meeting: createInternalMeeting(),
			expectedState: {
				kind: "qualification",
				bookingOutcome: "committed",
				questionNumber: 2,
				questionCount: 2,
			},
		},
		{
			name: "qualification with all answers",
			stage: "POST_BOOKING_QUALIFICATION" as const,
			meeting: createInternalMeeting({
				qualificationStatus: "complete",
				qualificationFields: {
					monthlyLeadVolume: "120–150",
					salesManagerCount: 4,
				},
			}),
			expectedState: {
				kind: "qualification",
				bookingOutcome: "committed",
			},
		},
		{
			name: "COMPLETE with a committed meeting",
			stage: "COMPLETE" as const,
			meeting: createInternalMeeting({
				qualificationStatus: "complete",
				qualificationFields: {
					monthlyLeadVolume: "120–150",
					salesManagerCount: 4,
				},
			}),
			expectedState: {
				kind: "complete",
				bookingOutcome: "committed",
				qualificationStatus: "complete",
			},
		},
		{
			name: "pre-booking listening control",
			stage: "DISCOVERY" as const,
			meeting: null,
			expectedState: { kind: "listening" },
		},
	] satisfies ReadonlyArray<{
		name: string;
		stage: ConversationStage;
		meeting: InternalVirtualMeetingProjection | null;
		expectedState: VoiceUiState;
	}>;

	for (const readyMode of ["initial", "reconnect"] as const) {
		for (const scenario of authoritativeReadyScenarios) {
			test(`${readyMode} session.ready restores ${scenario.name}`, async () => {
				const value = harness();
				expect(await value.session.start(consent)).toBe(true);
				let socket = value.sockets[0] as FakeSocket;
				socket.open();
				let sequence = 1;
				if (readyMode === "reconnect") {
					socket.server(sessionReady());
					await flush();
					socket.disconnect();
					expect(value.session.getSnapshot().state).toEqual({
						kind: "reconnecting",
					});
					value.session.reconnect();
					socket = value.sockets[1] as FakeSocket;
					socket.open();
					sequence = 2;
				}

				socket.server(
					sessionReady(
						sequence,
						`resume-token-${readyMode}-authoritative`,
						scenario.stage,
						scenario.meeting,
					),
				);
				await flush();

				expect(value.session.getSnapshot().state).toEqual(
					scenario.expectedState,
				);
				expect(value.session.getSnapshot().internalMeeting).toEqual(
					scenario.meeting,
				);
				if (scenario.stage === "COMPLETE") {
					expect(socket.closed).toBe(true);
					expect(value.captures.at(-1)?.active).toBe(false);
				} else {
					expect(value.captures.at(-1)?.active).toBe(true);
					expect(value.captures.at(-1)?.accepting).toBe(true);
				}
			});
		}
	}

	test("keeps committed disconnect states before restoring BOOKED", async () => {
		const value = harness();
		expect(await value.session.start(consent)).toBe(true);
		const meeting = createInternalMeeting();
		const socket = value.sockets[0] as FakeSocket;
		socket.open();
		socket.server(
			sessionReady(1, "resume-token-booked-initial", "BOOKED", meeting),
		);
		await flush();
		expect(value.session.getSnapshot().state).toEqual({ kind: "booked" });

		socket.fail();
		expect(value.session.getSnapshot().state).toEqual({
			kind: "disconnected",
			bookingOutcome: "committed",
		});
		socket.disconnect();
		expect(value.session.getSnapshot().state).toEqual({
			kind: "reconnecting",
			bookingOutcome: "committed",
		});
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);

		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		resumed.server(
			sessionReady(2, "resume-token-booked-resumed", "BOOKED", meeting),
		);
		await flush();
		expect(value.session.getSnapshot().state).toEqual({ kind: "booked" });
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);
	});

	test("qualification projection converges for meeting and stage event ordering", async () => {
		for (const meetingFirst of [false, true]) {
			const value = await readySession();
			const partialMeeting = createInternalMeeting();
			const stageChange = event("state.changed", meetingFirst ? 3 : 2, {
				from: "BOOKED",
				to: "POST_BOOKING_QUALIFICATION",
				reason: "qualification",
			});
			const meetingUpdate = event(
				"internal.meeting.updated",
				meetingFirst ? 2 : 3,
				{ meeting: partialMeeting },
			);
			if (meetingFirst) {
				value.socket.server(meetingUpdate);
				value.socket.server(stageChange);
			} else {
				value.socket.server(stageChange);
				value.socket.server(meetingUpdate);
			}
			expect(value.session.getSnapshot().state).toEqual({
				kind: "qualification",
				bookingOutcome: "committed",
				questionNumber: 2,
				questionCount: 2,
			});

			value.socket.server(
				event("internal.meeting.updated", 4, {
					meeting: createInternalMeeting({
						qualificationStatus: "complete",
						qualificationFields: {
							monthlyLeadVolume: "120–150",
							salesManagerCount: 4,
						},
						updatedAt: "2026-07-30T20:23:00.000Z",
					}),
				}),
			);
			expect(value.session.getSnapshot().state).toEqual({
				kind: "qualification",
				bookingOutcome: "committed",
			});
		}
	});

	test("resyncs projections authoritatively on reconnect and clears only for a new conversation", async () => {
		const value = await readySession();
		value.socket.server(
			event("booking.draft.updated", 2, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(2),
			}),
		);
		value.socket.server(
			event("booking.draft.updated", 3, {
				requestId: null,
				bookingDraft: createBrowserBookingDraft(1),
			}),
		);
		expect(value.session.getSnapshot().bookingDraft?.revision).toBe(2);
		const meeting = createInternalMeeting();
		value.socket.server(event("internal.meeting.updated", 4, { meeting }));
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);

		value.socket.disconnect();
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		const ready = sessionReady(5, "resume-token-authoritative");
		resumed.server({
			...ready,
			payload: {
				...ready.payload,
				bookingDraft: createBrowserBookingDraft(1),
				internalMeeting: createInternalMeeting({
					updatedAt: "2026-07-30T20:24:00.000Z",
				}),
			},
		});
		await flush();
		expect(value.session.getSnapshot().bookingDraft?.revision).toBe(1);
		expect(value.session.getSnapshot().internalMeeting?.updatedAt).toBe(
			"2026-07-30T20:24:00.000Z",
		);
		await value.session.stop();
		expect(value.session.getSnapshot().internalMeeting).not.toBeNull();
		await value.session.reset();
		expect(value.session.getSnapshot()).toMatchObject({
			bookingDraft: null,
			internalMeeting: null,
			bookingSubmission: { status: "idle" },
		});
	});

	test("meeting projection alone drives persistence and rejects stale or mismatched updates", async () => {
		const value = await readySession();
		value.socket.server(
			event("assistant.text.done", 2, {
				generationId,
				fullText: "Встреча создана, всё готово.",
			}),
		);
		expect(value.session.getSnapshot().internalMeeting).toBeNull();
		const meeting = createInternalMeeting();
		value.socket.server(event("internal.meeting.updated", 3, { meeting }));
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);
		expect(value.session.getSnapshot().bookingSubmission).toEqual({
			status: "idle",
		});
		value.socket.server(
			event("internal.meeting.updated", 4, {
				meeting: createInternalMeeting({
					updatedAt: "2026-07-30T20:21:00.000Z",
				}),
			}),
		);
		value.socket.server(
			event("internal.meeting.updated", 5, {
				meeting: createInternalMeeting({
					bookingId: "01J00000000000000000000040",
					updatedAt: "2026-07-30T20:25:00.000Z",
				}),
			}),
		);
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);
		value.socket.server(
			event("state.changed", 6, {
				from: "BOOKED",
				to: "POST_BOOKING_QUALIFICATION",
				reason: "qualification",
			}),
		);
		value.socket.server(
			event("error", 7, {
				code: "TTS_UNAVAILABLE",
				message: "Звук недоступен.",
				retryable: true,
			}),
		);
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);
		value.socket.server(
			event("state.changed", 8, {
				from: "POST_BOOKING_QUALIFICATION",
				to: "COMPLETE",
				reason: "completed",
			}),
		);
		await flush();
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);
	});

	test("serializes capture startup across reconnect cleanup", async () => {
		let releaseFirstStop: () => void = () => undefined;
		const firstStopGate = new Promise<void>((resolve) => {
			releaseFirstStop = resolve;
		});
		const value = await readySession(
			harness({ firstCaptureStopGate: firstStopGate }),
		);

		value.socket.disconnect();
		value.session.reconnect();
		const resumed = value.sockets[1] as FakeSocket;
		resumed.open();
		resumed.server(sessionReady(2, "resume-token-0002"));
		await flush();
		expect(value.captures).toHaveLength(1);
		releaseFirstStop();
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
		expect(value.session.getSnapshot().captureProgress).toEqual({
			acceptedPcmBytes: 0,
			durationMs: 0,
			maxUtteranceMs: 60_000,
		});
		expect(value.session.getSnapshot().transcript.at(-1)?.text).toBe(
			"Текст остаётся доступен",
		);
	});

	test("only the durable meeting projection unlocks booking and qualification UI", async () => {
		const value = await readySession();
		value.socket.server(
			event("state.changed", 2, {
				from: "DISCOVERY",
				to: "BOOKED",
				reason: "model stage only",
			}),
		);
		value.socket.server(
			event("booking.created", 3, {
				bookingId,
				status: "booked",
				qualificationStatus: "none",
				createdAt: at,
			}),
		);
		expect(value.session.getSnapshot().state.kind).not.toBe("booked");
		expect(value.session.getSnapshot().internalMeeting).toBeNull();

		const meeting = createInternalMeeting({
			qualificationStatus: "none",
			qualificationFields: {
				monthlyLeadVolume: null,
				salesManagerCount: null,
			},
		});
		value.socket.server(event("internal.meeting.updated", 4, { meeting }));
		expect(value.session.getSnapshot().state).toEqual({ kind: "booked" });
		expect(value.session.getSnapshot().internalMeeting).toEqual(meeting);

		value.socket.server(
			event("state.changed", 5, {
				from: "BOOKED",
				to: "POST_BOOKING_QUALIFICATION",
				reason: "explicit consent",
			}),
		);
		expect(value.session.getSnapshot().state).toEqual({
			kind: "qualification",
			bookingOutcome: "committed",
			questionNumber: 1,
			questionCount: 2,
		});
		value.socket.server(
			event("booking.updated", 6, {
				bookingId,
				qualificationStatus: "partial",
				updatedFields: ["salesManagerCount"],
				qualificationFields: ["salesManagerCount"],
				updatedAt: at,
			}),
		);
		expect(value.session.getSnapshot().state).toMatchObject({
			kind: "qualification",
			questionNumber: 2,
		});
		value.socket.server(
			event("internal.meeting.updated", 7, {
				meeting: createInternalMeeting({
					qualificationStatus: "complete",
					qualificationFields: {
						monthlyLeadVolume: "120",
						salesManagerCount: 4,
					},
					updatedAt: "2026-07-30T20:23:00.000Z",
				}),
			}),
		);
		expect(
			value.session.getSnapshot().internalMeeting?.qualificationStatus,
		).toBe("complete");
		value.socket.server(
			event("state.changed", 8, {
				from: "POST_BOOKING_QUALIFICATION",
				to: "COMPLETE",
				reason: "server completed",
			}),
		);
		await flush();
		expect(value.socket.closed).toBe(true);
		expect(value.session.getSnapshot().internalMeeting?.bookingId).toBe(
			bookingId,
		);
	});

	test("terminal provider ERROR stops capture/reconnect but retains safe fallback text", async () => {
		const value = await readySession();
		value.socket.server(
			event("state.changed", 2, {
				from: "GREETING",
				to: "ERROR",
				reason: "provider_failed",
			}),
		);
		expect(value.capture.active).toBe(false);
		expect(value.capture.stopCalls).toBeGreaterThan(0);
		expect(value.session.getSnapshot().state.kind).toBe("error");
		value.socket.server(
			event("error", 3, {
				code: "BRAIN_PROTOCOL_ERROR",
				message: "Разговор сейчас недоступен. Попробуйте позже.",
				retryable: true,
			}),
		);
		value.socket.server(
			event("assistant.text.delta", 4, {
				generationId,
				text: "Данные ещё не были сохранены.",
			}),
		);
		value.socket.server(
			event("assistant.text.done", 5, {
				generationId,
				fullText: "Данные ещё не были сохранены.",
			}),
		);
		await flush();
		expect(value.session.getSnapshot().transcript).toEqual([
			{
				id: generationId,
				speaker: "agent",
				text: "Данные ещё не были сохранены.",
			},
		]);
		expect(value.socket.closed).toBe(true);
		expect(value.scheduler.jobs).toHaveLength(0);
		expect(sentJson(value.socket).at(-1)).toMatchObject({
			type: "session.stop",
			payload: { reason: "client_error" },
		});
		expect(value.requests.at(-1)?.input).toBe(
			`/api/v1/conversations/${conversationId}/stop`,
		);
		value.session.reconnect();
		expect(value.sockets).toHaveLength(1);
		value.capture.emit();
		expect(await value.session.commit()).toBe(false);
		expect(
			sentJson(value.socket).filter(
				(message) => message.type === "audio.commit",
			),
		).toHaveLength(0);
	});

	test("REST startup failure releases capture and localizes network details", async () => {
		const failed = harness({
			fetch: async () => {
				throw new Error("OpenRouter secret provider stack trace");
			},
		});
		expect(await failed.session.start(consent)).toBe(false);
		expect(failed.requests.map((request) => request.input)).toEqual([
			"/api/v1/conversations",
		]);
		expect(failed.sockets).toHaveLength(0);
		expect(failed.captures[0]?.active).toBe(false);
		expect(failed.captures[0]?.stopCalls).toBeGreaterThan(0);
		expect(failed.playbacks).toHaveLength(1);
		expect(failed.playbacks[0]?.resumeCalls).toBe(1);
		expect(failed.playbacks[0]?.disposeCalls).toBe(1);
		const visible = JSON.stringify(failed.session.getSnapshot());
		expect(visible).toContain('"kind":"error"');
		expect(visible).not.toContain("OpenRouter");
		expect(visible).not.toContain("provider");
		expect(visible).not.toContain("stack");
		expect(visible).not.toContain("booked");
	});

	test("WebSocket construction failure cleans media and fallback-stops REST session", async () => {
		const failed = harness({
			createSocketError: new Error("WebSocket construction failed"),
		});
		expect(await failed.session.start(consent)).toBe(false);
		await flush();

		expect(failed.sockets).toHaveLength(0);
		expect(failed.scheduler.jobs).toHaveLength(0);
		expect(failed.captures[0]?.active).toBe(false);
		expect(failed.captures[0]?.stopCalls).toBeGreaterThan(0);
		expect(failed.playbacks[0]?.disposeCalls).toBe(1);
		expect(failed.requests.map((request) => request.input)).toEqual([
			"/api/v1/conversations",
			`/api/v1/conversations/${conversationId}/stop`,
		]);
		expect(failed.session.getSnapshot().state).toEqual({ kind: "error" });
	});

	test("initial WebSocket network failure closes transport, media, and REST session", async () => {
		const failed = harness();
		expect(await failed.session.start(consent)).toBe(true);
		const socket = failed.sockets[0] as FakeSocket;
		socket.fail();
		await flush();
		await flush();

		expect(socket.closed).toBe(true);
		expect(failed.captures[0]?.active).toBe(false);
		expect(failed.captures[0]?.stopCalls).toBeGreaterThan(0);
		expect(failed.playbacks[0]?.disposeCalls).toBe(1);
		expect(failed.requests.map((request) => request.input)).toEqual([
			"/api/v1/conversations",
			`/api/v1/conversations/${conversationId}/stop`,
		]);
		expect(failed.session.getSnapshot().state).toEqual({ kind: "error" });
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
