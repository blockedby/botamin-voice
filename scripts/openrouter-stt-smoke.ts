import {
	OpenRouterSttAdapter,
	type OpenRouterSttTelemetryEvent,
} from "../apps/server/src/providers/openrouter/stt/adapter";
import {
	loadOpenRouterVoiceConfig,
	OpenRouterVoiceConfigError,
} from "../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterSttError } from "../apps/server/src/providers/openrouter/stt/errors";

const DEFAULT_ARTIFACT_PATH = "/tmp/botamin-openrouter-stt-smoke.wav";
const SMOKE_ID = crypto.randomUUID();

function print(result: Record<string, unknown>): void {
	console.info(
		JSON.stringify({ smoke: "openrouter-stt", smokeId: SMOKE_ID, ...result }),
	);
}

if (Bun.env.OPENROUTER_EXTERNAL_SMOKE !== "1") {
	print({ status: "not_run", reason: "opt_in_required", bytes: 0 });
	process.exit(2);
}

const artifactPath = Bun.env.OPENROUTER_STT_SMOKE_WAV ?? DEFAULT_ARTIFACT_PATH;
if (!artifactPath.startsWith("/tmp/") || artifactPath.includes("..")) {
	print({ status: "invalid_artifact_path", bytes: 0, id: SMOKE_ID });
	process.exit(2);
}

const startedAt = Date.now();
let inputBytes = 0;
let latest: OpenRouterSttTelemetryEvent | undefined;
try {
	const config = loadOpenRouterVoiceConfig();
	const audio = new Uint8Array(await Bun.file(artifactPath).arrayBuffer());
	inputBytes = audio.byteLength;
	const adapter = new OpenRouterSttAdapter({
		config,
		telemetry: (event) => {
			latest = event;
		},
	});
	await adapter.transcribe({
		conversationId: "01J00000000000000000000000",
		turnId: "01J00000000000000000000001",
		audio,
		contentType: "audio/wav",
		language: config.stt.language,
		signal: new AbortController().signal,
	});
	print({
		status: latest?.status ?? 200,
		latencyMs: Date.now() - startedAt,
		bytes: inputBytes,
		id: latest?.providerRequestId ?? SMOKE_ID,
		model: config.stt.model,
		language: config.stt.language,
		format: config.stt.audioFormat,
	});
} catch (error) {
	const typed = error instanceof OpenRouterSttError ? error : undefined;
	const configError = error instanceof OpenRouterVoiceConfigError;
	print({
		status:
			typed?.status ??
			typed?.code ??
			(configError ? error.code : "local_error"),
		latencyMs: Date.now() - startedAt,
		bytes: inputBytes,
		id: SMOKE_ID,
	});
	process.exit(1);
}
