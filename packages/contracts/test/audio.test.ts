import { describe, expect, test } from "bun:test";
import {
	CANONICAL_TTS_WAV_FORMAT,
	CanonicalTtsWavBytesSchema,
	COMPLETE_AUDIO_SEGMENT_MAX_BYTES,
	encodeCanonicalTtsWav,
	isCompleteCanonicalTtsWav,
} from "../src";

function syntheticPcm(): Uint8Array<ArrayBuffer> {
	return new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]);
}

function mutateUint16(bytes: Uint8Array, offset: number, value: number) {
	const copy = bytes.slice();
	new DataView(copy.buffer).setUint16(offset, value, true);
	return copy;
}

function mutateUint32(bytes: Uint8Array, offset: number, value: number) {
	const copy = bytes.slice();
	new DataView(copy.buffer).setUint32(offset, value, true);
	return copy;
}

describe("canonical complete TTS WAV", () => {
	test("encodes exact bounded RIFF/WAVE PCM16LE mono 24 kHz bytes", () => {
		const pcm = syntheticPcm();
		const wav = encodeCanonicalTtsWav(pcm);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

		expect(Object.isFrozen(CANONICAL_TTS_WAV_FORMAT)).toBe(true);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
		expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe("WAVEfmt ");
		expect(view.getUint32(16, true)).toBe(16);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(24_000);
		expect(view.getUint32(28, true)).toBe(48_000);
		expect(view.getUint16(32, true)).toBe(2);
		expect(view.getUint16(34, true)).toBe(16);
		expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe("data");
		expect(view.getUint32(40, true)).toBe(pcm.byteLength);
		expect(wav.subarray(44)).toEqual(pcm);
		expect(isCompleteCanonicalTtsWav(wav)).toBe(true);
		expect(CanonicalTtsWavBytesSchema.safeParse(wav).success).toBe(true);
	});

	test("rejects malformed headers, format fields, lengths, raw PCM, and trailing data", () => {
		const valid = encodeCanonicalTtsWav(syntheticPcm());
		const changeAscii = (offset: number) => {
			const copy = valid.slice();
			copy[offset] = 0;
			return copy;
		};
		const trailing = new Uint8Array(valid.byteLength + 2);
		trailing.set(valid);

		const invalid = [
			new Uint8Array(),
			syntheticPcm(),
			valid.slice(0, 43),
			valid.slice(0, valid.byteLength - 1),
			changeAscii(0),
			changeAscii(8),
			changeAscii(12),
			changeAscii(36),
			mutateUint32(valid, 4, 0xffff_ffff),
			mutateUint32(valid, 16, 18),
			mutateUint16(valid, 20, 3),
			mutateUint16(valid, 22, 2),
			mutateUint32(valid, 24, 16_000),
			mutateUint32(valid, 28, 96_000),
			mutateUint16(valid, 32, 4),
			mutateUint16(valid, 34, 24),
			mutateUint32(valid, 40, 0),
			mutateUint32(valid, 40, 1),
			mutateUint32(valid, 40, 0xffff_ffff),
			trailing,
		];
		for (const bytes of invalid) {
			expect(isCompleteCanonicalTtsWav(bytes)).toBe(false);
			expect(CanonicalTtsWavBytesSchema.safeParse(bytes).success).toBe(false);
		}
	});

	test("fails closed at encoder and complete-segment size bounds", () => {
		expect(() => encodeCanonicalTtsWav(new Uint8Array())).toThrow("non-empty");
		expect(() => encodeCanonicalTtsWav(new Uint8Array([0]))).toThrow(
			"whole non-empty",
		);
		const maximumPcmBytes =
			COMPLETE_AUDIO_SEGMENT_MAX_BYTES - CANONICAL_TTS_WAV_FORMAT.headerBytes;
		const maximum = encodeCanonicalTtsWav(new Uint8Array(maximumPcmBytes));
		expect(maximum.byteLength).toBe(COMPLETE_AUDIO_SEGMENT_MAX_BYTES);
		expect(CanonicalTtsWavBytesSchema.safeParse(maximum).success).toBe(true);
		expect(() =>
			encodeCanonicalTtsWav(new Uint8Array(maximumPcmBytes + 2)),
		).toThrow("bound");
	});
});
