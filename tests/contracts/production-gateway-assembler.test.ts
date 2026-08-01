import { describe, expect, test } from "bun:test";
import { PcmUtteranceAssembler } from "../../apps/server/src/gateway/wav";
import { CANONICAL_FRAME_BYTES } from "../../apps/web/src/audio/pcm";
import { decodeAndPairServerSegment } from "../../apps/web/src/transport/binary";
import {
	VoiceTransport,
	type WebSocketLike,
} from "../../apps/web/src/transport/ws";
import {
	BINARY_AUDIO_FRAME_KIND,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
} from "../../packages/contracts/src";
import {
	createDeterministicMp3Fixture,
	createDeterministicPcm16Fixture,
	createDeterministicWavFixture,
	parseMonoPcm16Wav,
} from "../../packages/test-fixtures/src";

const conversationId = "01J00000000000000000000000";
const generationId = "01J00000000000000000000002";
const segmentId = "01J00000000000000000000003";
const at = "2026-07-30T20:22:00.000Z";

class LoopbackSocket implements WebSocketLike {
	readyState = 0;
	binaryType?: BinaryType;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly sent: Array<string | Uint8Array> = [];

	send(data: string | Uint8Array): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
	}
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}
	serverJson(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
}

function readyEvent() {
	return {
		v: 1,
		conversationId,
		seq: 1,
		at,
		type: "session.ready",
		payload: {
			state: "GREETING",
			resumeToken: "reference-resume-token",
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

describe("production gateway utterance assembler", () => {
	test("bounded browser PCM plus one accepted commit creates exactly one canonical WAV", () => {
		const socket = new LoopbackSocket();
		const transport = new VoiceTransport({
			conversationId,
			url: "ws://fixture",
			createWebSocket: () => socket,
			now: () => new Date(at),
		});
		transport.connect();
		socket.open();
		socket.serverJson(readyEvent());

		const pcm = createDeterministicPcm16Fixture();
		expect(pcm.byteLength).toBe(CANONICAL_FRAME_BYTES);
		expect(transport.sendPcmFrame(pcm)).toBe(true);
		expect(transport.commit()).toBe(true);
		expect(transport.commit()).toBe(false);

		const binaryFrames = socket.sent.filter(
			(value): value is Uint8Array => value instanceof Uint8Array,
		);
		const commits = socket.sent
			.filter((value): value is string => typeof value === "string")
			.map((value) => JSON.parse(value) as { type?: string })
			.filter((value) => value.type === "audio.commit");
		expect(binaryFrames).toHaveLength(1);
		expect(commits).toHaveLength(1);
		expect(
			decodeBinaryAudioFrame(binaryFrames[0] as Uint8Array).payload,
		).toEqual(pcm);

		const assembler = new PcmUtteranceAssembler({
			maxAudioBytes: CANONICAL_FRAME_BYTES + 44,
			maxUtteranceMs: 100,
			maxFramePayloadBytes: CANONICAL_FRAME_BYTES,
		});
		assembler.append(
			decodeBinaryAudioFrame(binaryFrames[0] as Uint8Array).payload,
		);
		const wav = assembler.commit();
		expect(() => assembler.commit()).toThrow(
			expect.objectContaining({ code: "UTTERANCE_ALREADY_COMMITTED" }),
		);
		expect(wav).toEqual(createDeterministicWavFixture());
		expect(parseMonoPcm16Wav(wav)).toMatchObject({
			channels: 1,
			sampleRate: 16_000,
			bitsPerSample: 16,
			dataByteLength: pcm.byteLength,
			pcm16: pcm,
		});
	});

	test("production bounds malformed, oversized and duplicate input before SttPort", () => {
		const assembler = new PcmUtteranceAssembler({
			maxAudioBytes: 3_244,
			maxUtteranceMs: 100,
			maxFramePayloadBytes: 3_200,
		});
		expect(() => assembler.commit()).toThrow(
			expect.objectContaining({ code: "UTTERANCE_EMPTY" }),
		);
		expect(() => assembler.append(new Uint8Array([0]))).toThrow(
			expect.objectContaining({ code: "INVALID_PCM_FRAME" }),
		);
		expect(() => assembler.append(new Uint8Array(3_202))).toThrow(
			expect.objectContaining({ code: "INVALID_PCM_FRAME" }),
		);

		assembler.append(new Uint8Array(3_200));
		expect(() => assembler.append(new Uint8Array(2))).toThrow(
			expect.objectContaining({ code: "UTTERANCE_TOO_LARGE" }),
		);
		expect(assembler.hasAudio).toBe(false);
	});

	test("browser server-audio codec preserves a complete canonical MP3 payload", () => {
		const mp3 = createDeterministicMp3Fixture();
		const metadata = {
			generationId,
			segmentId,
			sequence: 7,
			contentType: "audio/mpeg" as const,
			byteLength: mp3.byteLength,
			final: true as const,
		};
		const raw = encodeBinaryAudioFrame({
			kind: BINARY_AUDIO_FRAME_KIND.serverMp3Segment,
			sequence: metadata.sequence,
			payload: mp3,
		});
		expect(decodeAndPairServerSegment(metadata, raw)).toEqual(mp3);
	});
});
