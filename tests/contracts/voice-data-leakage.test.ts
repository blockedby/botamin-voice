import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
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

// Every value below is synthetic test data: .invalid is reserved, the phone has
// an invalid national prefix, and the credential is explicitly QA-only.
const key = "sk-or-v1-QA_ONLY_T22_ALPHA_BETA";
const phone = "+7-000-000-00-00";
const email = "voice.qa.t22@example.invalid";
const telegram = "@voice_qa_t22_private";
const transcriptPii = `Иван; ${phone}; ${email}; ${telegram}`;
const sttProviderBody = "QA_ONLY_T22_STT_PROVIDER_ERROR_BODY";
const ttsProviderBody = "QA_ONLY_T22_TTS_PROVIDER_ERROR_BODY";
const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000001";
const generationId = "01J00000000000000000000002";
const segmentId = "01J00000000000000000000003";
const temporaryDirectories: string[] = [];

interface CapturedOutput {
	channel: string;
	text: string;
}

type LeakageMarkers = Readonly<Record<string, string>>;

function config(): OpenRouterVoiceConfig {
	return {
		...loadOpenRouterVoiceConfig({
			OPENROUTER_API_KEY: key,
			STT_MAX_RETRIES: "0",
			STT_RETRY_BASE_MS: "0",
			TTS_MAX_RETRIES: "0",
			TTS_RETRY_BASE_MS: "0",
		}),
		baseUrl: "http://fixture/api/v1",
	};
}

function audioRender(bytes: Uint8Array): string {
	return `${new TextDecoder().decode(bytes)}\n${Buffer.from(bytes).toString(
		"base64",
	)}`;
}

function safeRender(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return audioRender(value);
	try {
		return inspect(value, {
			customInspect: false,
			depth: 8,
			getters: false,
			maxArrayLength: 10_000,
		});
	} catch {
		return "[unrenderable captured value]";
	}
}

async function captureProcessOutput(
	run: () => Promise<void>,
): Promise<readonly CapturedOutput[]> {
	const captured: CapturedOutput[] = [];
	const original = {
		log: console.log,
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
		stdoutWrite: process.stdout.write,
		stderrWrite: process.stderr.write,
	};
	const captureConsole =
		(channel: string) =>
		(...values: unknown[]): void => {
			captured.push({ channel, text: values.map(safeRender).join(" ") });
		};
	const captureWrite = (channel: string): typeof process.stdout.write =>
		((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
			const text =
				chunk instanceof Uint8Array
					? audioRender(chunk)
					: typeof chunk === "string"
						? chunk
						: safeRender(chunk);
			captured.push({ channel, text });
			const completion =
				typeof encodingOrCallback === "function"
					? encodingOrCallback
					: callback;
			if (typeof completion === "function") queueMicrotask(() => completion());
			return true;
		}) as typeof process.stdout.write;

	console.log = captureConsole("console.log");
	console.debug = captureConsole("console.debug");
	console.info = captureConsole("console.info");
	console.warn = captureConsole("console.warn");
	console.error = captureConsole("console.error");
	process.stdout.write = captureWrite("process.stdout");
	process.stderr.write = captureWrite("process.stderr");
	try {
		await run();
	} finally {
		console.log = original.log;
		console.debug = original.debug;
		console.info = original.info;
		console.warn = original.warn;
		console.error = original.error;
		process.stdout.write = original.stdoutWrite;
		process.stderr.write = original.stderrWrite;
	}
	return captured;
}

function leakageMarkers(): LeakageMarkers {
	const wavBase64 = Buffer.from(createDeterministicWavFixture()).toString(
		"base64",
	);
	const mp3Base64 = Buffer.from(createDeterministicMp3Fixture()).toString(
		"base64",
	);
	return Object.freeze({
		"key.full": key,
		"key.partial.leading": "sk-or-v1-QA_ONLY_T22_ALPHA",
		"key.partial.trailing": "T22_ALPHA_BETA",
		"audio.wav.base64": wavBase64,
		"audio.mp3.base64": mp3Base64,
		"provider.stt.body": sttProviderBody,
		"provider.tts.body": ttsProviderBody,
		"phone.full": phone,
		"phone.component": "70000000000",
		"email.full": email,
		"email.local": "voice.qa.t22",
		"email.domain": "example.invalid",
		"telegram.full": telegram,
		"telegram.username": "voice_qa_t22_private",
	});
}

function findLeaks(
	text: string,
	markers: LeakageMarkers = leakageMarkers(),
): string[] {
	return Object.entries(markers)
		.filter(([, marker]) => text.includes(marker))
		.map(([label]) => label);
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
	test("negative controls prove every sensitive marker is detected", () => {
		for (const [label, marker] of Object.entries(leakageMarkers())) {
			expect(findLeaks(`safe-prefix:${marker}:safe-suffix`), label).toContain(
				label,
			);
		}
	});

	test("capture gate intercepts every console and process output channel", async () => {
		const channels = await captureProcessOutput(async () => {
			console.log("QA_CHANNEL_LOG");
			console.debug("QA_CHANNEL_DEBUG");
			console.info("QA_CHANNEL_INFO");
			console.warn("QA_CHANNEL_WARN");
			console.error("QA_CHANNEL_ERROR");
			process.stdout.write("QA_CHANNEL_STDOUT");
			process.stderr.write("QA_CHANNEL_STDERR");
		});
		expect(channels.map(({ channel }) => channel)).toEqual([
			"console.log",
			"console.debug",
			"console.info",
			"console.warn",
			"console.error",
			"process.stdout",
			"process.stderr",
		]);
		expect(channels.map(({ text }) => text)).toEqual([
			"QA_CHANNEL_LOG",
			"QA_CHANNEL_DEBUG",
			"QA_CHANNEL_INFO",
			"QA_CHANNEL_WARN",
			"QA_CHANNEL_ERROR",
			"QA_CHANNEL_STDOUT",
			"QA_CHANNEL_STDERR",
		]);
	});

	test("keys, audio, provider bodies and PII are absent from all captured artifacts", async () => {
		const wav = createDeterministicWavFixture();
		const mp3 = createDeterministicMp3Fixture();
		const successFixture = createOpenRouterFixture({
			expectedWav: wav,
			expectedApiKey: key,
			transcript: transcriptPii,
			mp3,
		});
		const sttFailureFixture = createOpenRouterFixture({
			expectedWav: wav,
			expectedApiKey: key,
			chatBehaviors: [
				{
					status: 400,
					jsonBody: { error: { message: sttProviderBody } },
				},
			],
		});
		const ttsFailureFixture = createOpenRouterFixture({
			expectedApiKey: key,
			ttsBehaviors: [
				{
					status: 400,
					jsonBody: { error: { message: ttsProviderBody } },
				},
			],
		});
		const sttEvents: OpenRouterSttTelemetryEvent[] = [];
		const ttsEvents: OpenRouterTtsTelemetryEvent[] = [];
		const failures: unknown[] = [];
		const voice = config();
		const captured = await captureProcessOutput(async () => {
			await new OpenRouterSttAdapter({
				config: voice,
				fetch: successFixture.fetch,
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
				fetch: successFixture.fetch,
				telemetry: (event) => ttsEvents.push(event),
			}).synthesize({
				conversationId,
				turnId,
				generationId,
				segmentId,
				text: transcriptPii,
				signal: new AbortController().signal,
			});
			try {
				await new OpenRouterSttAdapter({
					config: voice,
					fetch: sttFailureFixture.fetch,
					telemetry: (event) => sttEvents.push(event),
				}).transcribe({
					conversationId,
					turnId,
					audio: wav,
					contentType: "audio/wav",
					language: "ru",
					signal: new AbortController().signal,
				});
			} catch (error) {
				failures.push(error);
			}
			try {
				await new OpenRouterTtsAdapter({
					config: voice,
					fetch: ttsFailureFixture.fetch,
					telemetry: (event) => ttsEvents.push(event),
				}).synthesize({
					conversationId,
					turnId,
					generationId,
					segmentId,
					text: transcriptPii,
					signal: new AbortController().signal,
				});
			} catch (error) {
				failures.push(error);
			}
		});

		const snapshot = safeRender({ captured, failures, sttEvents, ttsEvents });
		expect(findLeaks(snapshot)).toEqual([]);
		expect(captured).toEqual([]);
		expect(failures).toHaveLength(2);
		expect(successFixture.protocolViolations).toEqual([]);
		expect(sttFailureFixture.protocolViolations).toEqual([]);
		expect(ttsFailureFixture.protocolViolations).toEqual([]);
	});

	test("fresh browser production bundle passes the complete leakage scanner", async () => {
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
		const clientMarkers = {
			...leakageMarkers(),
			"provider.key.namespace": "OPENROUTER_API_KEY",
			"provider.public.url": "openrouter.ai",
		};
		expect(findLeaks(`${stdout}\n${stderr}\n${bundle}`, clientMarkers)).toEqual(
			[],
		);
	});
});
