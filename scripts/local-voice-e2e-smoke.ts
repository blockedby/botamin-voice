/**
 * External, owner-operated smoke against an already-running voice server.
 *
 * BOTAMIN_EXTERNAL_VOICE_E2E=1 bun run scripts/local-voice-e2e-smoke.ts \
 *   --server-url http://127.0.0.1:3000 --origin http://localhost:5173 \
 *   --pcm /tmp/turn-1.pcm --pcm /tmp/turn-2.pcm
 *
 * Use --fixture or --fixture-turns N only for synthetic canonical PCM. The
 * script never synthesizes provider speech input and emits aggregate evidence.
 * Bun/non-browser runs require ffmpeg on PATH for decoder-backed MP3 checks.
 */
import {
	AtomicServerAudioSegmentFrameSchema,
	BINARY_AUDIO_FRAME_KIND,
	CreateConversationResponseSchema,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
	isCompleteMp3File,
	ServerWsEventSchema,
	StopConversationResponseSchema,
} from "../packages/contracts/src";
import { createDeterministicPcm16Fixture } from "../packages/test-fixtures/src";

const optIn = Bun.env.BOTAMIN_EXTERNAL_VOICE_E2E === "1";
const startedAt = performance.now();
const eventTypes = new Map<string, number>();
const timings: Record<string, number | number[]> = {};
const counts = {
	inputPcmFiles: 0,
	inputPcmBytes: 0,
	commits: 0,
	transcriptFinal: 0,
	textDone: 0,
	audioSegments: 0,
	audioDone: 0,
	responseMp3Bytes: 0,
	playbackReady: 0,
	browserDecodeStarts: 0,
	localDecoderAccepts: 0,
	playbackStarted: 0,
};
let booking = false;
let phase = "configuration";

function elapsed(): number {
	return Math.max(0, Math.round(performance.now() - startedAt));
}

function safeLabel(value: string | undefined): string {
	const label = value?.trim();
	return label && /^[A-Za-z0-9._:/-]{1,128}$/u.test(label)
		? label
		: "not-supplied";
}

function report(
	status: "passed" | "not_run" | "failed",
	reason?: string,
): void {
	console.info(
		JSON.stringify({
			smoke: "local-voice-e2e",
			external: true,
			status,
			...(reason ? { reason } : {}),
			eventTypes: Object.fromEntries(
				[...eventTypes].sort(([left], [right]) => left.localeCompare(right)),
			),
			counts,
			models: {
				stt: safeLabel(Bun.env.OPENROUTER_STT_MODEL),
				brain: safeLabel(Bun.env.CODEX_MODEL),
				tts: safeLabel(Bun.env.OPENROUTER_TTS_MODEL),
				voice: safeLabel(Bun.env.OPENROUTER_TTS_VOICE),
				format: safeLabel(Bun.env.OPENROUTER_TTS_RESPONSE_FORMAT),
			},
			timingsMs: timings,
			booking,
		}),
	);
}

if (!optIn) {
	report("not_run", "opt_in_required");
	process.exit(2);
}

interface Arguments {
	serverUrl: URL;
	origin: string;
	pcmPaths: string[];
	fixtureTurns: number;
}

function readArguments(argv: string[]): Arguments {
	let serverUrl = Bun.env.BOTAMIN_VOICE_E2E_SERVER_URL;
	let origin = Bun.env.BOTAMIN_VOICE_E2E_ORIGIN;
	const pcmPaths: string[] = [];
	let fixtureTurns = 0;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--server-url" && value) {
			serverUrl = value;
			index += 1;
		} else if (flag === "--origin" && value) {
			origin = value;
			index += 1;
		} else if (flag === "--pcm" && value) {
			pcmPaths.push(value);
			index += 1;
		} else if (flag === "--fixture") {
			fixtureTurns = 1;
		} else if (flag === "--fixture-turns" && value && /^\d+$/u.test(value)) {
			fixtureTurns = Number(value);
			index += 1;
		} else {
			throw new Error("invalid arguments");
		}
	}
	if (!serverUrl || !origin) throw new Error("missing endpoint");
	const server = new URL(serverUrl);
	const page = new URL(origin);
	if (
		(server.protocol !== "http:" && server.protocol !== "https:") ||
		(page.protocol !== "http:" && page.protocol !== "https:") ||
		page.origin !== origin ||
		server.username !== "" ||
		server.password !== "" ||
		page.username !== "" ||
		page.password !== ""
	) {
		throw new Error("invalid endpoint");
	}
	if ((pcmPaths.length === 0) === (fixtureTurns === 0)) {
		throw new Error("choose PCM files or fixture mode");
	}
	if (
		!Number.isSafeInteger(fixtureTurns) ||
		fixtureTurns < 0 ||
		fixtureTurns > 20
	) {
		throw new Error("fixture turn bound");
	}
	return { serverUrl: server, origin, pcmPaths, fixtureTurns };
}

async function loadPcm(args: Arguments): Promise<Uint8Array[]> {
	const utterances = args.fixtureTurns
		? Array.from({ length: args.fixtureTurns }, () =>
				createDeterministicPcm16Fixture(),
			)
		: await Promise.all(
				args.pcmPaths.map(
					async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
				),
			);
	if (utterances.length === 0 || utterances.length > 20) {
		throw new Error("utterance count bound");
	}
	for (const pcm of utterances) {
		if (
			pcm.byteLength === 0 ||
			pcm.byteLength % 2 !== 0 ||
			pcm.byteLength > 1_000_000 - 44
		) {
			throw new Error("invalid canonical PCM");
		}
	}
	counts.inputPcmFiles = utterances.length;
	counts.inputPcmBytes = utterances.reduce(
		(total, pcm) => total + pcm.byteLength,
		0,
	);
	return utterances;
}

function pushTiming(name: string): void {
	const value = elapsed();
	const current = timings[name];
	if (current === undefined) timings[name] = [value];
	else if (Array.isArray(current)) current.push(value);
}

function boundedTimeoutMs(): number {
	const raw = Bun.env.BOTAMIN_VOICE_E2E_TIMEOUT_MS;
	if (!raw || !/^\d+$/u.test(raw)) return 120_000;
	return Math.min(300_000, Math.max(250, Number(raw)));
}

class OverallDeadline {
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly #timer: ReturnType<typeof setTimeout>;

	constructor(timeoutMs: number) {
		this.#timer = setTimeout(
			() => this.controller.abort(new Error("overall deadline exceeded")),
			timeoutMs,
		);
	}

	async wait<T>(promise: Promise<T>): Promise<T> {
		if (this.signal.aborted) {
			// The operation may already have started before this guard. Observe any
			// later rejection so deadline cleanup never leaks runtime diagnostics.
			void promise.catch(() => undefined);
			throw this.signal.reason;
		}
		return new Promise<T>((resolve, reject) => {
			const aborted = () => reject(this.signal.reason);
			this.signal.addEventListener("abort", aborted, { once: true });
			promise.then(
				(value) => {
					this.signal.removeEventListener("abort", aborted);
					resolve(value);
				},
				(error) => {
					this.signal.removeEventListener("abort", aborted);
					reject(error);
				},
			);
		});
	}

	dispose(): void {
		clearTimeout(this.#timer);
	}
}

type ServerEvent = ReturnType<typeof ServerWsEventSchema.parse>;
type AudioSegmentEvent = Extract<ServerEvent, { type: "audio.segment" }>;

interface ActiveTurn {
	readonly promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
	finalTurnId: string | null;
	generationId: string | null;
	textDone: boolean;
	audioDone: boolean;
	segmentCount: number;
	playbackStarted: number;
	pendingAudio?: AudioSegmentEvent;
}

interface DecodeContext {
	readonly destination: unknown;
	decodeAudioData(bytes: ArrayBuffer): Promise<unknown>;
	createBufferSource(): {
		buffer: unknown;
		connect(destination: unknown): void;
		disconnect?(): void;
		start(when?: number): void;
		stop?(when?: number): void;
	};
	resume?(): Promise<void>;
	close?(): Promise<void>;
}

class DecoderUnavailableError extends Error {}
class DecoderFailedError extends Error {}

const MAX_LOCAL_DECODE_BYTES = 5_000_000;

async function decodeWithLocalFfmpeg(
	bytes: Uint8Array,
	deadline: OverallDeadline,
): Promise<void> {
	if (bytes.byteLength > MAX_LOCAL_DECODE_BYTES) {
		throw new DecoderFailedError();
	}
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(
			[
				"ffmpeg",
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"error",
				"-xerror",
				"-f",
				"mp3",
				"-threads",
				"1",
				"-i",
				"pipe:0",
				"-map",
				"0:a:0",
				"-f",
				"null",
				"-",
			],
			{
				env: { PATH: Bun.env.PATH ?? "" },
				stdin: "pipe",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
	} catch {
		throw new DecoderUnavailableError();
	}

	const abortDecoder = (): void => {
		try {
			child.kill(9);
		} catch {
			// The decoder can exit before the deadline abort listener runs.
		}
	};
	deadline.signal.addEventListener("abort", abortDecoder, { once: true });
	try {
		const stdin = child.stdin;
		if (!stdin || typeof stdin === "number") throw new DecoderFailedError();
		stdin.write(bytes);
		stdin.end();
		const exitCode = await deadline.wait(child.exited);
		if (exitCode !== 0) throw new DecoderFailedError();
	} catch (error) {
		if (deadline.signal.aborted) throw deadline.signal.reason;
		if (error instanceof DecoderFailedError) throw error;
		throw new DecoderFailedError();
	} finally {
		deadline.signal.removeEventListener("abort", abortDecoder);
		if (child.exitCode === null) abortDecoder();
	}
}

async function validatePlaybackReadyMp3(
	bytes: Uint8Array,
	deadline: OverallDeadline,
): Promise<void> {
	// Structural validation is only a cheap prefilter; it cannot prove that
	// arbitrary frame bodies are decodable audio.
	if (!isCompleteMp3File(bytes)) throw new Error("incomplete MP3 file");
	const scope = globalThis as unknown as {
		AudioContext?: new () => DecodeContext;
		webkitAudioContext?: new () => DecodeContext;
	};
	const Context = scope.AudioContext ?? scope.webkitAudioContext;
	if (!Context) {
		await decodeWithLocalFfmpeg(bytes, deadline);
		counts.localDecoderAccepts += 1;
		counts.playbackReady += 1;
		pushTiming("playback.ready.local-decode");
		return;
	}
	const context = new Context();
	try {
		const exact = bytes.slice();
		const decoded = await deadline.wait(context.decodeAudioData(exact.buffer));
		if (context.resume) await deadline.wait(context.resume());
		const source = context.createBufferSource();
		source.buffer = decoded;
		source.connect(context.destination);
		source.start(0);
		source.stop?.(0);
		source.disconnect?.();
		counts.browserDecodeStarts += 1;
		counts.playbackReady += 1;
		pushTiming("playback.ready.decode-start");
	} finally {
		if (context.close) await deadline.wait(context.close());
	}
}

let socket: WebSocket | null = null;
let conversationId: string | null = null;
let args: Arguments | null = null;
let deadline: OverallDeadline | null = null;
let failureReason: string | undefined;
let candidatePassed = false;
let shuttingDown = false;
let activeTurn: ActiveTurn | null = null;
let readySettled = false;
let fatalError: unknown;
let clientSequence = 0;
let lastServerSequence = -1;
const completedTurnIds = new Set<string>();
const completedGenerationIds = new Set<string>();

let readyResolve = (): void => undefined;
let readyReject = (_error: unknown): void => undefined;
const ready = new Promise<void>((resolve, reject) => {
	readyResolve = resolve;
	readyReject = reject;
});
let socketClosedResolve = (): void => undefined;
const socketClosed = new Promise<void>((resolve) => {
	socketClosedResolve = resolve;
});

function fail(error: unknown): void {
	fatalError ??= error;
	readyReject(error);
	activeTurn?.reject(error);
}

function requireCurrentGeneration(event: {
	payload: { generationId: string };
}): ActiveTurn {
	const turn = activeTurn;
	if (!turn?.finalTurnId) throw new Error("generation without final");
	const generationId = event.payload.generationId;
	if (completedGenerationIds.has(generationId)) {
		throw new Error("stale generation");
	}
	turn.generationId ??= generationId;
	if (turn.generationId !== generationId) {
		throw new Error("mismatched generation");
	}
	return turn;
}

function resolveCompletedTurn(turn: ActiveTurn): void {
	if (
		activeTurn !== turn ||
		!turn.finalTurnId ||
		!turn.generationId ||
		!turn.textDone ||
		!turn.audioDone ||
		turn.pendingAudio ||
		turn.segmentCount < 1 ||
		turn.playbackStarted !== turn.segmentCount
	) {
		return;
	}
	completedTurnIds.add(turn.finalTurnId);
	completedGenerationIds.add(turn.generationId);
	activeTurn = null;
	turn.resolve();
}

async function processServerMessage(data: unknown): Promise<void> {
	if (shuttingDown) return;
	if (typeof data !== "string") {
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: ArrayBuffer.isView(data)
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: null;
		const turn = activeTurn;
		const pending = turn?.pendingAudio;
		if (!bytes || !turn || !pending) throw new Error("unpaired audio");
		const atomic = AtomicServerAudioSegmentFrameSchema.parse({
			metadata: pending.payload,
			rawFrame: bytes,
		});
		const frame = decodeBinaryAudioFrame(atomic.rawFrame);
		if (!isCompleteMp3File(frame.payload)) throw new Error("incomplete MP3");
		if (!deadline) throw new Error("missing overall deadline");
		await validatePlaybackReadyMp3(frame.payload, deadline);
		if (activeTurn !== turn || turn.pendingAudio !== pending) {
			throw new Error("stale audio decode");
		}
		delete turn.pendingAudio;
		turn.segmentCount += 1;
		turn.playbackStarted += 1;
		counts.audioSegments += 1;
		counts.responseMp3Bytes += frame.payload.byteLength;
		counts.playbackStarted += 1;
		pushTiming("playback.started");
		socket?.send(
			JSON.stringify({
				v: 1,
				type: "playback.started",
				conversationId,
				at: new Date().toISOString(),
				payload: { generationId: pending.payload.generationId },
			}),
		);
		resolveCompletedTurn(turn);
		return;
	}
	if (activeTurn?.pendingAudio) throw new Error("non-adjacent audio pair");
	const event = ServerWsEventSchema.parse(JSON.parse(data));
	if (
		event.conversationId !== conversationId ||
		event.seq <= lastServerSequence
	) {
		throw new Error("stale or mismatched server event");
	}
	lastServerSequence = event.seq;
	eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
	switch (event.type) {
		case "session.ready":
			if (readySettled || activeTurn)
				throw new Error("duplicate session ready");
			readySettled = true;
			timings["session.ready"] ??= elapsed();
			readyResolve();
			break;
		case "transcript.final": {
			const turn = activeTurn;
			if (
				!turn ||
				turn.finalTurnId ||
				completedTurnIds.has(event.payload.turnId)
			) {
				throw new Error("zero, double, or stale final");
			}
			turn.finalTurnId = event.payload.turnId;
			counts.transcriptFinal += 1;
			pushTiming("transcript.final.gateway-receipt");
			break;
		}
		case "assistant.text.delta":
			requireCurrentGeneration(event);
			pushTiming("assistant.text.delta.gateway-receipt");
			break;
		case "assistant.text.done": {
			const turn = requireCurrentGeneration(event);
			if (turn.textDone) throw new Error("duplicate text done");
			turn.textDone = true;
			counts.textDone += 1;
			pushTiming("assistant.text.done.gateway-receipt");
			resolveCompletedTurn(turn);
			break;
		}
		case "audio.segment": {
			const turn = requireCurrentGeneration(event);
			if (turn.audioDone || turn.pendingAudio) {
				throw new Error("invalid audio metadata order");
			}
			if (event.payload.sequence !== turn.segmentCount) {
				throw new Error("non-contiguous audio sequence");
			}
			turn.pendingAudio = event;
			pushTiming("audio.segment.metadata-receipt");
			break;
		}
		case "assistant.audio.done": {
			const turn = requireCurrentGeneration(event);
			if (turn.audioDone || turn.pendingAudio || turn.segmentCount < 1) {
				throw new Error("invalid audio done");
			}
			turn.audioDone = true;
			counts.audioDone += 1;
			pushTiming("assistant.audio.done.gateway-receipt");
			resolveCompletedTurn(turn);
			break;
		}
		case "assistant.interrupted":
			requireCurrentGeneration(event);
			throw new Error("unexpected interruption");
		case "booking.created":
			booking = true;
			break;
		case "booking.updated":
		case "state.changed":
		case "session.capacity_warning":
		case "server.pong":
			break;
		case "error":
			throw new Error("server error");
	}
}

function newTurn(): ActiveTurn {
	let resolve = (): void => undefined;
	let reject = (_error: unknown): void => undefined;
	const promise = new Promise<void>((turnResolve, turnReject) => {
		resolve = turnResolve;
		reject = turnReject;
	});
	return {
		promise,
		resolve,
		reject,
		finalTurnId: null,
		generationId: null,
		textDone: false,
		audioDone: false,
		segmentCount: 0,
		playbackStarted: 0,
	};
}

async function cleanup(): Promise<void> {
	if (!args || !conversationId || !deadline) return;
	const cleanupArgs = args;
	const cleanupConversationId = conversationId;
	const cleanupDeadline = deadline;
	phase = "shutdown";
	shuttingDown = true;
	const stopRest = (async () => {
		const response = await cleanupDeadline.wait(
			fetch(
				new URL(
					`/api/v1/conversations/${encodeURIComponent(cleanupConversationId)}/stop`,
					cleanupArgs.serverUrl,
				),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: cleanupArgs.origin,
					},
					body: JSON.stringify({ reason: "user_requested" }),
					signal: cleanupDeadline.signal,
				},
			),
		);
		if (response.status !== 200) throw new Error("stop failed");
		const stopped = StopConversationResponseSchema.parse(
			await cleanupDeadline.wait(response.json()),
		);
		if (stopped.conversationId !== cleanupConversationId) {
			throw new Error("stop response mismatch");
		}
	})();
	if (socket && socket.readyState === WebSocket.OPEN) {
		socket.send(
			JSON.stringify({
				v: 1,
				type: "session.stop",
				conversationId,
				at: new Date().toISOString(),
				payload: { reason: "user_requested" },
			}),
		);
	}
	try {
		socket?.close(1000, "smoke complete");
	} catch {
		// A peer close can win the shutdown race.
	}
	if (!socket || socket.readyState === WebSocket.CLOSED) socketClosedResolve();
	await cleanupDeadline.wait(Promise.all([stopRest, socketClosed]));
}

try {
	args = readArguments(process.argv.slice(2));
	const utterances = await loadPcm(args);
	deadline = new OverallDeadline(boundedTimeoutMs());
	phase = "conversation_create";
	const createdResponse = await deadline.wait(
		fetch(new URL("/api/v1/conversations", args.serverUrl), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: args.origin,
			},
			body: JSON.stringify({
				source: "landing",
				locale: "ru-RU",
				qualificationEnabled: true,
				consent: { voiceProcessing: true, contactProcessing: true },
			}),
			signal: deadline.signal,
		}),
	);
	if (createdResponse.status !== 201) throw new Error("create failed");
	const created = CreateConversationResponseSchema.parse(
		await deadline.wait(createdResponse.json()),
	);
	conversationId = created.conversationId;

	phase = "websocket";
	const wsUrl = new URL(created.wsUrl, args.serverUrl);
	wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
	let messageQueue = Promise.resolve();
	socket = new WebSocket(wsUrl, {
		headers: { Origin: args.origin },
	} as never);
	socket.binaryType = "arraybuffer";
	socket.onopen = () => {
		socket?.send(
			JSON.stringify({
				v: 1,
				type: "client.hello",
				conversationId: created.conversationId,
				at: new Date().toISOString(),
				payload: {
					resumeToken: created.clientToken,
					audio: {
						encoding: "pcm16le",
						sampleRate: 16_000,
						channels: 1,
						chunkMs: 100,
					},
				},
			}),
		);
	};
	socket.onerror = () => fail(new Error("websocket failed"));
	socket.onclose = () => {
		socketClosedResolve();
		if (!shuttingDown) fail(new Error("websocket closed"));
	};
	socket.onmessage = (raw) => {
		messageQueue = messageQueue
			.then(() => processServerMessage(raw.data))
			.catch((error) => fail(error));
	};
	deadline.signal.addEventListener(
		"abort",
		() => {
			fail(deadline?.signal.reason);
			try {
				socket?.close(1000, "deadline");
			} catch {
				// The deadline also aborts both fetches and pending waits.
			}
		},
		{ once: true },
	);

	await deadline.wait(ready);
	if (fatalError) throw fatalError;

	phase = "turns";
	for (const pcm of utterances) {
		const turn = newTurn();
		activeTurn = turn;
		for (let offset = 0; offset < pcm.byteLength; offset += 3_200) {
			socket.send(
				encodeBinaryAudioFrame({
					kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
					sequence: clientSequence,
					payload: pcm.slice(offset, offset + 3_200),
				}),
			);
			clientSequence += 1;
		}
		counts.commits += 1;
		pushTiming("audio.commit.client-send");
		socket.send(
			JSON.stringify({
				v: 1,
				type: "audio.commit",
				conversationId: created.conversationId,
				at: new Date().toISOString(),
				payload: {},
			}),
		);
		await deadline.wait(turn.promise);
		if (fatalError) throw fatalError;
	}
	await deadline.wait(messageQueue);
	if (fatalError) throw fatalError;
	if (
		activeTurn ||
		counts.transcriptFinal !== counts.commits ||
		counts.textDone !== counts.commits ||
		counts.audioDone !== counts.commits ||
		counts.audioSegments < counts.commits ||
		counts.playbackReady !== counts.audioSegments ||
		counts.playbackStarted !== counts.audioSegments
	) {
		throw new Error("incomplete journey");
	}
	candidatePassed = true;
} catch (error) {
	failureReason = deadline?.signal.aborted
		? "deadline_exceeded"
		: error instanceof DecoderUnavailableError
			? "decoder_unavailable"
			: error instanceof DecoderFailedError
				? "decoder_failed"
				: `${phase}_failed`;
} finally {
	try {
		await cleanup();
	} catch {
		candidatePassed = false;
		failureReason = deadline?.signal.aborted
			? "deadline_exceeded"
			: "shutdown_failed";
	}
	timings.total = elapsed();
	deadline?.dispose();
	report(
		candidatePassed && !failureReason ? "passed" : "failed",
		failureReason,
	);
	if (!candidatePassed || failureReason) process.exitCode = 1;
}
