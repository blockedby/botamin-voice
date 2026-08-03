import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { ConsoleLeadNotifier } from "../../apps/server/src/notifiers/notifier";
import { ObservabilityMetrics } from "../../apps/server/src/observability";
import { OpenRouterSttAdapter } from "../../apps/server/src/providers/openrouter/stt";
import { loadOpenRouterVoiceConfig } from "../../apps/server/src/providers/openrouter/stt/config";
import {
	createDeterministicMp3Fixture,
	createDeterministicWavFixture,
} from "../../packages/test-fixtures/src";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function productionSources(root: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			result.push(...(await productionSources(path)));
		} else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) {
			if (
				!entry.name.endsWith(".test.ts") &&
				!entry.name.endsWith(".test.tsx")
			) {
				result.push(path);
			}
		}
	}
	return result;
}

function assertAbsent(haystacks: Uint8Array[], markers: Uint8Array[]): void {
	for (const marker of markers) {
		for (const haystack of haystacks) {
			expect(Buffer.from(haystack).includes(Buffer.from(marker))).toBe(false);
		}
	}
}

describe("T32 source, bundle, runtime-log and snapshot leakage guard", () => {
	test("rejects actual key, auth, webhook, contact, spoken text and audio markers", async () => {
		const output = await mkdtemp(join(tmpdir(), "botamin-security-build-"));
		temporaryDirectories.push(output);
		const serverBuild = await Bun.build({
			entrypoints: ["apps/server/src/index.ts"],
			outdir: join(output, "server"),
			target: "bun",
			minify: true,
		});
		const webBuild = await Bun.build({
			entrypoints: ["apps/web/src/main.tsx"],
			outdir: join(output, "web"),
			target: "browser",
			minify: true,
			external: [
				"@botamin/contracts",
				"react",
				"react-dom",
				"react-dom/client",
			],
		});
		expect(serverBuild.success).toBe(true);
		expect(webBuild.success).toBe(true);

		const keyMarker = ["sk", "t32", "actual", "environment", "key"].join("-");
		const authMarker = ["codex", "auth", "refresh", "marker", "t32"].join("-");
		const webhookMarker = ["webhook", "signing", "marker", "t32"].join("-");
		const transcriptMarker = ["private", "final", "transcript", "t32"].join(
			" ",
		);
		const contactMarker = ["visitor", "t32", "example.com"].join("@");
		const spokenMarker = ["private", "spoken", "phrase", "t32"].join(" ");
		const providerBodyMarker = ["provider", "body", "private", "t32"].join("-");
		const nameMarker = ["private", "name", "t32"].join(" ");
		const companyMarker = ["private", "company", "t32"].join(" ");
		const eventIdMarker = ["event", "id", "private", "t32"].join("-");
		const bookingIdMarker = ["booking", "id", "private", "t32"].join("-");
		const conversationIdMarker = ["conversation", "id", "private", "t32"].join(
			"-",
		);
		const unknownMarker = ["unknown", "lead", "private", "t32"].join("-");
		const wav = createDeterministicWavFixture();
		const mp3 = createDeterministicMp3Fixture();
		const base64Wav = Buffer.from(wav).toString("base64");
		const base64Mp3 = Buffer.from(mp3).toString("base64");

		const sourcePaths = [
			...(await productionSources("apps/server/src")),
			...(await productionSources("apps/web/src")),
		];
		const sourceBytes = await Promise.all(
			sourcePaths.map((path) => readFile(path)),
		);
		const outputPaths = await productionSources(output);
		const builtBytes = await Promise.all(
			outputPaths.map((path) => readFile(path)),
		);
		const webBytes = await Promise.all(
			outputPaths
				.filter((path) => path.startsWith(join(output, "web")))
				.map((path) => readFile(path)),
		);
		const textualMarkers = [
			keyMarker,
			authMarker,
			webhookMarker,
			transcriptMarker,
			contactMarker,
			spokenMarker,
			providerBodyMarker,
			nameMarker,
			companyMarker,
			eventIdMarker,
			bookingIdMarker,
			conversationIdMarker,
			unknownMarker,
			base64Wav,
			base64Mp3,
		].map((value) => Buffer.from(value));
		assertAbsent([...sourceBytes, ...builtBytes], textualMarkers);
		assertAbsent(builtBytes, [wav, mp3]);

		const metrics = new ObservabilityMetrics();
		const sensitiveCorrelation = [
			keyMarker,
			authMarker,
			webhookMarker,
			transcriptMarker,
			contactMarker,
			spokenMarker,
		].join(":");
		metrics.markAudioCommit(sensitiveCorrelation);
		metrics.markSttRequest(sensitiveCorrelation);
		metrics.markFinalTranscript(sensitiveCorrelation);
		const config = loadOpenRouterVoiceConfig({
			OPENROUTER_API_KEY: keyMarker,
			STT_MAX_RETRIES: "0",
			STT_RETRY_BASE_MS: "0",
		});
		const capturedLogs: string[] = [];
		await new ConsoleLeadNotifier((line) => capturedLogs.push(line)).publish({
			v: 1,
			type: "booking.created",
			eventId: eventIdMarker,
			occurredAt: "2026-08-03T00:00:00.000Z",
			unknownKey: unknownMarker,
			data: {
				bookingId: bookingIdMarker,
				conversationId: conversationIdMarker,
				name: nameMarker,
				company: companyMarker,
				contacts: [{ channel: "email", value: contactMarker }],
				transcript: transcriptMarker,
			},
		} as unknown as Parameters<ConsoleLeadNotifier["publish"]>[0]);
		expect(JSON.parse(capturedLogs[0] ?? "{}")).toEqual({
			channel: "lead-notifier",
			status: "accepted",
			eventKind: "booking.created",
		});
		const adapter = new OpenRouterSttAdapter({
			config,
			fetch: async () =>
				Response.json(
					{ error: { code: 401, message: providerBodyMarker } },
					{ status: 401 },
				),
			telemetry: (event) => metrics.recordStt(event),
		});
		try {
			await adapter.transcribe({
				conversationId: "01J00000000000000000000000",
				turnId: "01J00000000000000000000001",
				audio: wav,
				contentType: "audio/wav",
				language: "ru",
				signal: new AbortController().signal,
			});
		} catch (error) {
			capturedLogs.push(
				JSON.stringify({
					event: "voice.failed",
					code:
						error && typeof error === "object" && "code" in error
							? String(error.code)
							: "STT_FAILED",
				}),
			);
		}
		const safeSnapshot = metrics.snapshot() as {
			providers: {
				openrouterStt: { statuses: Record<string, number> };
			};
		};
		expect(safeSnapshot.providers.openrouterStt.statuses["401"]).toBe(1);
		const runtimeEvidence = Buffer.from(
			JSON.stringify({ capturedLogs, snapshot: safeSnapshot }),
		);
		assertAbsent(
			[runtimeEvidence],
			[...textualMarkers, Buffer.from(wav), Buffer.from(mp3)],
		);

		const webText = Buffer.concat(webBytes).toString("utf8").toLowerCase();
		expect(webText).not.toContain("openrouter.ai");
		expect(webText).not.toContain("openrouter_api_key");
		expect(webText).not.toContain("authorization: bearer");
	});
});
