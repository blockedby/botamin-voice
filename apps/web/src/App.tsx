import type { AudioClientConfig } from "@botamin/contracts";

const audioConfig = {
	inputSampleRate: 16_000,
	inputEncoding: "pcm16le",
	chunkMs: 100,
	outputContentType: "audio/mpeg",
	outputMode: "complete-phrase-segments",
} satisfies AudioClientConfig;

export function App() {
	return (
		<main>
			<h1>Botamin Voice</h1>
			<p>Application shell is ready for voice-client integration.</p>
			<p>
				Shared audio contract: {audioConfig.inputSampleRate} Hz{" "}
				{audioConfig.inputEncoding} input / {audioConfig.outputContentType}{" "}
				{audioConfig.outputMode} output.
			</p>
		</main>
	);
}
