import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BINARY_AUDIO_FRAME_KIND,
	encodeBinaryAudioFrame,
	isCompleteMp3File,
} from "../../packages/contracts/src";
import { createDeterministicMp3Fixture } from "../../packages/test-fixtures/src";

const root = join(import.meta.dir, "../..");
const script = "scripts/local-voice-e2e-smoke.ts";
const appOrigin = "http://localhost:5173";
const conversationId = "01J00000000000000000000000";
const at = "2026-07-30T20:22:00.000Z";

type LoopbackMode =
	| "valid-two-segment"
	| "one-byte"
	| "non-mp3"
	| "header-valid-random"
	| "zero-final"
	| "double-final"
	| "stale-final"
	| "mismatched-generation"
	| "stalled-create"
	| "stalled-stop";

interface SmokeOutput {
	status: "passed" | "failed" | "not_run";
	reason?: string;
	counts: Record<string, number>;
}

async function run(
	env: Record<string, string | undefined>,
	args: string[] = [],
) {
	const child = Bun.spawn([process.execPath, "run", script, ...args], {
		cwd: root,
		env: { ...Bun.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function jsonEvent(
	sequence: number,
	type: string,
	payload: Record<string, unknown>,
): string {
	return JSON.stringify({
		v: 1,
		conversationId,
		seq: sequence,
		at,
		type,
		payload,
	});
}

function createHeaderValidRandomBody(): Uint8Array {
	const frameLength = 24;
	const bytes = new Uint8Array(frameLength * 10);
	for (let frame = 0; frame < 10; frame += 1) {
		const offset = frame * frameLength;
		bytes.set([0xff, 0xf3, 0x14, 0], offset);
		for (let index = 4; index < frameLength; index += 1) {
			bytes[offset + index] = (frame * 31 + index * 17) & 0xff;
		}
	}
	return bytes;
}

async function createFakeDecoder(source: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "botamin-t30-decoder-"));
	await writeFile(
		join(directory, "ffmpeg"),
		`#!${process.execPath}\n${source}\n`,
		{ mode: 0o700 },
	);
	return directory;
}

async function runLoopback(
	mode: LoopbackMode,
	fixtureTurns = 1,
	options: {
		timeoutMs?: number;
		env?: Record<string, string | undefined>;
	} = {},
) {
	let createRequests = 0;
	let stopRequests = 0;
	let stopWsMessages = 0;
	let playbackAcks = 0;
	let sequence = 0;
	let commits = 0;
	const firstTurnId = "01J00000000000000000000001";
	const mp3 = createDeterministicMp3Fixture();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			if (
				request.method === "POST" &&
				url.pathname === "/api/v1/conversations"
			) {
				createRequests += 1;
				if (mode === "stalled-create") {
					return new Promise<Response>(() => undefined);
				}
				return Response.json(
					{
						conversationId,
						wsUrl: `/ws/v1/conversations/${conversationId}`,
						clientToken: "loopback-client-token-at-least-32-characters",
						expiresAt: "2099-07-30T20:22:00.000Z",
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
					{ status: 201 },
				);
			}
			if (
				request.method === "POST" &&
				url.pathname === `/api/v1/conversations/${conversationId}/stop`
			) {
				stopRequests += 1;
				if (mode === "stalled-stop") {
					return new Promise<Response>(() => undefined);
				}
				return Response.json({ conversationId, stopped: true });
			}
			if (
				url.pathname === `/ws/v1/conversations/${conversationId}` &&
				bunServer.upgrade(request)
			) {
				return undefined;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				if (typeof raw !== "string") return;
				const event = JSON.parse(raw) as { type?: string };
				if (event.type === "playback.started") {
					playbackAcks += 1;
					return;
				}
				if (event.type === "session.stop") {
					stopWsMessages += 1;
					ws.close(1000, "stopped");
					return;
				}
				if (event.type === "client.hello") {
					ws.send(
						jsonEvent(++sequence, "session.ready", {
							state: "GREETING",
							resumeToken: "rotated-loopback-token-at-least-32-characters",
							clientConfig: {
								inputSampleRate: 16_000,
								inputEncoding: "pcm16le",
								chunkMs: 100,
								maxUtteranceMs: 60_000,
								maxPcmBytes: 1_920_000,
								outputContentType: "audio/mpeg",
								outputMode: "complete-phrase-segments",
							},
						}),
					);
					return;
				}
				if (event.type !== "audio.commit") return;
				commits += 1;
				if (mode === "zero-final") return;
				const turnId =
					mode === "stale-final" && commits === 2
						? firstTurnId
						: commits === 1
							? firstTurnId
							: "01J00000000000000000000011";
				const generationId =
					commits === 1
						? "01J00000000000000000000002"
						: "01J00000000000000000000012";
				ws.send(
					jsonEvent(++sequence, "transcript.final", { turnId, text: "ok" }),
				);
				if (mode === "double-final") {
					ws.send(
						jsonEvent(++sequence, "transcript.final", {
							turnId: "01J00000000000000000000021",
							text: "duplicate",
						}),
					);
					return;
				}
				if (mode === "stale-final" && commits === 2) return;
				ws.send(
					jsonEvent(++sequence, "assistant.text.delta", {
						generationId,
						text: "answer",
					}),
				);
				ws.send(
					jsonEvent(++sequence, "assistant.text.done", {
						generationId,
						fullText: "answer",
					}),
				);
				const metadataGeneration =
					mode === "mismatched-generation"
						? "01J00000000000000000000022"
						: generationId;
				const segmentTotal = mode === "valid-two-segment" ? 2 : 1;
				for (let segment = 0; segment < segmentTotal; segment += 1) {
					const payload =
						mode === "one-byte"
							? new Uint8Array([0xff])
							: mode === "non-mp3"
								? new TextEncoder().encode("not-an-mp3")
								: mode === "header-valid-random"
									? createHeaderValidRandomBody()
									: mp3;
					ws.send(
						jsonEvent(++sequence, "audio.segment", {
							generationId: metadataGeneration,
							segmentId:
								segment === 0
									? "01J00000000000000000000003"
									: "01J00000000000000000000004",
							sequence: segment,
							contentType: "audio/mpeg",
							byteLength: payload.byteLength,
							final: true,
						}),
					);
					ws.send(
						encodeBinaryAudioFrame({
							kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
							sequence: segment,
							payload,
						}),
					);
				}
				if (
					mode !== "one-byte" &&
					mode !== "non-mp3" &&
					mode !== "header-valid-random" &&
					mode !== "mismatched-generation"
				) {
					ws.send(
						jsonEvent(++sequence, "assistant.audio.done", { generationId }),
					);
				}
			},
		},
	});
	const started = performance.now();
	try {
		const result = await run(
			{
				BOTAMIN_EXTERNAL_VOICE_E2E: "1",
				BOTAMIN_VOICE_E2E_TIMEOUT_MS: String(options.timeoutMs ?? 300),
				...options.env,
			},
			[
				"--server-url",
				`http://127.0.0.1:${server.port}`,
				"--origin",
				appOrigin,
				"--fixture-turns",
				String(fixtureTurns),
			],
		);
		const lines = result.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		return {
			...result,
			output: JSON.parse(lines[0] as string) as SmokeOutput,
			elapsedMs: performance.now() - started,
			createRequests,
			stopRequests,
			stopWsMessages,
			playbackAcks,
		};
	} finally {
		server.stop(true);
	}
}

describe("T30 opt-in local voice smoke safety", () => {
	test("is external and inert without the explicit owner opt-in", async () => {
		const result = await run({ BOTAMIN_EXTERNAL_VOICE_E2E: undefined });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(output).toMatchObject({
			smoke: "local-voice-e2e",
			external: true,
			status: "not_run",
			reason: "opt_in_required",
			booking: false,
		});
	});

	test("configuration failures expose only the safe aggregate schema", async () => {
		const result = await run({ BOTAMIN_EXTERNAL_VOICE_E2E: "1" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(Object.keys(output).sort()).toEqual(
			[
				"booking",
				"counts",
				"eventTypes",
				"external",
				"models",
				"reason",
				"smoke",
				"status",
				"timingsMs",
			].sort(),
		);
		expect(result.stdout).not.toMatch(
			/"(?:conversationId|turnId|generationId|segmentId|bookingId|transcript|speech|key|audio|base64)"\s*:/iu,
		);
		const source = await readFile(join(root, script), "utf8");
		expect(source.match(/console\.(?:info|log|error|warn)/gu)).toEqual([
			"console.info",
		]);
		expect(source).toContain("BOTAMIN_EXTERNAL_VOICE_E2E");
		expect(source).toContain("--pcm");
		expect(source).toContain("--fixture");
		expect(source).toContain("context.decodeAudioData(exact.buffer)");
		expect(source).toContain("source.start(0)");
	});

	test("a known-valid fixture is decoder-accepted before two playback acknowledgements", async () => {
		const result = await runLoopback("valid-two-segment", 1, {
			timeoutMs: 3_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.output.status).toBe("passed");
		expect(result.output.counts).toMatchObject({
			commits: 1,
			transcriptFinal: 1,
			textDone: 1,
			audioSegments: 2,
			audioDone: 1,
			playbackReady: 2,
			localDecoderAccepts: 2,
			playbackStarted: 2,
		});
		expect(result.playbackAcks).toBe(2);
		expect(result.stopWsMessages).toBe(1);
		expect(result.stopRequests).toBe(1);
	});

	test("one-byte and non-MP3 payloads never acknowledge playback and exit nonzero", async () => {
		for (const mode of ["one-byte", "non-mp3"] as const) {
			const result = await runLoopback(mode);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("");
			expect(result.output.status).toBe("failed");
			expect(result.output.counts.playbackStarted).toBe(0);
			expect(result.playbackAcks).toBe(0);
		}
	});

	test("a structurally valid MP3 with random frame bodies is decoder-rejected without acknowledgement", async () => {
		expect(isCompleteMp3File(createHeaderValidRandomBody())).toBe(true);
		const result = await runLoopback("header-valid-random", 1, {
			timeoutMs: 2_000,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.output).toMatchObject({
			status: "failed",
			reason: "decoder_failed",
		});
		expect(result.output.counts.playbackReady).toBe(0);
		expect(result.output.counts.playbackStarted).toBe(0);
		expect(result.playbackAcks).toBe(0);
	});

	test("decoder crash output is suppressed and cannot acknowledge or pass", async () => {
		const directory = await createFakeDecoder(
			'console.error("private audio transcript must stay suppressed"); process.exit(23);',
		);
		try {
			const result = await runLoopback("valid-two-segment", 1, {
				timeoutMs: 1_000,
				env: { PATH: directory },
			});
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("");
			expect(result.stdout).not.toContain("private audio transcript");
			expect(result.output).toMatchObject({
				status: "failed",
				reason: "decoder_failed",
			});
			expect(result.playbackAcks).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("decoder timeout is killed by the overall deadline without acknowledgement", async () => {
		const directory = await createFakeDecoder("await Bun.sleep(10_000);");
		try {
			const result = await runLoopback("valid-two-segment", 1, {
				timeoutMs: 300,
				env: { PATH: directory },
			});
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("");
			expect(result.output).toMatchObject({
				status: "failed",
				reason: "deadline_exceeded",
			});
			expect(result.elapsedMs).toBeLessThan(2_000);
			expect(result.playbackAcks).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("an unavailable decoder fails the smoke safely without acknowledgement", async () => {
		const directory = await mkdtemp(join(tmpdir(), "botamin-t30-no-decoder-"));
		try {
			const result = await runLoopback("valid-two-segment", 1, {
				timeoutMs: 1_000,
				env: { PATH: directory },
			});
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("");
			expect(result.output).toMatchObject({
				status: "failed",
				reason: "decoder_unavailable",
			});
			expect(result.output.counts.playbackReady).toBe(0);
			expect(result.playbackAcks).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("per-commit state rejects zero, double, stale, and generation-mismatched finals", async () => {
		for (const item of [
			{ mode: "zero-final", turns: 1 },
			{ mode: "double-final", turns: 1 },
			{ mode: "stale-final", turns: 2 },
			{ mode: "mismatched-generation", turns: 1 },
		] as const) {
			const result = await runLoopback(item.mode, item.turns);
			expect(result.exitCode).toBe(1);
			expect(result.output.status).toBe("failed");
		}
	});

	test("one overall deadline bounds a stalled create and emits one safe failure", async () => {
		const result = await runLoopback("stalled-create");
		expect(result.exitCode).toBe(1);
		expect(result.output).toMatchObject({
			status: "failed",
			reason: "deadline_exceeded",
		});
		expect(result.stdout).not.toContain('"status":"passed"');
		expect(result.elapsedMs).toBeLessThan(2_000);
		expect(result.createRequests).toBe(1);
		expect(result.stopRequests).toBe(0);
	});

	test("a stalled REST stop prevents pass and remains inside the same overall deadline", async () => {
		const result = await runLoopback("stalled-stop");
		expect(result.exitCode).toBe(1);
		expect(result.output).toMatchObject({
			status: "failed",
			reason: "deadline_exceeded",
		});
		expect(result.stdout).not.toContain('"status":"passed"');
		expect(result.elapsedMs).toBeLessThan(2_000);
		expect(result.stopWsMessages).toBe(1);
		expect(result.stopRequests).toBe(1);
	});
});
