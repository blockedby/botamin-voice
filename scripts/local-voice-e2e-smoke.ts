/**
 * External, owner-operated smoke against an already-running voice server.
 *
 * BOTAMIN_EXTERNAL_VOICE_E2E=1 bun run scripts/local-voice-e2e-smoke.ts \
 *   --server-url http://127.0.0.1:3000 --origin http://localhost:5173 \
 *   --pcm /tmp/turn-1.pcm --pcm /tmp/turn-2.pcm
 *
 * Use --fixture or --fixture-turns N only for synthetic canonical PCM. The
 * script never synthesizes provider speech input and emits aggregate evidence.
 */
import {
	BINARY_AUDIO_FRAME_KIND,
	CreateConversationResponseSchema,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
	ServerWsEventSchema,
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
	return Math.min(300_000, Math.max(5_000, Number(raw)));
}

let socket: WebSocket | null = null;
let conversationId: string | null = null;
let args: Arguments | null = null;

try {
	args = readArguments(process.argv.slice(2));
	const utterances = await loadPcm(args);
	phase = "conversation_create";
	const createdResponse = await fetch(
		new URL("/api/v1/conversations", args.serverUrl),
		{
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
		},
	);
	if (createdResponse.status !== 201) throw new Error("create failed");
	const created = CreateConversationResponseSchema.parse(
		await createdResponse.json(),
	);
	conversationId = created.conversationId;

	phase = "websocket";
	const wsUrl = new URL(created.wsUrl, args.serverUrl);
	wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
	let readyResolve = (): void => undefined;
	let readyReject = (_error: unknown): void => undefined;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	let turnResolve = (): void => undefined;
	let turnReject = (_error: unknown): void => undefined;
	let waitingForTurn = false;
	let turnGenerationId: string | null = null;
	let lastCompletedGenerationId: string | null = null;
	let turnTextDone = false;
	let turnAudioDone = false;
	let turnPlaybackStarted = false;
	const matchesTurnGeneration = (generationId: string): boolean => {
		if (!waitingForTurn || generationId === lastCompletedGenerationId) {
			return false;
		}
		turnGenerationId ??= generationId;
		return turnGenerationId === generationId;
	};
	const resolveCompletedTurn = (): void => {
		if (
			waitingForTurn &&
			turnTextDone &&
			turnAudioDone &&
			turnPlaybackStarted
		) {
			waitingForTurn = false;
			lastCompletedGenerationId = turnGenerationId;
			turnResolve();
		}
	};
	let pendingAudio:
		| {
				generationId: string;
				sequence: number;
				byteLength: number;
		  }
		| undefined;
	let clientSequence = 0;

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
	socket.onerror = () => {
		readyReject(new Error("websocket failed"));
		if (waitingForTurn) turnReject(new Error("turn websocket failed"));
	};
	socket.onclose = () => {
		if (waitingForTurn) turnReject(new Error("websocket closed"));
	};
	socket.onmessage = (raw) => {
		if (typeof raw.data !== "string") {
			const bytes =
				raw.data instanceof ArrayBuffer
					? new Uint8Array(raw.data)
					: ArrayBuffer.isView(raw.data)
						? new Uint8Array(
								raw.data.buffer,
								raw.data.byteOffset,
								raw.data.byteLength,
							)
						: null;
			if (!bytes || !pendingAudio) {
				turnReject(new Error("unpaired audio"));
				return;
			}
			const frame = decodeBinaryAudioFrame(bytes);
			if (
				frame.kind !== BINARY_AUDIO_FRAME_KIND.serverMp3Segment ||
				frame.sequence !== pendingAudio.sequence ||
				frame.payload.byteLength !== pendingAudio.byteLength
			) {
				turnReject(new Error("invalid audio pair"));
				return;
			}
			if (!matchesTurnGeneration(pendingAudio.generationId)) {
				turnReject(new Error("stale audio pair"));
				return;
			}
			counts.responseMp3Bytes += frame.payload.byteLength;
			counts.playbackStarted += 1;
			turnPlaybackStarted = true;
			pushTiming("playback.started");
			socket?.send(
				JSON.stringify({
					v: 1,
					type: "playback.started",
					conversationId: created.conversationId,
					at: new Date().toISOString(),
					payload: { generationId: pendingAudio.generationId },
				}),
			);
			pendingAudio = undefined;
			resolveCompletedTurn();
			return;
		}
		let event: ReturnType<typeof ServerWsEventSchema.parse>;
		try {
			event = ServerWsEventSchema.parse(JSON.parse(raw.data));
		} catch {
			turnReject(new Error("invalid server event"));
			return;
		}
		eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
		switch (event.type) {
			case "session.ready":
				timings["session.ready"] ??= elapsed();
				readyResolve();
				break;
			case "transcript.final":
				counts.transcriptFinal += 1;
				pushTiming("transcript.final");
				break;
			case "assistant.text.delta":
				if (matchesTurnGeneration(event.payload.generationId)) {
					timings.firstTextDelta ??= elapsed();
				}
				break;
			case "assistant.text.done":
				counts.textDone += 1;
				if (matchesTurnGeneration(event.payload.generationId)) {
					turnTextDone = true;
					pushTiming("assistant.text.done");
					resolveCompletedTurn();
				}
				break;
			case "audio.segment":
				if (!matchesTurnGeneration(event.payload.generationId)) break;
				counts.audioSegments += 1;
				timings.firstAudioSegment ??= elapsed();
				pendingAudio = {
					generationId: event.payload.generationId,
					sequence: event.payload.sequence,
					byteLength: event.payload.byteLength,
				};
				break;
			case "assistant.audio.done":
				counts.audioDone += 1;
				if (matchesTurnGeneration(event.payload.generationId)) {
					turnAudioDone = true;
					pushTiming("assistant.audio.done");
					resolveCompletedTurn();
				}
				break;
			case "booking.created":
				booking = true;
				break;
		}
	};

	await Promise.race([
		ready,
		Bun.sleep(boundedTimeoutMs()).then(() => {
			throw new Error("ready timeout");
		}),
	]);

	phase = "turns";
	for (const pcm of utterances) {
		turnGenerationId = null;
		turnTextDone = false;
		turnAudioDone = false;
		turnPlaybackStarted = false;
		const turn = new Promise<void>((resolve, reject) => {
			turnResolve = resolve;
			turnReject = reject;
			waitingForTurn = true;
		});
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
		pushTiming("audio.commit");
		socket.send(
			JSON.stringify({
				v: 1,
				type: "audio.commit",
				conversationId: created.conversationId,
				at: new Date().toISOString(),
				payload: {},
			}),
		);
		await Promise.race([
			turn,
			Bun.sleep(boundedTimeoutMs()).then(() => {
				throw new Error("turn timeout");
			}),
		]);
	}

	if (
		counts.transcriptFinal !== counts.commits ||
		counts.textDone !== counts.commits ||
		counts.audioDone !== counts.commits ||
		counts.playbackStarted !== counts.commits ||
		pendingAudio !== undefined
	) {
		throw new Error("incomplete journey");
	}

	phase = "shutdown";
	timings.total = elapsed();
	socket.send(
		JSON.stringify({
			v: 1,
			type: "session.stop",
			conversationId: created.conversationId,
			at: new Date().toISOString(),
			payload: { reason: "user_requested" },
		}),
	);
	await Bun.sleep(20);
	report("passed");
} catch {
	timings.total = elapsed();
	report("failed", `${phase}_failed`);
	process.exitCode = 1;
} finally {
	try {
		socket?.close(1000, "smoke complete");
	} catch {
		// Already closed.
	}
	if (args && conversationId) {
		await fetch(
			new URL(
				`/api/v1/conversations/${encodeURIComponent(conversationId)}/stop`,
				args.serverUrl,
			),
			{
				method: "POST",
				headers: { "content-type": "application/json", origin: args.origin },
				body: JSON.stringify({ reason: "user_requested" }),
			},
		).catch(() => undefined);
	}
}
