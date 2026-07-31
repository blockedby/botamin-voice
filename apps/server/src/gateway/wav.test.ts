import { describe, expect, test } from "bun:test";
import { encodeCanonicalPcm16Wav, PcmUtteranceAssembler } from "./wav";

describe("gateway canonical PCM16 to WAV", () => {
	test("encodes one accepted utterance into the exact strict mono PCM16 16 kHz WAV", () => {
		const first = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		const second = new Uint8Array([0x05, 0x06]);
		const assembler = new PcmUtteranceAssembler({
			maxUtteranceMs: 1_000,
			maxAudioBytes: 32_044,
			maxFramePayloadBytes: 3_200,
		});
		assembler.append(first);
		assembler.append(second);
		const wav = assembler.commit();
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
		expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
		expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint32(28, true)).toBe(32_000);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(6);
		expect(wav.subarray(44)).toEqual(
			new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
		);
		expect(() => assembler.commit()).toThrow("UTTERANCE_ALREADY_COMMITTED");
	});

	test("rejects malformed PCM, per-frame excess, and accumulated duration/bytes", () => {
		const assembler = new PcmUtteranceAssembler({
			maxUtteranceMs: 100,
			maxAudioBytes: 3_244,
			maxFramePayloadBytes: 3_200,
		});
		expect(() => assembler.append(new Uint8Array([1]))).toThrow(
			"INVALID_PCM_FRAME",
		);
		expect(() => assembler.append(new Uint8Array(3_202))).toThrow(
			"INVALID_PCM_FRAME",
		);
		assembler.append(new Uint8Array(3_200));
		expect(() => assembler.append(new Uint8Array([0, 0]))).toThrow(
			"UTTERANCE_TOO_LARGE",
		);
		expect(assembler.hasAudio).toBe(false);
	});

	test("standalone encoder never accepts empty or odd raw PCM", () => {
		expect(() => encodeCanonicalPcm16Wav(new Uint8Array())).toThrow(
			"INVALID_PCM_FRAME",
		);
		expect(() => encodeCanonicalPcm16Wav(new Uint8Array([0]))).toThrow(
			"INVALID_PCM_FRAME",
		);
	});
});
