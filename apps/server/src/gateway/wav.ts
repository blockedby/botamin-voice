const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTE_RATE = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
export const WAV_HEADER_BYTES = 44 as const;
export const CANONICAL_PCM_100MS_BYTES = 3_200 as const;

export interface PcmUtteranceLimits {
	readonly maxUtteranceMs: number;
	readonly maxAudioBytes: number;
	readonly maxFramePayloadBytes?: number;
}

export class PcmUtteranceError extends Error {
	constructor(
		readonly code:
			| "INVALID_PCM_FRAME"
			| "AUDIO_SEQUENCE_INVALID"
			| "UTTERANCE_EMPTY"
			| "UTTERANCE_TOO_LARGE"
			| "UTTERANCE_ALREADY_COMMITTED",
	) {
		super(code);
		this.name = "PcmUtteranceError";
	}
}

/** Bounded, one-shot mono PCM16LE utterance assembler. */
export class PcmUtteranceAssembler {
	readonly #maximumPcmBytes: number;
	readonly #maximumFrameBytes: number;
	#chunks: Uint8Array[] = [];
	#bytes = 0;
	#committed = false;

	constructor(limits: PcmUtteranceLimits) {
		const durationBytes = Math.floor(limits.maxUtteranceMs * 32);
		this.#maximumPcmBytes = Math.min(
			durationBytes,
			Math.max(0, limits.maxAudioBytes - WAV_HEADER_BYTES),
		);
		this.#maximumFrameBytes = limits.maxFramePayloadBytes ?? 3_200;
		if (
			this.#maximumPcmBytes < CANONICAL_PCM_100MS_BYTES ||
			this.#maximumFrameBytes < CANONICAL_PCM_100MS_BYTES
		) {
			throw new RangeError(
				"PCM utterance limits must contain one canonical 100ms frame",
			);
		}
	}

	append(pcm16le: Uint8Array): void {
		if (this.#committed) {
			throw new PcmUtteranceError("UTTERANCE_ALREADY_COMMITTED");
		}
		if (
			!(pcm16le instanceof Uint8Array) ||
			pcm16le.byteLength === 0 ||
			pcm16le.byteLength % BYTES_PER_SAMPLE !== 0 ||
			pcm16le.byteLength > this.#maximumFrameBytes
		) {
			throw new PcmUtteranceError("INVALID_PCM_FRAME");
		}
		if (this.#bytes + pcm16le.byteLength > this.#maximumPcmBytes) {
			this.clear();
			throw new PcmUtteranceError("UTTERANCE_TOO_LARGE");
		}
		this.#chunks.push(pcm16le.slice());
		this.#bytes += pcm16le.byteLength;
	}

	commit(): Uint8Array {
		if (this.#committed) {
			throw new PcmUtteranceError("UTTERANCE_ALREADY_COMMITTED");
		}
		if (this.#bytes === 0) throw new PcmUtteranceError("UTTERANCE_EMPTY");
		this.#committed = true;
		const pcm = new Uint8Array(this.#bytes);
		let offset = 0;
		for (const chunk of this.#chunks) {
			pcm.set(chunk, offset);
			offset += chunk.byteLength;
		}
		this.#chunks = [];
		this.#bytes = 0;
		return encodeCanonicalPcm16Wav(pcm);
	}

	clear(): void {
		this.#chunks = [];
		this.#bytes = 0;
	}

	get hasAudio(): boolean {
		return this.#bytes > 0;
	}

	get committed(): boolean {
		return this.#committed;
	}
}

/** Creates the strict 44-byte RIFF/WAVE accepted by OpenRouterSttAdapter. */
export function encodeCanonicalPcm16Wav(pcm16le: Uint8Array): Uint8Array {
	if (
		!(pcm16le instanceof Uint8Array) ||
		pcm16le.byteLength === 0 ||
		pcm16le.byteLength % BYTES_PER_SAMPLE !== 0 ||
		pcm16le.byteLength > 0xffff_ffff - 36
	) {
		throw new PcmUtteranceError("INVALID_PCM_FRAME");
	}
	const output = new Uint8Array(WAV_HEADER_BYTES + pcm16le.byteLength);
	const view = new DataView(output.buffer);
	writeAscii(output, 0, "RIFF");
	view.setUint32(4, output.byteLength - 8, true);
	writeAscii(output, 8, "WAVE");
	writeAscii(output, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, CHANNELS, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, BYTE_RATE, true);
	view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);
	writeAscii(output, 36, "data");
	view.setUint32(40, pcm16le.byteLength, true);
	output.set(pcm16le, WAV_HEADER_BYTES);
	return output;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		target[offset + index] = value.charCodeAt(index);
	}
}
