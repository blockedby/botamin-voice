import {
	AtomicServerAudioSegmentFrameSchema,
	type AudioSegmentMetadata,
	BINARY_AUDIO_FRAME_KIND,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
} from "@botamin/contracts";

export {
	AtomicServerAudioSegmentFrameSchema,
	BINARY_AUDIO_FRAME_KIND,
	decodeBinaryAudioFrame,
	encodeBinaryAudioFrame,
};

/** Encode with the exact shared 9-byte kind/uint64-BE canonical codec. */
export function encodeClientPcmFrame(
	sequence: number,
	pcm16: Uint8Array,
): Uint8Array {
	return encodeBinaryAudioFrame({
		kind: BINARY_AUDIO_FRAME_KIND.clientPcm16,
		sequence,
		payload: pcm16,
	});
}

/** Validate adjacent metadata/frame identity and return an isolated MP3 copy. */
export function decodeAndPairServerSegment(
	metadata: AudioSegmentMetadata,
	rawFrame: Uint8Array,
): Uint8Array {
	const result = AtomicServerAudioSegmentFrameSchema.safeParse({
		metadata,
		rawFrame,
	});
	if (!result.success) {
		throw new Error(
			`Invalid audio.segment pairing: ${result.error.issues[0]?.message ?? "unknown error"}`,
		);
	}
	return decodeBinaryAudioFrame(rawFrame).payload;
}
