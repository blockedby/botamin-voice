import { loadOpenRouterVoiceConfig } from "../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterTtsAdapter } from "../apps/server/src/providers/openrouter/tts/adapter";
import { OpenRouterTtsError } from "../apps/server/src/providers/openrouter/tts/errors";

const SAMPLE = "Здравствуйте! Это короткая проверка русской речи.";

function print(result: Record<string, unknown>): void {
	console.info(JSON.stringify({ smoke: "openrouter-tts", ...result }));
}

if (Bun.env.OPENROUTER_EXTERNAL_SMOKE !== "1") {
	print({ status: "not_run", reason: "opt_in_required", bytes: 0 });
	process.exit(2);
}

const startedAt = Date.now();
try {
	const config = loadOpenRouterVoiceConfig();
	const adapter = new OpenRouterTtsAdapter({ config });
	const result = await adapter.synthesize({
		conversationId: "01J00000000000000000000000",
		turnId: "01J00000000000000000000001",
		generationId: "01J00000000000000000000002",
		segmentId: "01J00000000000000000000003",
		text: SAMPLE,
		signal: new AbortController().signal,
	});
	print({
		status: "success",
		contentType: result.contentType,
		latencyMs: Date.now() - startedAt,
		bytes: result.bytes.byteLength,
	});
} catch (error) {
	const typed = error instanceof OpenRouterTtsError ? error : undefined;
	print({
		status: typed?.status ?? typed?.code ?? "local_error",
		latencyMs: Date.now() - startedAt,
		bytes: 0,
	});
	process.exit(1);
}
