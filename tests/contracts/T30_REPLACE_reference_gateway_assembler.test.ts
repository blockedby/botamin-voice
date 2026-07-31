import { describe, expect, test } from "bun:test";
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
import { T30ReferenceGatewayUtteranceAssembler } from "../fixtures/reference-gateway-utterance-assembler";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000001";
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
				outputContentType: "audio/mpeg",
				outputMode: "complete-phrase-segments",
			},
		},
	};
}

describe("T30 REPLACE/COMPARE: test-only reference gateway utterance assembler", () => {
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

		const assembler = new T30ReferenceGatewayUtteranceAssembler({
			maxPcmBytes: CANONICAL_FRAME_BYTES,
			maxDurationMs: 100,
		});
		assembler.appendBinaryFrame(binaryFrames[0] as Uint8Array);
		const request = assembler.commit({ conversationId, turnId });
		expect(request).not.toBeNull();
		expect(assembler.commit({ conversationId, turnId })).toBeNull();
		expect(request?.contentType).toBe("audio/wav");
		expect(request?.audio).toEqual(createDeterministicWavFixture());
		expect(parseMonoPcm16Wav(request?.audio as Uint8Array)).toMatchObject({
			channels: 1,
			sampleRate: 16_000,
			bitsPerSample: 16,
			dataByteLength: pcm.byteLength,
			pcm16: pcm,
		});
	});

	test("reference bounds malformed, oversized and duplicate input before SttPort", () => {
		const assembler = new T30ReferenceGatewayUtteranceAssembler({
			maxPcmBytes: 4,
			maxDurationMs: 100,
			maxFrameBytes: 4,
		});
		expect(() => assembler.commit({ conversationId, turnId })).toThrow("empty");
		expect(() =>
			assembler.appendBinaryFrame(
				encodeBinaryAudioFrame({
					kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
					sequence: 0,
					payload: new Uint8Array([0]),
				}),
			),
		).toThrow("malformed PCM");
		expect(() =>
			assembler.appendBinaryFrame(
				encodeBinaryAudioFrame({
					kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
					sequence: 0,
					payload: new Uint8Array(6),
				}),
			),
		).toThrow("malformed PCM");

		const overDuration = new T30ReferenceGatewayUtteranceAssembler({
			maxPcmBytes: 3_200,
			maxDurationMs: 1,
			maxFrameBytes: 3_200,
		});
		expect(() =>
			overDuration.appendBinaryFrame(
				encodeBinaryAudioFrame({
					kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
					sequence: 0,
					payload: new Uint8Array(34),
				}),
			),
		).toThrow("exceeds its bound");
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
