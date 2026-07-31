import { MpegAudioBytesSchema } from "@botamin/contracts";

/**
 * A 0.5-second 24 kHz mono MPEG-2 Layer III silence file (789 bytes).
 * The committed base64 is deterministic test data, not a generated artifact.
 */
const DETERMINISTIC_SHORT_MP3_BASE64 =
	"SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMgAAAAAAAAAAAAAA//OEwAAAAAAAAAAA" +
	"AEluZm8AAAAPAAAAFwAAAugASkpKSlJSUlJaWlpaWmNjY2Nra2trc3Nzc3N7e3t7hISEhIyMjIyM" +
	"lJSUlJycnJylpaWlpa2tra21tbW1vb29vb3GxsbGzs7OztbW1tbW3t7e3ufn5+fv7+/v7/f39/f/" +
	"////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQCoAAAAAAAAALoXQVCDwAAAAAAAAAAAAAAAAAA" +
	"AAAAAAAAAAAA//MUxAAAAANIAAAAAExBTUU0LjBVVVVV//MUxAsAAANIAAAAAFVVVVVVVVVVVVVV" +
	"//MUxBYAAANIAAAAAFVVVVVVVVVVVVVV//MUxCEAAANIAAAAAFVVVVVVVVVVVVVV//MUxCwAAANI" +
	"AAAAAFVVVVVVVVVVVVVV//MUxDcAAANIAAAAAFVVVVVVVVVVVVVV//MUxEIAAANIAAAAAFVVVVVV" +
	"VVVVVVVV//MUxE0AAANIAAAAAFVVVVVVVVVVVVVV//MUxFgAAANIAAAAAFVVVVVVVVVVVVVV//MU" +
	"xGMAAANIAAAAAFVVVVVVVVVVVVVV//MUxG4AAANIAAAAAFVVVVVVVVVVVVVV//MUxHkAAANIAAAA" +
	"AFVVVVVVVVVVVVVV//MUxIQAAANIAAAAAFVVVVVVVVVVVVVV//MUxI8AAANIAAAAAFVVVVVVVVVV" +
	"VVVV//MUxJoAAANIAAAAAFVVVVVVVVVVVVVV//MUxKUAAANIAAAAAFVVVVVVVVVVVVVV//MUxLAA" +
	"AANIAAAAAFVVVVVVVVVVVVVV//MUxLsAAANIAAAAAFVVVVVVVVVVVVVV//MUxMYAAANIAAAAAFVV" +
	"VVVVVVVVVVVV//MUxNEAAANIAAAAAFVVVVVVVVVVVVVV//MUxNwAAANIAAAAAFVVVVVVVVVVVVVV" +
	"//MUxOcAAANIAAAAAFVVVVVVVVVVVVVV//MUxPIAAANIAAAAAFVVVVVVVVVVVVVV";

const MALFORMED_MP3_BASE64 = "bm90LW1wMw==";

function decodeBase64Fixture(encoded: string): Uint8Array {
	const decoded = atob(encoded);
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/** Return an isolated copy of the known-valid deterministic short MP3. */
export function createDeterministicMp3Fixture(): Uint8Array {
	const fixture = decodeBase64Fixture(DETERMINISTIC_SHORT_MP3_BASE64);
	return MpegAudioBytesSchema.parse(fixture);
}

/** Return intentionally malformed, non-MP3 bytes for negative decoder tests. */
export function createMalformedMp3Fixture(): Uint8Array {
	return decodeBase64Fixture(MALFORMED_MP3_BASE64);
}

/** Return a deterministic prefix that is not a complete MP3 file. */
export function createTruncatedMp3Fixture(): Uint8Array {
	return createDeterministicMp3Fixture().slice(0, 32);
}

/** Return canonical malformed MP3 variants for decoder negative tests. */
export function createInvalidMp3Fixtures(): Readonly<{
	malformed: Uint8Array;
	truncated: Uint8Array;
}> {
	return Object.freeze({
		malformed: createMalformedMp3Fixture(),
		truncated: createTruncatedMp3Fixture(),
	});
}
