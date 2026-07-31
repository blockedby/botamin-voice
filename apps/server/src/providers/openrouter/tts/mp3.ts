const MPEG1_LAYER3_BITRATES_KBPS = [
	0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;
const MPEG2_LAYER3_BITRATES_KBPS = [
	0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
] as const;
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const;

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

function id3v2End(bytes: Uint8Array): number | null {
	if (!ascii(bytes, 0, "ID3")) return 0;
	if (bytes.byteLength < 10) return null;
	const flags = bytes[5] ?? 0;
	const size6 = bytes[6];
	const size7 = bytes[7];
	const size8 = bytes[8];
	const size9 = bytes[9];
	if (
		size6 === undefined ||
		size7 === undefined ||
		size8 === undefined ||
		size9 === undefined ||
		[size6, size7, size8, size9].some((value) => (value & 0x80) !== 0)
	) {
		return null;
	}
	const size = (((((size6 << 7) | size7) << 7) | size8) << 7) | size9;
	const end = 10 + size + ((flags & 0x10) === 0 ? 0 : 10);
	return end <= bytes.byteLength ? end : null;
}

function frameLength(bytes: Uint8Array, offset: number): number | null {
	const byte0 = bytes[offset];
	const byte1 = bytes[offset + 1];
	const byte2 = bytes[offset + 2];
	if (byte0 === undefined || byte1 === undefined || byte2 === undefined) {
		return null;
	}
	if (byte0 !== 0xff || (byte1 & 0xe0) !== 0xe0) return null;
	const versionBits = (byte1 >> 3) & 0x03;
	const layerBits = (byte1 >> 1) & 0x03;
	const bitrateIndex = (byte2 >> 4) & 0x0f;
	const sampleRateIndex = (byte2 >> 2) & 0x03;
	if (
		versionBits === 0x01 ||
		layerBits !== 0x01 ||
		bitrateIndex === 0 ||
		bitrateIndex === 0x0f ||
		sampleRateIndex === 0x03
	) {
		return null;
	}
	const mpeg1 = versionBits === 0x03;
	const bitrateKbps = (
		mpeg1 ? MPEG1_LAYER3_BITRATES_KBPS : MPEG2_LAYER3_BITRATES_KBPS
	)[bitrateIndex];
	const mpeg1SampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex];
	if (bitrateKbps === undefined || mpeg1SampleRate === undefined) return null;
	const sampleRate =
		versionBits === 0x00
			? mpeg1SampleRate / 4
			: versionBits === 0x02
				? mpeg1SampleRate / 2
				: mpeg1SampleRate;
	const padding = (byte2 >> 1) & 0x01;
	return (
		Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1_000) / sampleRate) +
		padding
	);
}

/**
 * Require the complete response to consist of an optional ID3v2 tag, one or
 * more contiguous complete Layer III frames, and an optional final ID3v1 tag.
 */
export function isCompleteMp3File(bytes: Uint8Array): boolean {
	let offset = id3v2End(bytes);
	if (offset === null) return false;
	let frames = 0;
	while (offset < bytes.byteLength) {
		if (
			frames > 0 &&
			bytes.byteLength - offset === 128 &&
			ascii(bytes, offset, "TAG")
		) {
			offset = bytes.byteLength;
			break;
		}
		const length = frameLength(bytes, offset);
		if (length === null || length < 4 || offset + length > bytes.byteLength) {
			return false;
		}
		offset += length;
		frames += 1;
	}
	return frames > 0 && offset === bytes.byteLength;
}
