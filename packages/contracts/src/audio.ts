import { NonEmptyUint8ArraySchema } from "./common";

/** Existing transport/playback ceiling for one complete server audio segment. */
export const COMPLETE_AUDIO_SEGMENT_MAX_BYTES = 5_000_000 as const;

/** The only WAV representation accepted for complete TTS audio segments. */
export const CANONICAL_TTS_WAV_FORMAT = Object.freeze({
	contentType: "audio/wav" as const,
	audioFormat: 1 as const,
	channels: 1 as const,
	sampleRate: 24_000 as const,
	byteRate: 48_000 as const,
	blockAlign: 2 as const,
	bitsPerSample: 16 as const,
	headerBytes: 44 as const,
});

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		bytes[offset + index] = value.charCodeAt(index);
	}
}

/**
 * Return true only for the exact bounded 44-byte-header RIFF/WAVE shape used by
 * complete TTS segments: PCM16LE, mono, 24 kHz, followed by one non-empty data
 * chunk. Extra chunks, trailing bytes, odd samples, and inconsistent lengths
 * are rejected.
 */
export function isCompleteCanonicalTtsWav(bytes: Uint8Array): boolean {
	if (!(bytes instanceof Uint8Array)) return false;
	const { headerBytes, blockAlign } = CANONICAL_TTS_WAV_FORMAT;
	if (
		bytes.byteLength < headerBytes + blockAlign ||
		bytes.byteLength > COMPLETE_AUDIO_SEGMENT_MAX_BYTES
	) {
		return false;
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		!hasAscii(bytes, 0, "RIFF") ||
		view.getUint32(4, true) !== bytes.byteLength - 8 ||
		!hasAscii(bytes, 8, "WAVE") ||
		!hasAscii(bytes, 12, "fmt ") ||
		view.getUint32(16, true) !== 16 ||
		view.getUint16(20, true) !== CANONICAL_TTS_WAV_FORMAT.audioFormat ||
		view.getUint16(22, true) !== CANONICAL_TTS_WAV_FORMAT.channels ||
		view.getUint32(24, true) !== CANONICAL_TTS_WAV_FORMAT.sampleRate ||
		view.getUint32(28, true) !== CANONICAL_TTS_WAV_FORMAT.byteRate ||
		view.getUint16(32, true) !== CANONICAL_TTS_WAV_FORMAT.blockAlign ||
		view.getUint16(34, true) !== CANONICAL_TTS_WAV_FORMAT.bitsPerSample ||
		!hasAscii(bytes, 36, "data")
	) {
		return false;
	}

	const dataByteLength = view.getUint32(40, true);
	return (
		dataByteLength > 0 &&
		dataByteLength % blockAlign === 0 &&
		dataByteLength === bytes.byteLength - headerBytes
	);
}

/** Strict complete-file canonical WAV validation for provider and WS boundaries. */
export const CanonicalTtsWavBytesSchema = NonEmptyUint8ArraySchema.refine(
	(bytes) => bytes.byteLength <= COMPLETE_AUDIO_SEGMENT_MAX_BYTES,
	{
		message: `Expected at most ${COMPLETE_AUDIO_SEGMENT_MAX_BYTES} WAV bytes`,
	},
).refine(isCompleteCanonicalTtsWav, {
	message: "Expected one complete canonical mono PCM16LE 24 kHz WAV file",
});

/**
 * Wrap complete little-endian PCM16 sample bytes in the canonical bounded WAV
 * container accepted by TtsAudioSegmentSchema and browser playback.
 */
export function encodeCanonicalTtsWav(
	pcm16le: Uint8Array,
): Uint8Array<ArrayBuffer> {
	if (!(pcm16le instanceof Uint8Array)) {
		throw new TypeError("PCM16 input must be Uint8Array bytes");
	}
	const maximumPcmBytes =
		COMPLETE_AUDIO_SEGMENT_MAX_BYTES - CANONICAL_TTS_WAV_FORMAT.headerBytes;
	if (pcm16le.byteLength === 0 || pcm16le.byteLength % 2 !== 0) {
		throw new TypeError(
			"PCM16 input must contain whole non-empty 16-bit samples",
		);
	}
	if (pcm16le.byteLength > maximumPcmBytes) {
		throw new RangeError("PCM16 input exceeds the complete WAV segment bound");
	}

	const output = new Uint8Array(
		CANONICAL_TTS_WAV_FORMAT.headerBytes + pcm16le.byteLength,
	);
	const view = new DataView(output.buffer);
	writeAscii(output, 0, "RIFF");
	view.setUint32(4, output.byteLength - 8, true);
	writeAscii(output, 8, "WAVE");
	writeAscii(output, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, CANONICAL_TTS_WAV_FORMAT.audioFormat, true);
	view.setUint16(22, CANONICAL_TTS_WAV_FORMAT.channels, true);
	view.setUint32(24, CANONICAL_TTS_WAV_FORMAT.sampleRate, true);
	view.setUint32(28, CANONICAL_TTS_WAV_FORMAT.byteRate, true);
	view.setUint16(32, CANONICAL_TTS_WAV_FORMAT.blockAlign, true);
	view.setUint16(34, CANONICAL_TTS_WAV_FORMAT.bitsPerSample, true);
	writeAscii(output, 36, "data");
	view.setUint32(40, pcm16le.byteLength, true);
	output.set(pcm16le, CANONICAL_TTS_WAV_FORMAT.headerBytes);
	return output;
}
