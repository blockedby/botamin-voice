import { loadOpenRouterVoiceConfig } from "../apps/server/src/providers/openrouter/stt/config";
import {
	OpenRouterTtsAdapter,
	type OpenRouterTtsTelemetryEvent,
} from "../apps/server/src/providers/openrouter/tts/adapter";
import { OpenRouterTtsError } from "../apps/server/src/providers/openrouter/tts/errors";

const ARTIFACT_PATH = "/tmp/botamin-openrouter-tts-smoke.mp3";
const SAMPLE = "Здравствуйте! Это короткая проверка русской речи.";
const SMOKE_ID = crypto.randomUUID();

function print(result: Record<string, unknown>): void {
	console.info(
		JSON.stringify({ smoke: "openrouter-tts", smokeId: SMOKE_ID, ...result }),
	);
}

if (Bun.env.OPENROUTER_EXTERNAL_SMOKE !== "1") {
	print({ status: "not_run", reason: "opt_in_required", bytes: 0 });
	process.exit(2);
}

const startedAt = Date.now();
let latest: OpenRouterTtsTelemetryEvent | undefined;
try {
	const config = loadOpenRouterVoiceConfig();
	const adapter = new OpenRouterTtsAdapter({
		config,
		telemetry: (event) => {
			latest = event;
		},
	});
	const result = await adapter.synthesize({
		conversationId: "01J00000000000000000000000",
		turnId: "01J00000000000000000000001",
		generationId: "01J00000000000000000000002",
		segmentId: "01J00000000000000000000003",
		text: SAMPLE,
		signal: new AbortController().signal,
	});
	await Bun.write(ARTIFACT_PATH, result.bytes);
	print({
		status: latest?.status ?? 200,
		latencyMs: Date.now() - startedAt,
		bytes: result.bytes.byteLength,
		id: result.providerGenerationId ?? SMOKE_ID,
		model: config.tts.model,
		voice: config.tts.voice,
		format: config.tts.responseFormat,
		artifact: ARTIFACT_PATH,
	});
} catch (error) {
	const typed = error instanceof OpenRouterTtsError ? error : undefined;
	print({
		status: typed?.status ?? typed?.code ?? "local_error",
		latencyMs: Date.now() - startedAt,
		bytes: 0,
		id: SMOKE_ID,
	});
	process.exit(1);
}
