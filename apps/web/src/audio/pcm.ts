export const PCM16_BYTES_PER_SAMPLE = 2 as const;
export const TARGET_SAMPLE_RATE = 16_000 as const;
export const CANONICAL_CHUNK_MS = 100 as const;
export const CANONICAL_SAMPLES_PER_FRAME =
	(TARGET_SAMPLE_RATE * CANONICAL_CHUNK_MS) / 1_000;
export const CANONICAL_FRAME_BYTES =
	CANONICAL_SAMPLES_PER_FRAME * PCM16_BYTES_PER_SAMPLE;

/** Convert normalized Web Audio samples to signed PCM16 values. */
export function float32ToPcm16(input: Float32Array): Int16Array {
	const output = new Int16Array(input.length);
	for (let index = 0; index < input.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
		output[index] =
			sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
	}
	return output;
}

/** Serialize signed PCM16 values explicitly as little-endian bytes. */
export function pcm16Bytes(samples: Int16Array): Uint8Array {
	const bytes = new Uint8Array(samples.length * PCM16_BYTES_PER_SAMPLE);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < samples.length; index += 1) {
		view.setInt16(index * PCM16_BYTES_PER_SAMPLE, samples[index] ?? 0, true);
	}
	return bytes;
}

export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
	assertAlignedPcm16(bytes, false);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Int16Array(bytes.byteLength / PCM16_BYTES_PER_SAMPLE);
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = view.getInt16(index * PCM16_BYTES_PER_SAMPLE, true);
	}
	return samples;
}

export function assertAlignedPcm16(bytes: Uint8Array, allowEmpty = true): void {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError("PCM16 payload must be Uint8Array bytes");
	}
	if ((!allowEmpty && bytes.byteLength === 0) || bytes.byteLength % 2 !== 0) {
		throw new RangeError("PCM16 payload must contain whole 16-bit samples");
	}
}

/**
 * Split PCM16 into canonical 100 ms payloads. The only retained data is a
 * remainder smaller than one frame; finish() returns that final short frame.
 */
export class Pcm16FrameBatcher {
	private pending = new Uint8Array(0);

	push(bytes: Uint8Array): Uint8Array[] {
		assertAlignedPcm16(bytes);
		if (bytes.byteLength === 0) return [];

		const joined = new Uint8Array(this.pending.byteLength + bytes.byteLength);
		joined.set(this.pending);
		joined.set(bytes, this.pending.byteLength);

		const frameCount = Math.floor(joined.byteLength / CANONICAL_FRAME_BYTES);
		const frames = Array.from({ length: frameCount }, (_, index) =>
			joined.slice(
				index * CANONICAL_FRAME_BYTES,
				(index + 1) * CANONICAL_FRAME_BYTES,
			),
		);
		this.pending = joined.slice(frameCount * CANONICAL_FRAME_BYTES);
		return frames;
	}

	finish(): Uint8Array | null {
		if (this.pending.byteLength === 0) return null;
		const finalFrame = this.pending;
		this.pending = new Uint8Array(0);
		return finalFrame;
	}

	reset(): void {
		this.pending = new Uint8Array(0);
	}

	get pendingBytes(): number {
		return this.pending.byteLength;
	}
}
