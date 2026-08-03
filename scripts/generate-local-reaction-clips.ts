#!/usr/bin/env bun

import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadOpenRouterVoiceConfig } from "../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterTtsAdapter } from "../apps/server/src/providers/openrouter/tts/adapter";
import { isCompleteMp3File } from "../apps/server/src/providers/openrouter/tts/mp3";
import {
	REACTION_CLIP_MANIFEST,
	type ReactionClipId,
} from "../apps/web/src/audio/reactionClipManifest";

export const PAID_OPT_IN_ENV = "BOTAMIN_GENERATE_LOCAL_REACTION_CLIPS_PAID";

const PRODUCTION_OUTPUT_DIRECTORY = resolve(
	import.meta.dir,
	"../apps/web/public",
);
const GENERATOR_NAME = "botamin-local-reaction-clips";
const PER_FILE_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 360_000;
const MAX_TOTAL_BYTES = 1_500_000;
const MAX_TOTAL_DURATION_MS = 20_000;

export const REACTION_CLIP_GENERATION_CORPUS = [
	{ id: "neutral-good", text: "Хорошо." },
	{ id: "neutral-accepted", text: "Принято." },
	{ id: "neutral-checking", text: "Проверяю." },
	{ id: "neutral-moment", text: "Секунду." },
	{ id: "schedule-calculating-options", text: "Подбираю." },
	{ id: "schedule-checking-intervals", text: "Считаю." },
	{ id: "schedule-matching-time", text: "Сверяю время." },
	{ id: "validation-checking-data", text: "Сверяю данные." },
	{ id: "validation-checking-format", text: "Проверяю формат." },
	{ id: "validation-checking-fields", text: "Проверяю поля." },
	{ id: "objection-examine", text: "Давайте разберём." },
	{ id: "objection-more-detail", text: "Рассмотрим." },
	{ id: "objection-to-the-point", text: "Ближе к сути." },
	{ id: "clarification-one-point", text: "Один момент." },
	{ id: "clarification-one-detail", text: "Нужна деталь." },
	{ id: "clarification-meaning", text: "Уточню." },
] as const satisfies readonly { id: ReactionClipId; text: string }[];

type GeneratedAudio = Readonly<{
	contentType: string;
	bytes: Uint8Array;
}>;

type ReactionClipSynthesizer = (
	text: string,
	index: number,
	signal: AbortSignal,
) => Promise<GeneratedAudio>;

export type ReactionClipGeneratorSummary = Readonly<{
	status: "not_run" | "generated" | "failed";
	reason: "paid_opt_in_required" | "none";
	files: number;
	bytes: number;
	elapsedMs: number;
}>;

export interface ReactionClipGeneratorOptions {
	readonly mode: "production" | "fixture";
	readonly paidOptIn?: string;
	readonly outputDirectory: string;
	readonly createSynthesizer: () => ReactionClipSynthesizer;
	readonly now?: () => number;
	readonly timeoutPolicy?: Readonly<{
		perFileMs: number;
		totalMs: number;
	}>;
}

function id3v2End(bytes: Uint8Array): number | null {
	if (
		bytes[0] !== "I".charCodeAt(0) ||
		bytes[1] !== "D".charCodeAt(0) ||
		bytes[2] !== "3".charCodeAt(0)
	) {
		return 0;
	}
	if (bytes.byteLength < 10) return null;
	const flags = bytes[5] ?? 0;
	const sizeBytes = [bytes[6], bytes[7], bytes[8], bytes[9]];
	if (
		sizeBytes.some(
			(value): value is undefined =>
				value === undefined || (value & 0x80) !== 0,
		)
	) {
		return null;
	}
	const [size6, size7, size8, size9] = sizeBytes as [
		number,
		number,
		number,
		number,
	];
	const size = (((((size6 << 7) | size7) << 7) | size8) << 7) | size9;
	const end = 10 + size + ((flags & 0x10) === 0 ? 0 : 10);
	return end <= bytes.byteLength ? end : null;
}

function mp3Frame(
	bytes: Uint8Array,
	offset: number,
): { length: number; durationMs: number } | null {
	const byte0 = bytes[offset];
	const byte1 = bytes[offset + 1];
	const byte2 = bytes[offset + 2];
	if (byte0 === undefined || byte1 === undefined || byte2 === undefined) {
		return null;
	}
	if (byte0 !== 0xff || (byte1 & 0xe0) !== 0xe0) return null;
	const versionBits = (byte1 >> 3) & 0x03;
	const layerBits = (byte1 >> 1) & 0x03;
	const bitrateIndex = (byte2 >> 4) & 0x0f;
	const sampleRateIndex = (byte2 >> 2) & 0x03;
	if (
		versionBits === 0x01 ||
		layerBits !== 0x01 ||
		bitrateIndex === 0 ||
		bitrateIndex === 0x0f ||
		sampleRateIndex === 0x03
	) {
		return null;
	}
	const mpeg1Bitrates = [
		0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
	] as const;
	const mpeg2Bitrates = [
		0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
	] as const;
	const sampleRates = [44_100, 48_000, 32_000] as const;
	const mpeg1 = versionBits === 0x03;
	const bitrateKbps = (mpeg1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
	const mpeg1SampleRate = sampleRates[sampleRateIndex];
	if (bitrateKbps === undefined || mpeg1SampleRate === undefined) return null;
	const sampleRate =
		versionBits === 0x00
			? mpeg1SampleRate / 4
			: versionBits === 0x02
				? mpeg1SampleRate / 2
				: mpeg1SampleRate;
	const padding = (byte2 >> 1) & 0x01;
	return {
		length:
			Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1_000) / sampleRate) +
			padding,
		durationMs: ((mpeg1 ? 1_152 : 576) / sampleRate) * 1_000,
	};
}

export function mp3DurationMs(bytes: Uint8Array): number | null {
	if (!isCompleteMp3File(bytes)) return null;
	let offset = id3v2End(bytes);
	if (offset === null) return null;
	let durationMs = 0;
	while (offset < bytes.byteLength) {
		if (
			bytes.byteLength - offset === 128 &&
			bytes[offset] === "T".charCodeAt(0) &&
			bytes[offset + 1] === "A".charCodeAt(0) &&
			bytes[offset + 2] === "G".charCodeAt(0)
		) {
			break;
		}
		const frame = mp3Frame(bytes, offset);
		if (frame === null) return null;
		offset += frame.length;
		durationMs += frame.durationMs;
	}
	return Math.ceil(durationMs);
}

function validateAudio(
	audio: GeneratedAudio,
	policy: { maxBytes: number; maxDurationMs: number },
): number {
	if (
		audio.contentType !== "audio/mpeg" ||
		audio.bytes.byteLength === 0 ||
		audio.bytes.byteLength > policy.maxBytes ||
		!isCompleteMp3File(audio.bytes)
	) {
		throw new Error("generated_audio_invalid");
	}
	const durationMs = mp3DurationMs(audio.bytes);
	if (durationMs === null || durationMs > policy.maxDurationMs) {
		throw new Error("generated_audio_out_of_policy");
	}
	return durationMs;
}

async function writeStagedFile(
	path: string,
	bytes: Uint8Array,
	policy: { maxBytes: number; maxDurationMs: number },
): Promise<void> {
	const file = await open(path, "wx", 0o644);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	await chmod(path, 0o644);
	const persisted = new Uint8Array(await readFile(path));
	if (persisted.byteLength !== bytes.byteLength) {
		throw new Error("persisted_audio_invalid");
	}
	validateAudio({ contentType: "audio/mpeg", bytes: persisted }, policy);
	if (((await stat(path)).mode & 0o777) !== 0o644) {
		throw new Error("persisted_audio_mode_invalid");
	}
}

function assetFileName(assetPath: string): string {
	if (!/^\/assets\/reactions\/[a-z0-9-]+\.mp3$/.test(assetPath)) {
		throw new Error("manifest_asset_path_invalid");
	}
	return basename(assetPath);
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
	const resolvedPath = resolve(path);
	let existingAncestor = resolvedPath;
	for (;;) {
		try {
			if (
				(await realpath(existingAncestor)) !== existingAncestor ||
				!(await lstat(existingAncestor)).isDirectory()
			) {
				throw new Error("output_directory_invalid");
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = resolve(existingAncestor, "..");
			if (parent === existingAncestor)
				throw new Error("output_directory_invalid");
			existingAncestor = parent;
		}
	}
	await mkdir(resolvedPath, { recursive: true });
	if (
		(await realpath(resolvedPath)) !== resolvedPath ||
		!(await lstat(resolvedPath)).isDirectory()
	) {
		throw new Error("output_directory_invalid");
	}
}

async function synthesizeWithinDeadline(
	synthesizer: ReactionClipSynthesizer,
	text: string,
	index: number,
	overallSignal: AbortSignal,
	perFileTimeoutMs: number,
): Promise<GeneratedAudio> {
	const controller = new AbortController();
	let rejectDeadline: ((reason: Error) => void) | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
	});
	const abortForOverall = () => {
		controller.abort();
		rejectDeadline?.(new Error("total_timeout"));
	};
	if (overallSignal.aborted) abortForOverall();
	else overallSignal.addEventListener("abort", abortForOverall, { once: true });
	const timeout = setTimeout(() => {
		controller.abort();
		rejectDeadline?.(new Error("per_file_timeout"));
	}, perFileTimeoutMs);
	timeout.unref();
	try {
		return await Promise.race([
			synthesizer(text, index, controller.signal),
			deadline,
		]);
	} finally {
		clearTimeout(timeout);
		overallSignal.removeEventListener("abort", abortForOverall);
	}
}

async function publishStagedCorpus(
	outputDirectory: string,
	stagingDirectory: string,
): Promise<void> {
	const assetsDirectory = resolve(outputDirectory, "assets");
	await ensurePhysicalDirectory(assetsDirectory);
	const targetDirectory = resolve(assetsDirectory, "reactions");
	const backupDirectory = resolve(
		assetsDirectory,
		`.reaction-clips-backup-${crypto.randomUUID()}`,
	);
	let backupCreated = false;
	try {
		try {
			const targetStats = await lstat(targetDirectory);
			if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
				throw new Error("reaction_asset_directory_invalid");
			}
			await rename(targetDirectory, backupDirectory);
			backupCreated = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(stagingDirectory, targetDirectory);
		} catch (error) {
			if (backupCreated) await rename(backupDirectory, targetDirectory);
			throw error;
		}
		if (backupCreated) {
			// Publication already succeeded. A stale safe-audio backup is preferable
			// to reporting failure while the new corpus is live.
			await rm(backupDirectory, { force: true, recursive: true }).catch(
				() => undefined,
			);
		}
	} catch (error) {
		if (backupCreated) {
			try {
				await lstat(targetDirectory);
			} catch (targetError) {
				if ((targetError as NodeJS.ErrnoException).code === "ENOENT") {
					await rename(backupDirectory, targetDirectory);
				}
			}
		}
		throw error;
	}
}

export async function generateLocalReactionClips(
	options: ReactionClipGeneratorOptions,
): Promise<ReactionClipGeneratorSummary> {
	const now = options.now ?? Date.now;
	if (options.mode === "production" && options.paidOptIn !== "1") {
		return {
			status: "not_run",
			reason: "paid_opt_in_required",
			files: 0,
			bytes: 0,
			elapsedMs: 0,
		};
	}
	if (
		options.mode === "fixture" &&
		resolve(options.outputDirectory) === PRODUCTION_OUTPUT_DIRECTORY
	) {
		return {
			status: "failed",
			reason: "none",
			files: 0,
			bytes: 0,
			elapsedMs: 0,
		};
	}

	const perFileTimeoutMs = Math.min(
		PER_FILE_TIMEOUT_MS,
		Math.max(1, options.timeoutPolicy?.perFileMs ?? PER_FILE_TIMEOUT_MS),
	);
	const totalTimeoutMs = Math.min(
		TOTAL_TIMEOUT_MS,
		Math.max(1, options.timeoutPolicy?.totalMs ?? TOTAL_TIMEOUT_MS),
	);
	const startedAt = now();
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), totalTimeoutMs);
	timeout.unref();
	let stagingDirectory: string | undefined;
	try {
		await ensurePhysicalDirectory(options.outputDirectory);
		const synthesizer = options.createSynthesizer();
		stagingDirectory = await mkdtemp(
			join(options.outputDirectory, ".reaction-clips-stage-"),
		);
		let totalBytes = 0;
		let totalDurationMs = 0;
		for (const [index, content] of REACTION_CLIP_GENERATION_CORPUS.entries()) {
			if (abortController.signal.aborted) throw new Error("total_timeout");
			const manifest = REACTION_CLIP_MANIFEST.find(
				(entry) => entry.id === content.id,
			);
			if (manifest === undefined) throw new Error("manifest_entry_missing");
			const audio = await synthesizeWithinDeadline(
				synthesizer,
				content.text,
				index,
				abortController.signal,
				perFileTimeoutMs,
			);
			const durationMs = validateAudio(audio, manifest);
			totalBytes += audio.bytes.byteLength;
			totalDurationMs += durationMs;
			if (
				totalBytes > MAX_TOTAL_BYTES ||
				totalDurationMs > MAX_TOTAL_DURATION_MS ||
				now() - startedAt > totalTimeoutMs
			) {
				throw new Error("aggregate_policy_exceeded");
			}
			await writeStagedFile(
				join(stagingDirectory, assetFileName(manifest.path)),
				audio.bytes,
				manifest,
			);
		}
		if (abortController.signal.aborted) throw new Error("total_timeout");
		await chmod(stagingDirectory, 0o755);
		await publishStagedCorpus(options.outputDirectory, stagingDirectory);
		stagingDirectory = undefined;
		return {
			status: "generated",
			reason: "none",
			files: REACTION_CLIP_MANIFEST.length,
			bytes: totalBytes,
			elapsedMs: Math.max(0, now() - startedAt),
		};
	} catch {
		return {
			status: "failed",
			reason: "none",
			files: 0,
			bytes: 0,
			elapsedMs: Math.max(0, now() - startedAt),
		};
	} finally {
		clearTimeout(timeout);
		if (stagingDirectory !== undefined) {
			await rm(stagingDirectory, { force: true, recursive: true });
		}
	}
}

function createProductionSynthesizer(): ReactionClipSynthesizer {
	const loaded = loadOpenRouterVoiceConfig();
	const config = {
		...loaded,
		tts: {
			...loaded.tts,
			connectTimeoutMs: Math.min(loaded.tts.connectTimeoutMs, 8_000),
			totalTimeoutMs: Math.min(loaded.tts.totalTimeoutMs, PER_FILE_TIMEOUT_MS),
			maxRetries: 0 as const,
			maxConcurrency: 1,
			maxResponseBytes: Math.min(loaded.tts.maxResponseBytes, 128_000),
		},
	};
	const adapter = new OpenRouterTtsAdapter({ config });
	return async (text, index, signal) =>
		adapter.synthesize({
			conversationId: "01J00000000000000000000100",
			turnId: "01J00000000000000000000101",
			generationId: `01J00000000000000000000${String(index + 200).padStart(3, "0")}`,
			segmentId: `01J00000000000000000000${String(index + 300).padStart(3, "0")}`,
			text,
			signal,
		});
}

function printSummary(summary: ReactionClipGeneratorSummary): void {
	console.info(JSON.stringify({ generator: GENERATOR_NAME, ...summary }));
}

async function main(): Promise<number> {
	const paidOptIn = Bun.env[PAID_OPT_IN_ENV];
	const summary = await generateLocalReactionClips({
		mode: "production",
		...(paidOptIn === undefined ? {} : { paidOptIn }),
		outputDirectory: PRODUCTION_OUTPUT_DIRECTORY,
		createSynthesizer: createProductionSynthesizer,
	});
	printSummary(summary);
	if (summary.status === "generated") return 0;
	return summary.status === "not_run" ? 2 : 1;
}

if (import.meta.main) process.exitCode = await main();
