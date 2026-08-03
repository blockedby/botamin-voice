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
import { basename, extname, join, resolve } from "node:path";
import {
	GEMINI_3_1_TTS_MODEL,
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../apps/server/src/providers/openrouter/stt/config";
import { OpenRouterTtsAdapter } from "../apps/server/src/providers/openrouter/tts/adapter";
import { isCompleteMp3File } from "../apps/server/src/providers/openrouter/tts/mp3";
import {
	REACTION_CLIP_MANIFEST,
	type ReactionClipId,
	type ReactionClipManifestEntry,
} from "../apps/web/src/audio/reactionClipManifest";
import {
	CANONICAL_TTS_WAV_FORMAT,
	CanonicalTtsWavBytesSchema,
} from "../packages/contracts/src";

export const PAID_OPT_IN_ENV = "BOTAMIN_GENERATE_LOCAL_REACTION_CLIPS_PAID";

const PRODUCTION_OUTPUT_DIRECTORY = resolve(
	import.meta.dir,
	"../apps/web/public",
);
const GENERATOR_NAME = "botamin-local-reaction-clips";
const XAI_PER_FILE_TIMEOUT_MS = 20_000;
const GEMINI_PER_FILE_TIMEOUT_MS = 60_000;
const XAI_TOTAL_TIMEOUT_MS = 360_000;
const GEMINI_TOTAL_TIMEOUT_MS = 1_020_000;
const MAX_TOTAL_BYTES = 1_500_000;
const MAX_TOTAL_DURATION_MS = 32_000;

export const REACTION_CLIP_GENERATION_CORPUS = [
	{ id: "neutral-good", text: "Хорошо." },
	{ id: "neutral-accepted", text: "Принято." },
	{ id: "neutral-checking", text: "Сейчас посмотрим." },
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

export interface ProductionReactionProfile {
	readonly profile: "xai_mp3" | "gemini_3_1_pcm";
	readonly model: string;
	readonly voice: string;
	readonly responseFormat: "mp3" | "pcm";
	readonly outputContentType: "audio/mpeg" | "audio/wav";
}

export const COMMITTED_REACTION_PRODUCTION_PROFILE = Object.freeze({
	profile: "gemini_3_1_pcm",
	model: GEMINI_3_1_TTS_MODEL,
	voice: "Sulafat",
	responseFormat: "pcm",
	outputContentType: "audio/wav",
} as const satisfies ProductionReactionProfile);

export interface ReactionClipGeneratorOptions {
	readonly mode: "production" | "fixture";
	readonly paidOptIn?: string;
	readonly outputDirectory: string;
	readonly createSynthesizer: () => ReactionClipSynthesizer;
	readonly productionProfile?: ProductionReactionProfile;
	/** Fixture-only policy injection proves both supported provider formats. */
	readonly assetManifest?: readonly ReactionClipManifestEntry[];
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

export function canonicalWavDurationMs(bytes: Uint8Array): number | null {
	if (!CanonicalTtsWavBytesSchema.safeParse(bytes).success) return null;
	const dataByteLength = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(40, true);
	return Math.ceil(
		(dataByteLength /
			CANONICAL_TTS_WAV_FORMAT.blockAlign /
			CANONICAL_TTS_WAV_FORMAT.sampleRate) *
			1_000,
	);
}

function validateAudio(
	audio: GeneratedAudio,
	policy: Pick<
		ReactionClipManifestEntry,
		"contentType" | "maxBytes" | "maxDurationMs"
	>,
): number {
	if (
		audio.contentType !== policy.contentType ||
		audio.bytes.byteLength === 0 ||
		audio.bytes.byteLength > policy.maxBytes
	) {
		throw new Error("generated_audio_invalid");
	}
	const durationMs =
		policy.contentType === "audio/mpeg"
			? mp3DurationMs(audio.bytes)
			: canonicalWavDurationMs(audio.bytes);
	if (durationMs === null || durationMs > policy.maxDurationMs) {
		throw new Error("generated_audio_out_of_policy");
	}
	return durationMs;
}

async function writeStagedFile(
	path: string,
	audio: GeneratedAudio,
	policy: Pick<
		ReactionClipManifestEntry,
		"contentType" | "maxBytes" | "maxDurationMs"
	>,
): Promise<void> {
	const file = await open(path, "wx", 0o644);
	try {
		await file.writeFile(audio.bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	await chmod(path, 0o644);
	const persisted = new Uint8Array(await readFile(path));
	if (persisted.byteLength !== audio.bytes.byteLength) {
		throw new Error("persisted_audio_invalid");
	}
	validateAudio({ contentType: audio.contentType, bytes: persisted }, policy);
	if (((await stat(path)).mode & 0o777) !== 0o644) {
		throw new Error("persisted_audio_mode_invalid");
	}
}

function assetFileName(entry: ReactionClipManifestEntry): string {
	if (!/^\/assets\/reactions\/[a-z0-9-]+\.(?:mp3|wav)$/.test(entry.path)) {
		throw new Error("manifest_asset_path_invalid");
	}
	const expectedExtension =
		entry.contentType === "audio/mpeg" ? ".mp3" : ".wav";
	if (extname(entry.path) !== expectedExtension) {
		throw new Error("manifest_asset_format_mismatch");
	}
	return basename(entry.path);
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

function isCommittedProductionProfile(
	profile: ProductionReactionProfile | undefined,
): boolean {
	return (
		profile?.profile === COMMITTED_REACTION_PRODUCTION_PROFILE.profile &&
		profile.model === COMMITTED_REACTION_PRODUCTION_PROFILE.model &&
		profile.voice === COMMITTED_REACTION_PRODUCTION_PROFILE.voice &&
		profile.responseFormat ===
			COMMITTED_REACTION_PRODUCTION_PROFILE.responseFormat &&
		profile.outputContentType ===
			COMMITTED_REACTION_PRODUCTION_PROFILE.outputContentType
	);
}

function validateManifest(
	manifest: readonly ReactionClipManifestEntry[],
): void {
	if (
		manifest.length !== REACTION_CLIP_GENERATION_CORPUS.length ||
		manifest.some(
			(entry, index) => entry.id !== REACTION_CLIP_GENERATION_CORPUS[index]?.id,
		)
	) {
		throw new Error("manifest_ids_invalid");
	}
	const paths = new Set<string>();
	const contentTypes = new Set(manifest.map((entry) => entry.contentType));
	if (contentTypes.size !== 1)
		throw new Error("manifest_content_types_invalid");
	for (const entry of manifest) {
		assetFileName(entry);
		if (paths.has(entry.path)) throw new Error("manifest_paths_invalid");
		paths.add(entry.path);
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
		(options.mode === "fixture" &&
			resolve(options.outputDirectory) === PRODUCTION_OUTPUT_DIRECTORY) ||
		(options.mode === "production" &&
			(options.assetManifest !== undefined ||
				!isCommittedProductionProfile(options.productionProfile)))
	) {
		return {
			status: "failed",
			reason: "none",
			files: 0,
			bytes: 0,
			elapsedMs: 0,
		};
	}
	const manifest =
		options.mode === "fixture"
			? (options.assetManifest ?? REACTION_CLIP_MANIFEST)
			: REACTION_CLIP_MANIFEST;
	const geminiOutput = manifest.every(
		(entry) => entry.contentType === "audio/wav",
	);
	const maximumPerFileTimeoutMs = geminiOutput
		? GEMINI_PER_FILE_TIMEOUT_MS
		: XAI_PER_FILE_TIMEOUT_MS;
	const maximumTotalTimeoutMs = geminiOutput
		? GEMINI_TOTAL_TIMEOUT_MS
		: XAI_TOTAL_TIMEOUT_MS;
	const perFileTimeoutMs = Math.min(
		maximumPerFileTimeoutMs,
		Math.max(1, options.timeoutPolicy?.perFileMs ?? maximumPerFileTimeoutMs),
	);
	const totalTimeoutMs = Math.min(
		maximumTotalTimeoutMs,
		Math.max(1, options.timeoutPolicy?.totalMs ?? maximumTotalTimeoutMs),
	);
	const startedAt = now();
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), totalTimeoutMs);
	timeout.unref();
	let stagingDirectory: string | undefined;
	try {
		validateManifest(manifest);
		if (
			options.mode === "production" &&
			manifest.some(
				(entry) =>
					entry.contentType !== options.productionProfile?.outputContentType,
			)
		) {
			throw new Error("production_profile_manifest_mismatch");
		}
		await ensurePhysicalDirectory(options.outputDirectory);
		const synthesizer = options.createSynthesizer();
		stagingDirectory = await mkdtemp(
			join(options.outputDirectory, ".reaction-clips-stage-"),
		);
		let totalBytes = 0;
		let totalDurationMs = 0;
		for (const [index, content] of REACTION_CLIP_GENERATION_CORPUS.entries()) {
			if (abortController.signal.aborted) throw new Error("total_timeout");
			const manifestEntry = manifest[index];
			if (manifestEntry?.id !== content.id) {
				throw new Error("manifest_entry_missing");
			}
			const audio = await synthesizeWithinDeadline(
				synthesizer,
				content.text,
				index,
				abortController.signal,
				perFileTimeoutMs,
			);
			const durationMs = validateAudio(audio, manifestEntry);
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
				join(stagingDirectory, assetFileName(manifestEntry)),
				audio,
				manifestEntry,
			);
		}
		if (abortController.signal.aborted) throw new Error("total_timeout");
		await chmod(stagingDirectory, 0o755);
		await publishStagedCorpus(options.outputDirectory, stagingDirectory);
		stagingDirectory = undefined;
		return {
			status: "generated",
			reason: "none",
			files: manifest.length,
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

function createProductionSynthesizer(
	loaded: OpenRouterVoiceConfig,
): ReactionClipSynthesizer {
	const perFileTimeoutMs =
		loaded.tts.profile === "gemini_3_1_pcm"
			? GEMINI_PER_FILE_TIMEOUT_MS
			: XAI_PER_FILE_TIMEOUT_MS;
	const maximumProviderBytes =
		loaded.tts.outputContentType === "audio/wav"
			? 128_000 - CANONICAL_TTS_WAV_FORMAT.headerBytes
			: 128_000;
	const config = {
		...loaded,
		tts: {
			...loaded.tts,
			connectTimeoutMs: Math.min(loaded.tts.connectTimeoutMs, 8_000),
			totalTimeoutMs: perFileTimeoutMs,
			maxRetries: 0 as const,
			maxConcurrency: 1,
			maxResponseBytes: Math.min(
				loaded.tts.maxResponseBytes,
				maximumProviderBytes,
			),
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
	if (paidOptIn !== "1") {
		const summary = await generateLocalReactionClips({
			mode: "production",
			...(paidOptIn === undefined ? {} : { paidOptIn }),
			outputDirectory: PRODUCTION_OUTPUT_DIRECTORY,
			createSynthesizer: () => {
				throw new Error("paid_opt_in_required");
			},
		});
		printSummary(summary);
		return 2;
	}

	let loaded: OpenRouterVoiceConfig;
	try {
		loaded = loadOpenRouterVoiceConfig();
	} catch {
		printSummary({
			status: "failed",
			reason: "none",
			files: 0,
			bytes: 0,
			elapsedMs: 0,
		});
		return 1;
	}
	const productionProfile: ProductionReactionProfile = {
		profile: loaded.tts.profile,
		model: loaded.tts.model,
		voice: loaded.tts.voice,
		responseFormat: loaded.tts.responseFormat,
		outputContentType: loaded.tts.outputContentType,
	};
	const summary = await generateLocalReactionClips({
		mode: "production",
		paidOptIn,
		productionProfile,
		outputDirectory: PRODUCTION_OUTPUT_DIRECTORY,
		createSynthesizer: () => createProductionSynthesizer(loaded),
	});
	printSummary(summary);
	return summary.status === "generated" ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
