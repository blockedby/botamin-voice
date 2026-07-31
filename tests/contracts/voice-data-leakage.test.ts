import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OpenRouterSttAdapter,
	type OpenRouterSttTelemetryEvent,
} from "../../apps/server/src/providers/openrouter/stt/adapter";
import {
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../../apps/server/src/providers/openrouter/stt/config";
import {
	OpenRouterTtsAdapter,
	type OpenRouterTtsTelemetryEvent,
} from "../../apps/server/src/providers/openrouter/tts/adapter";
import {
	createDeterministicMp3Fixture,
	createDeterministicWavFixture,
	createOpenRouterFixture,
} from "../../packages/test-fixtures/src";

const key = "sk-or-v1-T22_SECRET_SENTINEL";
const transcriptPii = "Иван, +79990001122, ivan-private@example.test";
const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000001";
const generationId = "01J00000000000000000000002";
const segmentId = "01J00000000000000000000003";
const temporaryDirectories: string[] = [];

function config(): OpenRouterVoiceConfig {
	return {
		...loadOpenRouterVoiceConfig({
			OPENROUTER_API_KEY: key,
			STT_RETRY_BASE_MS: "0",
			TTS_RETRY_BASE_MS: "0",
		}),
		baseUrl: "http://fixture/api/v1",
	};
}

async function filesRecursively(path: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) result.push(...(await filesRecursively(child)));
		else result.push(child);
	}
	return result;
}

afterEach(async () => {
	for (const path of temporaryDirectories.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

describe("OpenRouter voice data leakage scans", () => {
	test("keys, base64/audio and transcript PII are absent from logs and telemetry snapshots", async () => {
		const wav = createDeterministicWavFixture();
		const mp3 = createDeterministicMp3Fixture();
		const fixture = createOpenRouterFixture({
			expectedWav: wav,
			expectedApiKey: key,
			transcript: transcriptPii,
			mp3,
		});
		const sttEvents: OpenRouterSttTelemetryEvent[] = [];
		const ttsEvents: OpenRouterTtsTelemetryEvent[] = [];
		const logs: string[] = [];
		const original = {
			info: console.info,
			warn: console.warn,
			error: console.error,
		};
		console.info = (...values: unknown[]) => logs.push(JSON.stringify(values));
		console.warn = (...values: unknown[]) => logs.push(JSON.stringify(values));
		console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
		try {
			const voice = config();
			await new OpenRouterSttAdapter({
				config: voice,
				fetch: fixture.fetch,
				telemetry: (event) => sttEvents.push(event),
			}).transcribe({
				conversationId,
				turnId,
				audio: wav,
				contentType: "audio/wav",
				language: "ru",
				signal: new AbortController().signal,
			});
			await new OpenRouterTtsAdapter({
				config: voice,
				fetch: fixture.fetch,
				telemetry: (event) => ttsEvents.push(event),
			}).synthesize({
				conversationId,
				turnId,
				generationId,
				segmentId,
				text: transcriptPii,
				signal: new AbortController().signal,
			});
		} finally {
			console.info = original.info;
			console.warn = original.warn;
			console.error = original.error;
		}

		const snapshot = JSON.stringify({ sttEvents, ttsEvents, logs });
		for (const forbidden of [
			key,
			transcriptPii,
			"79990001122",
			"ivan-private@example.test",
			Buffer.from(wav).toString("base64"),
			Buffer.from(mp3).toString("base64"),
		]) {
			expect(snapshot).not.toContain(forbidden);
		}
		expect(logs).toEqual([]);
		expect(fixture.protocolViolations).toEqual([]);
	});

	test("fresh browser production bundle contains no key namespace, provider URL, audio base64 or PII", async () => {
		const output = await mkdtemp(join(tmpdir(), "botamin-t22-client-bundle-"));
		temporaryDirectories.push(output);
		const process = Bun.spawn(
			[
				"bun",
				"run",
				"--cwd",
				"apps/web",
				"build",
				"--outDir",
				output,
				"--emptyOutDir",
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: { ...Bun.env, OPENROUTER_API_KEY: key },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
		const files = await filesRecursively(output);
		const bundle = (
			await Promise.all(files.map((path) => readFile(path, "utf8")))
		).join("\n");
		const wavBase64 = Buffer.from(createDeterministicWavFixture()).toString(
			"base64",
		);
		for (const forbidden of [
			key,
			"OPENROUTER_API_KEY",
			"openrouter.ai",
			wavBase64,
			transcriptPii,
			"79990001122",
		]) {
			expect(bundle).not.toContain(forbidden);
		}
	});
});
