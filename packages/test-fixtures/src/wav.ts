export const MONO_PCM16_16_KHZ_WAV_PROPERTIES = Object.freeze({
	contentType: "audio/wav" as const,
	audioFormat: 1 as const,
	channels: 1 as const,
	sampleRate: 16_000 as const,
	byteRate: 32_000 as const,
	blockAlign: 2 as const,
	bitsPerSample: 16 as const,
	headerBytes: 44 as const,
});

export const DETERMINISTIC_WAV_FIXTURE_PROPERTIES = Object.freeze({
	durationMs: 100 as const,
	sampleCount: 1_600 as const,
	dataByteLength: 3_200 as const,
	byteLength: 3_244 as const,
});

/** The canonical non-zero PCM samples used by the deterministic WAV fixture. */
export function createDeterministicPcm16Fixture(): Uint8Array {
	const pcm16 = new Uint8Array(
		DETERMINISTIC_WAV_FIXTURE_PROPERTIES.dataByteLength,
	);
	const view = new DataView(pcm16.buffer);
	view.setInt16(0, 1_000, true);
	view.setInt16(800 * 2, -1_000, true);
	return pcm16;
}

/** Raw provider-invalid PCM bytes, intentionally without a WAV container. */
export function createRawPcm16Fixture(): Uint8Array {
	return createDeterministicPcm16Fixture();
}

/** Return one isolated canonical 100 ms browser microphone PCM16 frame. */
export function createDeterministicPcm16Frame(): Uint8Array {
	return createDeterministicPcm16Fixture();
}

/** Return isolated bounded browser frames for an utterance fixture. */
export function createDeterministicPcm16Frames(): readonly Uint8Array[] {
	return Object.freeze([createDeterministicPcm16Frame()]);
}

export interface ParsedMonoPcm16Wav {
	contentType: "audio/wav";
	audioFormat: 1;
	channels: 1;
	sampleRate: 16_000;
	byteRate: 32_000;
	blockAlign: 2;
	bitsPerSample: 16;
	sampleCount: number;
	dataByteLength: number;
	pcm16: Uint8Array;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	let value = "";
	for (let index = 0; index < length; index += 1) {
		value += String.fromCharCode(bytes[offset + index] ?? -1);
	}
	return value;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		bytes[offset + index] = value.charCodeAt(index);
	}
}

/**
 * Wrap non-empty little-endian mono PCM16 bytes in the canonical 44-byte,
 * 16 kHz WAV shape used at the gateway-to-STT test boundary.
 */
export function encodeMonoPcm16Wav(pcm16: Uint8Array): Uint8Array {
	if (!(pcm16 instanceof Uint8Array)) {
		throw new TypeError("PCM16 input must be Uint8Array bytes");
	}
	if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) {
		throw new TypeError(
			"PCM16 input must contain whole non-empty 16-bit samples",
		);
	}
	const byteLength =
		MONO_PCM16_16_KHZ_WAV_PROPERTIES.headerBytes + pcm16.byteLength;
	if (byteLength - 8 > 0xffff_ffff) {
		throw new RangeError("PCM16 input is too large for a RIFF/WAV file");
	}

	const bytes = new Uint8Array(byteLength);
	const view = new DataView(bytes.buffer);
	writeAscii(bytes, 0, "RIFF");
	view.setUint32(4, bytes.byteLength - 8, true);
	writeAscii(bytes, 8, "WAVE");
	writeAscii(bytes, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, MONO_PCM16_16_KHZ_WAV_PROPERTIES.audioFormat, true);
	view.setUint16(22, MONO_PCM16_16_KHZ_WAV_PROPERTIES.channels, true);
	view.setUint32(24, MONO_PCM16_16_KHZ_WAV_PROPERTIES.sampleRate, true);
	view.setUint32(28, MONO_PCM16_16_KHZ_WAV_PROPERTIES.byteRate, true);
	view.setUint16(32, MONO_PCM16_16_KHZ_WAV_PROPERTIES.blockAlign, true);
	view.setUint16(34, MONO_PCM16_16_KHZ_WAV_PROPERTIES.bitsPerSample, true);
	writeAscii(bytes, 36, "data");
	view.setUint32(40, pcm16.byteLength, true);
	bytes.set(pcm16, MONO_PCM16_16_KHZ_WAV_PROPERTIES.headerBytes);
	return bytes;
}

/** Strictly parse the same canonical, provider-neutral WAV shape. */
export function parseMonoPcm16Wav(bytes: Uint8Array): ParsedMonoPcm16Wav {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError("WAV input must be Uint8Array bytes");
	}
	if (bytes.byteLength < MONO_PCM16_16_KHZ_WAV_PROPERTIES.headerBytes) {
		throw new TypeError("WAV is truncated");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
		throw new TypeError("Expected RIFF/WAVE");
	}
	if (view.getUint32(4, true) !== bytes.byteLength - 8) {
		throw new TypeError("WAV RIFF size mismatch");
	}
	if (readAscii(bytes, 12, 4) !== "fmt " || view.getUint32(16, true) !== 16) {
		throw new TypeError("Expected canonical PCM fmt chunk");
	}
	if (
		view.getUint16(20, true) !== MONO_PCM16_16_KHZ_WAV_PROPERTIES.audioFormat ||
		view.getUint16(22, true) !== MONO_PCM16_16_KHZ_WAV_PROPERTIES.channels ||
		view.getUint32(24, true) !== MONO_PCM16_16_KHZ_WAV_PROPERTIES.sampleRate ||
		view.getUint32(28, true) !== MONO_PCM16_16_KHZ_WAV_PROPERTIES.byteRate ||
		view.getUint16(32, true) !== MONO_PCM16_16_KHZ_WAV_PROPERTIES.blockAlign ||
		view.getUint16(34, true) !==
			MONO_PCM16_16_KHZ_WAV_PROPERTIES.bitsPerSample ||
		readAscii(bytes, 36, 4) !== "data"
	) {
		throw new TypeError("Expected mono PCM16 16 kHz WAV");
	}

	const dataByteLength = view.getUint32(40, true);
	if (
		dataByteLength === 0 ||
		dataByteLength % MONO_PCM16_16_KHZ_WAV_PROPERTIES.blockAlign !== 0 ||
		dataByteLength !==
			bytes.byteLength - MONO_PCM16_16_KHZ_WAV_PROPERTIES.headerBytes
	) {
		throw new TypeError("WAV data size mismatch");
	}
	const pcm16 = bytes.slice(MONO_PCM16_16_KHZ_WAV_PROPERTIES.headerBytes);
	return {
		...MONO_PCM16_16_KHZ_WAV_PROPERTIES,
		sampleCount: dataByteLength / MONO_PCM16_16_KHZ_WAV_PROPERTIES.blockAlign,
		dataByteLength,
		pcm16,
	};
}

/** Return an isolated copy of a valid deterministic 100 ms WAV fixture. */
export function createDeterministicWavFixture(): Uint8Array {
	const pcm16 = createDeterministicPcm16Fixture();
	const fixture = encodeMonoPcm16Wav(pcm16);
	parseMonoPcm16Wav(fixture);
	return fixture;
}

/** Return canonical WAV bytes that each violate exactly one parser invariant. */
export function createInvalidWavFixtures(): Readonly<{
	truncated: Uint8Array;
	emptyData: Uint8Array;
	wrongFormat: Uint8Array;
	wrongRiffSize: Uint8Array;
}> {
	const valid = createDeterministicWavFixture();
	const emptyData = valid.slice(
		0,
		MONO_PCM16_16_KHZ_WAV_PROPERTIES.headerBytes,
	);
	new DataView(emptyData.buffer).setUint32(4, 36, true);
	new DataView(emptyData.buffer).setUint32(40, 0, true);
	const wrongFormat = valid.slice();
	new DataView(wrongFormat.buffer).setUint16(20, 3, true);
	const wrongRiffSize = valid.slice();
	new DataView(wrongRiffSize.buffer).setUint32(4, valid.byteLength - 7, true);
	return Object.freeze({
		truncated: valid.slice(0, 43),
		emptyData,
		wrongFormat,
		wrongRiffSize,
	});
}

export function createMalformedWavFixture(): Uint8Array {
	return createInvalidWavFixtures().truncated;
}
