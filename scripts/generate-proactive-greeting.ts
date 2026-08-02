#!/usr/bin/env bun

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { loadOpenRouterVoiceConfig } from "../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterTtsAdapter } from "../apps/server/src/providers/openrouter/tts/adapter";
import { isCompleteMp3File } from "../apps/server/src/providers/openrouter/tts/mp3";
import { PROACTIVE_GREETING_COPY } from "../apps/web/src/components/proactiveGreetingContent";

const OPT_IN_ENV = "BOTAMIN_GENERATE_PROACTIVE_GREETING";
const OUTPUT_PATH = resolve(
	import.meta.dir,
	"../apps/web/public/assets/botamin-proactive-greeting.mp3",
);
const MAX_OUTPUT_BYTES = 2_000_000;
const TOTAL_TIMEOUT_MS = 30_000;

function print(result: Record<string, unknown>): void {
	console.info(
		JSON.stringify({ generator: "botamin-proactive-greeting", ...result }),
	);
}

if (Bun.env[OPT_IN_ENV] !== "1") {
	print({ status: "not_run", reason: "opt_in_required", bytes: 0 });
	process.exit(2);
}

const startedAt = Date.now();
const temporaryPath = `${OUTPUT_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
const abortController = new AbortController();
const timeout = setTimeout(() => abortController.abort(), TOTAL_TIMEOUT_MS);
timeout.unref();

try {
	const loaded = loadOpenRouterVoiceConfig();
	const config = {
		...loaded,
		tts: {
			...loaded.tts,
			connectTimeoutMs: Math.min(loaded.tts.connectTimeoutMs, 8_000),
			totalTimeoutMs: Math.min(loaded.tts.totalTimeoutMs, TOTAL_TIMEOUT_MS),
			maxRetries: 0 as const,
			maxResponseBytes: Math.min(loaded.tts.maxResponseBytes, MAX_OUTPUT_BYTES),
		},
	};
	const adapter = new OpenRouterTtsAdapter({ config });
	const result = await adapter.synthesize({
		conversationId: "01J00000000000000000000010",
		turnId: "01J00000000000000000000011",
		generationId: "01J00000000000000000000012",
		segmentId: "01J00000000000000000000013",
		text: PROACTIVE_GREETING_COPY,
		signal: abortController.signal,
	});
	if (
		result.contentType !== "audio/mpeg" ||
		result.bytes.byteLength === 0 ||
		result.bytes.byteLength > MAX_OUTPUT_BYTES ||
		!isCompleteMp3File(result.bytes)
	) {
		throw new Error("generated_audio_invalid");
	}

	await mkdir(dirname(OUTPUT_PATH), { recursive: true });
	const file = await open(temporaryPath, "wx", 0o644);
	try {
		await file.writeFile(result.bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	const persisted = new Uint8Array(await readFile(temporaryPath));
	if (
		persisted.byteLength !== result.bytes.byteLength ||
		!isCompleteMp3File(persisted)
	) {
		throw new Error("persisted_audio_invalid");
	}
	await rename(temporaryPath, OUTPUT_PATH);
	print({
		status: "generated",
		format: "mp3",
		bytes: persisted.byteLength,
		elapsedMs: Date.now() - startedAt,
		output: relative(resolve(import.meta.dir, ".."), OUTPUT_PATH),
	});
} catch {
	print({
		status: "failed",
		bytes: 0,
		elapsedMs: Date.now() - startedAt,
	});
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	await rm(temporaryPath, { force: true });
}
