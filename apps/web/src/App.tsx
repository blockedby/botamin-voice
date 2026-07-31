import type { AudioClientConfig } from "@botamin/contracts";

const audioConfig = {
	inputSampleRate: 16_000,
	inputEncoding: "pcm16le",
	chunkMs: 100,
	outputSampleRate: 24_000,
} satisfies AudioClientConfig;

export function App() {
	return (
		<main>
			<h1>Botamin Voice</h1>
			<p>Application shell is ready for voice-client integration.</p>
			<p>
				Shared audio contract: {audioConfig.inputSampleRate} Hz input /{" "}
				{audioConfig.outputSampleRate} Hz output.
			</p>
		</main>
	);
}
