/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
	BINARY_AUDIO_FRAME_HEADER_BYTES,
	BINARY_AUDIO_FRAME_KIND,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
} from "@botamin/contracts";
import {
	createDeterministicMp3Fixture,
	createDeterministicWavFixture,
	parseMonoPcm16Wav,
} from "../../../../packages/test-fixtures/src";
import {
	type AudioPlaybackApis,
	PhrasePlaybackQueue,
	type PlaybackSourceLike,
} from "../audio/playback";
import {
	createBrowserBookingDraft,
	createInternalMeeting,
	RC4_IDS,
} from "../testFixtures/rc4";
import type { ReconnectScheduler, WebSocketLike } from "./ws";
import { VoiceTransport } from "./ws";

const conversationId = "01J00000000000000000000000";
const generationId = "01J00000000000000000000004";
const segmentId = "01J00000000000000000000005";
const turnId = "01J00000000000000000000003";
const at = "2026-07-30T20:22:00.000Z";

class FakeSocket implements WebSocketLike {
	readyState = 0;
	binaryType?: BinaryType;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<string | Uint8Array> = [];
	readonly actions: string[] = [];
	closed = false;

	send(data: string | Uint8Array): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.sent.push(data);
		this.actions.push(
			typeof data === "string"
				? `send:${(JSON.parse(data) as { type: string }).type}`
				: "send:binary",
		);
	}
	close(): void {
		this.actions.push("close");
		this.closed = true;
		this.readyState = 3;
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	serverJson(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
	serverBinary(value: Uint8Array): void {
		this.onmessage?.({ data: value });
	}
	disconnect(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

class FakePlaybackSource implements PlaybackSourceLike {
	onended: (() => void) | null = null;
	started = false;
	start(): void {
		this.started = true;
	}
	stop(): void {}
	finish(): void {
		this.onended?.();
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
	runNext(): void {
		this.jobs.shift()?.callback();
	}
}

function sessionReady(seq = 1, resumeToken = "resume-token-0001") {
	return {
		v: 1,
		conversationId,
		seq,
		at,
		type: "session.ready",
		payload: {
			state: "GREETING",
			resumeToken,
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
	};
}

function transcriptFinal(seq: number) {
	return {
		v: 1,
		conversationId,
		seq,
		at,
		type: "transcript.final",
		payload: { turnId, text: "Финальный текст" },
	};
}

function audioSegment(seq: number, binarySequence: number, byteLength: number) {
	return {
		v: 1,
		conversationId,
		seq,
		at,
		type: "audio.segment",
		payload: {
			generationId,
			segmentId:
				binarySequence === 0
					? segmentId
					: `01J${String(binarySequence + 5).padStart(23, "0")}`,
			sequence: binarySequence,
			contentType: "audio/mpeg",
			byteLength,
			final: true,
		},
	};
}

function sentJson(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.sent
		.filter((value): value is string => typeof value === "string")
		.map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe("voice WebSocket transport", () => {
	test("handshakes, sends exact canonical PCM frames, and suppresses duplicate commit", () => {
		const socket = new FakeSocket();
		const events: string[] = [];
		const transport = new VoiceTransport({
			conversationId,
			url: "/ws/v1/conversations/test",
			createWebSocket: () => socket,
			now: () => new Date(at),
			onEvent: (event) => events.push(event.type),
		});
		transport.connect();
		socket.open();

		const hello = sentJson(socket)[0];
		expect(hello).toMatchObject({
			v: 1,
			conversationId,
			type: "client.hello",
			payload: {
				resumeToken: null,
				audio: {
					encoding: "pcm16le",
					sampleRate: 16_000,
					channels: 1,
					chunkMs: 100,
				},
			},
		});
		expect(transport.commit()).toBe(false);

		socket.serverJson(sessionReady());
		const pcm = parseMonoPcm16Wav(createDeterministicWavFixture()).pcm16;
		expect(transport.beginUtterance()).toBe(true);
		expect(transport.sendPcmFrame(pcm)).toBe(true);
		const rawFrame = socket.sent.find(
			(value): value is Uint8Array => value instanceof Uint8Array,
		);
		expect(rawFrame?.byteLength).toBe(
			BINARY_AUDIO_FRAME_HEADER_BYTES + pcm.byteLength,
		);
		expect(rawFrame?.slice(0, BINARY_AUDIO_FRAME_HEADER_BYTES)).toEqual(
			new Uint8Array([0x01, 0, 0, 0, 0, 0, 0, 0, 0]),
		);
		const decoded = decodeBinaryAudioFrame(rawFrame as Uint8Array);
		expect(decoded).toEqual({
			kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
			sequence: 0,
			payload: pcm,
		});
		expect(transport.commit()).toBe(true);
		expect(transport.commit()).toBe(false);
		expect(transport.sendPcmFrame(pcm)).toBe(false);
		expect(
			sentJson(socket).filter((event) => event.type === "audio.commit"),
		).toHaveLength(1);

		socket.serverJson(transcriptFinal(2));
		expect(events).toEqual(["session.ready", "transcript.final"]);
		expect(transport.beginUtterance()).toBe(true);
		expect(transport.sendPcmFrame(pcm)).toBe(true);
		expect(transport.commit()).toBe(true);
	});

	test("sequences bounded typed turns and suppresses duplicates until final or rejection", () => {
		const socket = new FakeSocket();
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
			now: () => new Date(at),
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());

		expect(transport.submitText("   ")).toBe(false);
		expect(transport.submitText("x".repeat(2_001))).toBe(false);
		expect(transport.submitText("  Первая typed-реплика  ")).toBe(true);
		expect(transport.submitText("Дубликат")).toBe(false);
		expect(sentJson(socket).at(-1)).toMatchObject({
			type: "visitor.text.submit",
			payload: { sequence: 0, text: "Первая typed-реплика" },
		});
		socket.serverJson({
			v: 1,
			conversationId,
			seq: 2,
			at,
			type: "error",
			payload: {
				code: "CAPACITY_EXCEEDED",
				message: "Попробуйте ещё раз.",
				retryable: true,
			},
		});
		expect(transport.submitText("Повтор")).toBe(true);
		expect(sentJson(socket).at(-1)).toMatchObject({
			type: "visitor.text.submit",
			payload: { sequence: 0, text: "Повтор" },
		});
		socket.serverJson(transcriptFinal(3));
		expect(transport.submitText("Следующая")).toBe(true);
		expect(sentJson(socket).at(-1)).toMatchObject({
			type: "visitor.text.submit",
			payload: { sequence: 1, text: "Следующая" },
		});
		expect(transport.submitText(" ")).toBe(false);
	});

	test("sends strict booking commands without client authority and fences duplicate/audio/text commits", () => {
		const socket = new FakeSocket();
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
			now: () => new Date(at),
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());
		transport.beginUtterance();
		expect(transport.sendPcmFrame(new Uint8Array([0, 0]))).toBe(true);
		const detailsRequest = "01J00000000000000000000020";
		expect(
			transport.submitBookingForm({
				requestId: detailsRequest,
				baseRevision: 1,
				details: { name: "Анна", phone: null },
				selectedCandidateId: RC4_IDS.candidateOne,
			}),
		).toBe(true);
		expect(
			transport.submitBookingForm({
				requestId: "01J00000000000000000000021",
				baseRevision: 1,
				details: { company: "Дубликат" },
			}),
		).toBe(false);
		expect(transport.commit()).toBe(false);
		expect(transport.submitText("Не должно уйти")).toBe(false);
		const submit = sentJson(socket).at(-1);
		expect(submit).toEqual({
			v: 1,
			at,
			type: "booking.form.submit",
			payload: {
				requestId: detailsRequest,
				baseRevision: 1,
				details: { name: "Анна", phone: null },
				selectedCandidateId: RC4_IDS.candidateOne,
			},
		});
		expect(submit).not.toHaveProperty("conversationId");
		expect(JSON.stringify(submit)).not.toMatch(
			/consent|status|bookingId|meetingSlot/u,
		);

		socket.serverJson({
			v: 1,
			conversationId,
			seq: 2,
			at,
			type: "booking.draft.updated",
			payload: {
				requestId: detailsRequest,
				bookingDraft: createBrowserBookingDraft(2),
			},
		});
		const confirmRequest = "01J00000000000000000000022";
		expect(
			transport.confirmBookingRevision({
				requestId: confirmRequest,
				revision: 2,
			}),
		).toBe(true);
		expect(
			transport.confirmBookingRevision({
				requestId: "01J00000000000000000000023",
				revision: 2,
			}),
		).toBe(false);
		expect(sentJson(socket).at(-1)).toEqual({
			v: 1,
			at,
			type: "booking.draft.confirm",
			payload: { requestId: confirmRequest, revision: 2 },
		});
		socket.serverJson({
			v: 1,
			conversationId,
			seq: 3,
			at,
			type: "booking.form.rejected",
			payload: {
				requestId: confirmRequest,
				currentRevision: 2,
				error: { code: "CONFLICT_REQUIRES_RESOLUTION", retryable: true },
			},
		});
		const conflictRequest = "01J00000000000000000000024";
		expect(
			transport.resolveBookingConflict({
				requestId: conflictRequest,
				baseRevision: 2,
				field: "name",
				conflictOptionId: RC4_IDS.optionOne,
			}),
		).toBe(true);
		expect(sentJson(socket).at(-1)).toEqual({
			v: 1,
			at,
			type: "booking.conflict.resolve",
			payload: {
				requestId: conflictRequest,
				baseRevision: 2,
				field: "name",
				conflictOptionId: RC4_IDS.optionOne,
			},
		});
		socket.serverJson({
			v: 1,
			conversationId,
			seq: 4,
			at,
			type: "internal.meeting.updated",
			payload: { meeting: createInternalMeeting() },
		});
		expect(
			transport.resolveBookingConflict({
				requestId: "01J00000000000000000000025",
				baseRevision: 2,
				field: "name",
				conflictOptionId: RC4_IDS.optionTwo,
			}),
		).toBe(false);
		transport.settleBookingRequest();
		expect(
			transport.resolveBookingConflict({
				requestId: "01J00000000000000000000026",
				baseRevision: 2,
				field: "name",
				conflictOptionId: RC4_IDS.optionTwo,
			}),
		).toBe(true);
	});

	test("pairs complete MP3 metadata with exactly the next shared binary frame", () => {
		const socket = new FakeSocket();
		const received: Array<{ sequence: number; bytes: Uint8Array }> = [];
		const errors: string[] = [];
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
			onAudio: (metadata, bytes) =>
				received.push({ sequence: metadata.sequence, bytes }),
			onProtocolError: (error) => errors.push(error.message),
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());

		const mp3 = createDeterministicMp3Fixture();
		socket.serverJson(audioSegment(2, 42, mp3.byteLength));
		socket.serverBinary(
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
				sequence: 42,
				payload: mp3,
			}),
		);
		expect(received).toEqual([{ sequence: 42, bytes: mp3 }]);

		socket.serverJson(audioSegment(3, 43, mp3.byteLength));
		socket.serverBinary(
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
				sequence: 44,
				payload: mp3,
			}),
		);
		expect(received).toHaveLength(1);
		expect(errors.at(-1)).toContain("sequence does not match");
	});

	test("rejects missing adjacency, wrong frame kind/length, malformed JSON, and stray binary", () => {
		const socket = new FakeSocket();
		const errors: string[] = [];
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
			onProtocolError: (error) => errors.push(error.message),
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());
		const mp3 = createDeterministicMp3Fixture();

		socket.serverBinary(mp3);
		socket.serverJson(audioSegment(2, 1, mp3.byteLength));
		socket.serverJson(transcriptFinal(3));
		socket.serverJson(audioSegment(4, 2, mp3.byteLength + 1));
		socket.serverBinary(
			encodeBinaryAudioFrame({
				kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
				sequence: 2,
				payload: mp3,
			}),
		);
		socket.onmessage?.({ data: "{" });

		expect(errors.some((message) => message.includes("no adjacent"))).toBe(
			true,
		);
		expect(errors.some((message) => message.includes("not followed"))).toBe(
			true,
		);
		expect(
			errors.some((message) => message.includes("server MP3 frame kind")),
		).toBe(true);
		expect(errors.at(-1)).toBe("Malformed WebSocket JSON event");
	});

	test("reconnects with the last resume token and ignores replayed server seq", () => {
		const sockets: FakeSocket[] = [];
		const scheduler = new FakeScheduler();
		const events: string[] = [];
		const statuses: string[] = [];
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			scheduler,
			reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
			onEvent: (event) => events.push(event.type),
			onStatus: (status) => statuses.push(status),
		});
		transport.connect();
		sockets[0]?.open();
		sockets[0]?.serverJson(sessionReady(1, "resume-token-new-0001"));
		sockets[0]?.serverJson(sessionReady(1, "resume-token-replay-1"));
		sockets[0]?.disconnect();

		expect(scheduler.jobs.map((job) => job.delayMs)).toEqual([10]);
		scheduler.runNext();
		sockets[1]?.open();
		const resumedHello = sentJson(sockets[1] as FakeSocket)[0];
		expect(resumedHello).toMatchObject({
			type: "client.hello",
			payload: { resumeToken: "resume-token-new-0001" },
		});
		sockets[1]?.serverJson(sessionReady(2, "resume-token-new-0002"));

		expect(events).toEqual(["session.ready", "session.ready"]);
		expect(transport.currentResumeToken).toBe("resume-token-new-0002");
		expect(statuses).toContain("reconnecting");
		expect(transport.isReady).toBe(true);
	});

	test("retains and replays each exact booking command once per ready socket generation", () => {
		const cases = [
			{
				requestId: "01J00000000000000000000030",
				send: (transport: VoiceTransport) =>
					transport.submitBookingForm({
						requestId: "01J00000000000000000000030",
						baseRevision: 7,
						details: { name: "Анна replay", phone: null },
						selectedCandidateId: RC4_IDS.candidateTwo,
					}),
			},
			{
				requestId: "01J00000000000000000000031",
				send: (transport: VoiceTransport) =>
					transport.confirmBookingRevision({
						requestId: "01J00000000000000000000031",
						revision: 9,
					}),
			},
			{
				requestId: "01J00000000000000000000032",
				send: (transport: VoiceTransport) =>
					transport.resolveBookingConflict({
						requestId: "01J00000000000000000000032",
						baseRevision: 11,
						field: "company",
						conflictOptionId: RC4_IDS.optionTwo,
					}),
			},
		] as const;

		for (const scenario of cases) {
			const sockets: FakeSocket[] = [];
			const scheduler = new FakeScheduler();
			const transport = new VoiceTransport({
				conversationId,
				url: "ws://local",
				createWebSocket: () => {
					const socket = new FakeSocket();
					sockets.push(socket);
					return socket;
				},
				scheduler,
				now: () => new Date(at),
			});
			transport.connect();
			sockets[0]?.open();
			sockets[0]?.serverJson(sessionReady());
			expect(scenario.send(transport)).toBe(true);
			const original = sentJson(sockets[0] as FakeSocket).at(-1);
			expect(Object.isFrozen(transport.currentPendingBookingCommand)).toBe(
				true,
			);
			expect(
				Object.isFrozen(transport.currentPendingBookingCommand?.payload),
			).toBe(true);

			sockets[0]?.disconnect();
			scheduler.runNext();
			sockets[1]?.open();
			expect(transport.replayPendingBookingCommand(scenario.requestId)).toBe(
				"unavailable",
			);
			expect(
				sentJson(sockets[1] as FakeSocket).filter((item) =>
					String(item.type).startsWith("booking."),
				),
			).toHaveLength(0);
			sockets[1]?.serverJson(sessionReady(2, "resume-token-replay-2"));
			expect(transport.replayPendingBookingCommand(scenario.requestId)).toBe(
				"replayed",
			);
			expect(sentJson(sockets[1] as FakeSocket).at(-1)).toEqual(original);
			sockets[1]?.serverJson(sessionReady(3, "resume-token-duplicate-ready"));
			expect(transport.replayPendingBookingCommand(scenario.requestId)).toBe(
				"already-sent",
			);
			expect(
				sentJson(sockets[1] as FakeSocket).filter((item) =>
					String(item.type).startsWith("booking."),
				),
			).toHaveLength(1);

			sockets[1]?.disconnect();
			scheduler.runNext();
			sockets[2]?.open();
			sockets[2]?.serverJson(sessionReady(4, "resume-token-replay-3"));
			expect(transport.replayPendingBookingCommand(scenario.requestId)).toBe(
				"replayed",
			);
			expect(sentJson(sockets[2] as FakeSocket).at(-1)).toEqual(original);
		}
	});

	test("settles rejected requests for a fresh retry and never replays after stop or reconnect exhaustion", () => {
		const sockets: FakeSocket[] = [];
		const scheduler = new FakeScheduler();
		const cancelled: string[] = [];
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			scheduler,
			reconnect: { maxAttempts: 1 },
			onBookingRequestCancelled: (requestId, reason) =>
				cancelled.push(`${requestId}:${reason}`),
		});
		transport.connect();
		sockets[0]?.open();
		sockets[0]?.serverJson(sessionReady());
		const rejectedId = "01J00000000000000000000033";
		expect(
			transport.confirmBookingRevision({
				requestId: rejectedId,
				revision: 1,
			}),
		).toBe(true);
		sockets[0]?.serverJson({
			v: 1,
			conversationId,
			seq: 2,
			at,
			type: "booking.form.rejected",
			payload: {
				requestId: rejectedId,
				currentRevision: 1,
				error: { code: "INVALID_REVISION", retryable: true },
			},
		});
		expect(transport.currentPendingBookingCommand).toBeNull();
		const freshId = "01J00000000000000000000034";
		expect(
			transport.confirmBookingRevision({ requestId: freshId, revision: 2 }),
		).toBe(true);
		sockets[0]?.disconnect();
		scheduler.runNext();
		sockets[1]?.open();
		sockets[1]?.disconnect();
		expect(cancelled).toEqual([`${freshId}:reconnect_exhausted`]);
		expect(transport.currentPendingBookingCommand).toBeNull();

		const stopSocket = new FakeSocket();
		const stopped = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => stopSocket,
		});
		stopped.connect();
		stopSocket.open();
		stopSocket.serverJson(sessionReady());
		expect(
			stopped.submitBookingForm({
				requestId: "01J00000000000000000000035",
				baseRevision: 1,
				details: { company: "stop" },
			}),
		).toBe(true);
		stopped.stop();
		expect(stopped.currentPendingBookingCommand).toBeNull();
		expect(
			stopped.replayPendingBookingCommand("01J00000000000000000000035"),
		).toBe("no-pending");
	});

	test("replays a metadata/binary pair exactly once after disconnect between frames", () => {
		const sockets: FakeSocket[] = [];
		const scheduler = new FakeScheduler();
		const received: number[] = [];
		const events: string[] = [];
		const errors: string[] = [];
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			scheduler,
			onEvent: (event) => events.push(`${event.type}:${event.seq}`),
			onAudio: (metadata) => received.push(metadata.sequence),
			onProtocolError: (error) => errors.push(error.message),
		});
		const mp3 = createDeterministicMp3Fixture();
		const metadata = audioSegment(2, 42, mp3.byteLength);
		const binary = encodeBinaryAudioFrame({
			kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
			sequence: 42,
			payload: mp3,
		});

		transport.connect();
		sockets[0]?.open();
		sockets[0]?.serverJson(sessionReady(1, "resume-token-atomic-1"));
		sockets[0]?.serverJson(metadata);
		expect(events).toEqual(["session.ready:1"]);
		sockets[0]?.disconnect();

		scheduler.runNext();
		sockets[1]?.open();
		sockets[1]?.serverJson(sessionReady(3, "resume-token-atomic-2"));
		sockets[1]?.serverJson(metadata);
		sockets[1]?.serverBinary(binary);
		expect(received).toEqual([42]);
		expect(events).toEqual([
			"session.ready:1",
			"session.ready:3",
			"audio.segment:2",
		]);

		// A server replay after the completed pair is consumed but not redelivered.
		sockets[1]?.serverJson(metadata);
		sockets[1]?.serverBinary(binary);
		expect(received).toEqual([42]);
		expect(errors).toEqual([]);
	});

	test("hands three one-shot WS segments to bounded playback without dropping one", async () => {
		const socket = new FakeSocket();
		const sources: FakePlaybackSource[] = [];
		const decodedSequences: number[] = [];
		const started: number[] = [];
		const accepted: Array<ReturnType<PhrasePlaybackQueue<number>["enqueue"]>> =
			[];
		const playbackApis: AudioPlaybackApis<number> = {
			decodeAudioData: async (bytes) => {
				decodedSequences.push(bytes.byteLength);
				return bytes.byteLength;
			},
			createSource: () => {
				const source = new FakePlaybackSource();
				sources.push(source);
				return source;
			},
			resume: async () => undefined,
			currentTime: () => 0,
			duration: () => 1,
		};
		const playback = new PhrasePlaybackQueue(playbackApis, {
			onStarted: (value) => started.push(value.sequence),
		});
		playback.beginGeneration(generationId);
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
			onAudio: (metadata, bytes) => {
				accepted.push(playback.enqueue({ ...metadata, bytes }));
			},
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());
		const mp3 = createDeterministicMp3Fixture();

		for (const [eventSequence, audioSequence] of [
			[2, 10],
			[3, 11],
			[4, 12],
		] as const) {
			socket.serverJson(
				audioSegment(eventSequence, audioSequence, mp3.byteLength),
			);
			socket.serverBinary(
				encodeBinaryAudioFrame({
					kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
					sequence: audioSequence,
					payload: mp3,
				}),
			);
		}

		expect(accepted).toHaveLength(3);
		await Promise.all(accepted.slice(0, 2));
		expect(playback.bufferedSegmentCount).toBe(2);
		expect(playback.pendingHandoffCount).toBe(1);
		expect(decodedSequences).toHaveLength(2);

		sources[0]?.finish();
		expect(await accepted[2]).toEqual({ status: "accepted" });
		sources[1]?.finish();
		sources[2]?.finish();
		expect(started).toEqual([10]);
		expect(decodedSequences).toHaveLength(3);
		expect(playback.bufferedSegmentCount).toBe(0);
	});

	test("requires an explicit fresh utterance after reconnect drops uncommitted PCM", () => {
		const sockets: FakeSocket[] = [];
		const scheduler = new FakeScheduler();
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			scheduler,
		});
		transport.connect();
		sockets[0]?.open();
		sockets[0]?.serverJson(sessionReady());
		expect(transport.sendPcmFrame(new Uint8Array([0, 0]))).toBe(true);
		sockets[0]?.disconnect();
		scheduler.runNext();
		sockets[1]?.open();
		sockets[1]?.serverJson(sessionReady(2, "resume-token-0002"));

		expect(transport.commit()).toBe(false);
		expect(transport.sendPcmFrame(new Uint8Array([0, 0]))).toBe(false);
		expect(transport.beginUtterance()).toBe(true);
		expect(transport.sendPcmFrame(new Uint8Array([0, 0]))).toBe(true);
		expect(transport.commit()).toBe(true);
	});

	test("rejects malformed PCM payloads at the transport boundary", () => {
		const socket = new FakeSocket();
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());
		expect(transport.sendPcmFrame(new Uint8Array())).toBe(false);
		expect(transport.sendPcmFrame(new Uint8Array([0]))).toBe(false);
		expect(transport.sendPcmFrame(new Uint8Array(3_202))).toBe(false);
		expect(transport.commit()).toBe(false);
	});

	test("terminal stop sends once before outbound fencing/close and cancels reconnect", () => {
		const socket = new FakeSocket();
		const scheduler = new FakeScheduler();
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://local",
			createWebSocket: () => socket,
			scheduler,
		});
		transport.connect();
		socket.open();
		socket.serverJson(sessionReady());
		transport.setMuted(true);
		expect(transport.sendPcmFrame(new Uint8Array([0, 0]))).toBe(false);

		transport.disableReconnect();
		expect(transport.ping()).toBe(false);
		transport.stop("client_error");
		transport.stop("client_error");

		expect(socket.closed).toBe(true);
		expect(scheduler.jobs).toHaveLength(0);
		expect(
			sentJson(socket).filter((event) => event.type === "session.stop"),
		).toHaveLength(1);
		expect(sentJson(socket).at(-1)).toMatchObject({
			type: "session.stop",
			payload: { reason: "client_error" },
		});
		expect(socket.actions.slice(-2)).toEqual(["send:session.stop", "close"]);
	});
});
