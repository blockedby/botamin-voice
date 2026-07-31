import {
	BINARY_AUDIO_FRAME_KIND,
	decodeBinaryAudioFrame,
	type SttTranscriptionRequest,
} from "../../packages/contracts/src";
import { encodeMonoPcm16Wav } from "../../packages/test-fixtures/src";

export interface ReferenceGatewayAssemblerOptions {
	maxPcmBytes: number;
	maxDurationMs: number;
	maxFrameBytes?: number;
}

export interface ReferenceCommitIdentity {
	conversationId: string;
	turnId: string;
	language?: string;
	signal?: AbortSignal;
}

/**
 * T22 test-only executable specification for the missing runtime gateway
 * assembler. Replace or compare this class with the production T30 assembler.
 */
export class T30ReferenceGatewayUtteranceAssembler {
	readonly #maxPcmBytes: number;
	readonly #maxFrameBytes: number;
	readonly #frames: Uint8Array[] = [];
	#nextSequence = 0;
	#pcmBytes = 0;
	#committed = false;

	constructor(options: ReferenceGatewayAssemblerOptions) {
		if (
			!Number.isSafeInteger(options.maxPcmBytes) ||
			options.maxPcmBytes < 2 ||
			options.maxPcmBytes % 2 !== 0
		) {
			throw new RangeError("Reference assembler max PCM bytes must be aligned");
		}
		const maxFrameBytes = options.maxFrameBytes ?? 3_200;
		if (
			!Number.isSafeInteger(maxFrameBytes) ||
			maxFrameBytes < 2 ||
			maxFrameBytes % 2 !== 0
		) {
			throw new RangeError(
				"Reference assembler max frame bytes must be aligned",
			);
		}
		if (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0) {
			throw new RangeError("Reference assembler duration must be positive");
		}
		const durationBytes =
			Math.floor((options.maxDurationMs * 16_000) / 1_000) * 2;
		if (durationBytes < 2) {
			throw new RangeError("Reference assembler duration must fit one sample");
		}
		this.#maxPcmBytes = Math.min(options.maxPcmBytes, durationBytes);
		this.#maxFrameBytes = maxFrameBytes;
	}

	appendBinaryFrame(rawFrame: Uint8Array): void {
		if (this.#committed) throw new Error("Utterance is already committed");
		const frame = decodeBinaryAudioFrame(rawFrame);
		if (frame.kind !== BINARY_AUDIO_FRAME_KIND.clientPcm16) {
			throw new TypeError("Reference assembler accepts client PCM16 only");
		}
		if (frame.sequence !== this.#nextSequence) {
			throw new TypeError("Reference assembler requires contiguous sequence");
		}
		if (
			frame.payload.byteLength === 0 ||
			frame.payload.byteLength % 2 !== 0 ||
			frame.payload.byteLength > this.#maxFrameBytes
		) {
			throw new RangeError("Reference assembler rejected malformed PCM frame");
		}
		if (this.#pcmBytes + frame.payload.byteLength > this.#maxPcmBytes) {
			throw new RangeError("Reference assembler utterance exceeds its bound");
		}
		this.#frames.push(frame.payload.slice());
		this.#pcmBytes += frame.payload.byteLength;
		this.#nextSequence += 1;
	}

	commit(identity: ReferenceCommitIdentity): SttTranscriptionRequest | null {
		if (this.#committed) return null;
		if (this.#pcmBytes === 0) {
			throw new TypeError(
				"Reference assembler cannot commit an empty utterance",
			);
		}
		this.#committed = true;
		const pcm = new Uint8Array(this.#pcmBytes);
		let offset = 0;
		for (const frame of this.#frames) {
			pcm.set(frame, offset);
			offset += frame.byteLength;
		}
		return {
			conversationId: identity.conversationId,
			turnId: identity.turnId,
			audio: encodeMonoPcm16Wav(pcm),
			contentType: "audio/wav",
			language: identity.language ?? "ru",
			signal: identity.signal ?? new AbortController().signal,
		};
	}

	get acceptedPcmBytes(): number {
		return this.#pcmBytes;
	}
}
