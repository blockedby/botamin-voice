import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
	REACTION_CLIP_IDS,
	REACTION_CLIP_MANIFEST,
} from "../../apps/web/src/audio/reactionClipManifest";
import {
	ConversationStageSchema,
	isCompleteMp3File,
} from "../../packages/contracts/src";
import { createDeterministicMp3Fixture } from "../../packages/test-fixtures/src";
import {
	generateLocalReactionClips,
	mp3DurationMs,
	PAID_OPT_IN_ENV,
	REACTION_CLIP_GENERATION_CORPUS,
} from "../../scripts/generate-local-reaction-clips";

const projectRoot = resolve(import.meta.dir, "../..");
const productionAssets = resolve(
	projectRoot,
	"apps/web/public/assets/reactions",
);
const semanticIntent = {
	neutral_thinking_backchannel: "latency_backchannel_needed",
	scheduling_calculation: "scheduling_calculation_active",
	data_validation: "data_validation_active",
	objection_transition: "objection_detected",
	clarification: "clarification_required",
} as const;

async function filesOrEmpty(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

describe("local reaction clip manifest and fixed copy", () => {
	test("allowlists 12-16 unique same-origin MP3s in strict semantic classes", () => {
		expect(REACTION_CLIP_MANIFEST.length).toBeGreaterThanOrEqual(12);
		expect(REACTION_CLIP_MANIFEST.length).toBeLessThanOrEqual(16);
		expect(REACTION_CLIP_MANIFEST.map(({ id }) => id)).toEqual([
			...REACTION_CLIP_IDS,
		]);
		expect(new Set(REACTION_CLIP_IDS).size).toBe(REACTION_CLIP_IDS.length);
		expect(new Set(REACTION_CLIP_MANIFEST.map(({ path }) => path)).size).toBe(
			REACTION_CLIP_MANIFEST.length,
		);

		const classCounts = new Map<string, number>();
		for (const clip of REACTION_CLIP_MANIFEST) {
			expect(Object.keys(clip).sort()).toEqual([
				"allowedStages",
				"id",
				"maxBytes",
				"maxDurationMs",
				"path",
				"semanticClass",
				"triggerIntent",
			]);
			expect(clip.path).toBe(`/assets/reactions/${clip.id}.mp3`);
			expect(clip.path).toMatch(/^\/assets\/reactions\/[a-z0-9-]+\.mp3$/);
			expect(clip.path).not.toMatch(/^(?:https?:)?\/\//);
			expect(clip.path).not.toMatch(/[?#]|\.\./);
			expect(clip.triggerIntent).toBe(semanticIntent[clip.semanticClass]);
			expect(clip.maxDurationMs).toBe(1_250);
			expect(clip.maxBytes).toBe(128_000);
			expect(clip.allowedStages.length).toBeGreaterThan(0);
			for (const stage of clip.allowedStages) {
				expect(ConversationStageSchema.safeParse(stage).success).toBe(true);
				expect(["COMPLETE", "DECLINED", "DISCONNECTED", "ERROR"]).not.toContain(
					stage,
				);
			}
			classCounts.set(
				clip.semanticClass,
				(classCounts.get(clip.semanticClass) ?? 0) + 1,
			);
		}
		expect(classCounts).toEqual(
			new Map([
				["neutral_thinking_backchannel", 4],
				["scheduling_calculation", 3],
				["data_validation", 3],
				["objection_transition", 3],
				["clarification", 3],
			]),
		);
	});

	test("keeps bounded Russian generator copy fixed, neutral, and claim-free", () => {
		expect(REACTION_CLIP_GENERATION_CORPUS.map(({ id }) => id)).toEqual([
			...REACTION_CLIP_IDS,
		]);
		for (const { text } of REACTION_CLIP_GENERATION_CORPUS) {
			expect(text).toMatch(/^[А-ЯЁ][А-Яа-яЁё ]+[.!?]$/u);
			expect(Array.from(text).length).toBeLessThanOrEqual(28);
			expect(
				text.replace(/[.!?]/g, "").split(/\s+/u).length,
			).toBeLessThanOrEqual(3);
			expect(text).not.toMatch(/\d|@|https?:|www\.|\.ru\b/iu);
			expect(text).not.toMatch(
				/телефон|почт|контакт|адрес|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр/iu,
			);
			expect(text).not.toMatch(
				/заброни|запис|встреч\w* (?:создан|готов)|календар|подтвержд|успеш/iu,
			);
			expect(text).not.toMatch(
				/понимаю|сочув|сожале|жаль|понял(?:а)?|готов(?:а)?|рад(?:а)?|сделал(?:а)?/iu,
			);
			expect(text).not.toMatch(
				/(?:^|[ ,.!?])(?:э+-?э+|ну|как бы)(?:$|[ ,.!?])/iu,
			);
			expect(text).not.toContain("${");
		}
	});
});

describe("local reaction clip generator safety", () => {
	test("does not initialize a provider or write without the paid opt-in", async () => {
		const outputDirectory = await mkdtemp(
			resolve(tmpdir(), "botamin-reaction-no-opt-in-"),
		);
		let providerInitializations = 0;
		try {
			const result = await generateLocalReactionClips({
				mode: "production",
				outputDirectory,
				createSynthesizer: () => {
					providerInitializations += 1;
					throw new Error("must not initialize");
				},
			});
			expect(result).toEqual({
				status: "not_run",
				reason: "paid_opt_in_required",
				files: 0,
				bytes: 0,
				elapsedMs: 0,
			});
			expect(providerInitializations).toBe(0);
			expect(await filesOrEmpty(outputDirectory)).toEqual([]);
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});

	test("writes only a complete bounded mode-0644 fixture corpus atomically", async () => {
		const outputDirectory = await mkdtemp(
			resolve(tmpdir(), "botamin-reaction-fixture-"),
		);
		const fixture = createDeterministicMp3Fixture();
		try {
			const result = await generateLocalReactionClips({
				mode: "fixture",
				outputDirectory,
				createSynthesizer: () => async () => ({
					contentType: "audio/mpeg",
					bytes: fixture.slice(),
				}),
			});
			expect(result).toMatchObject({
				status: "generated",
				reason: "none",
				files: REACTION_CLIP_MANIFEST.length,
				bytes: fixture.byteLength * REACTION_CLIP_MANIFEST.length,
			});
			expect(await filesOrEmpty(outputDirectory)).toEqual(["assets"]);
			const generatedNames = (
				await filesOrEmpty(resolve(outputDirectory, "assets/reactions"))
			).sort();
			expect(generatedNames).toEqual(
				REACTION_CLIP_MANIFEST.map(({ path }) => basename(path)).sort(),
			);
			for (const clip of REACTION_CLIP_MANIFEST) {
				const path = resolve(outputDirectory, clip.path.slice(1));
				const bytes = new Uint8Array(await readFile(path));
				expect(isCompleteMp3File(bytes)).toBe(true);
				expect(bytes.byteLength).toBeLessThanOrEqual(clip.maxBytes);
				expect(mp3DurationMs(bytes)).toBeLessThanOrEqual(clip.maxDurationMs);
				expect((await stat(path)).mode & 0o777).toBe(0o644);
			}
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});

	test("enforces a wall-time deadline even when a synthesizer ignores abort", async () => {
		const outputDirectory = await mkdtemp(
			resolve(tmpdir(), "botamin-reaction-timeout-"),
		);
		try {
			const result = await generateLocalReactionClips({
				mode: "fixture",
				outputDirectory,
				timeoutPolicy: { perFileMs: 5, totalMs: 10 },
				createSynthesizer: () => () => new Promise(() => undefined),
			});
			expect(result.status).toBe("failed");
			expect(await filesOrEmpty(outputDirectory)).toEqual([]);
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});

	test("rejects symlinked output roots before initializing a synthesizer", async () => {
		const parent = await mkdtemp(
			resolve(tmpdir(), "botamin-reaction-symlink-"),
		);
		const physical = resolve(parent, "physical");
		const linked = resolve(parent, "linked");
		await mkdir(physical);
		await Bun.write(resolve(physical, ".keep"), "fixture");
		await symlink(physical, linked, "dir");
		let providerInitializations = 0;
		try {
			const result = await generateLocalReactionClips({
				mode: "fixture",
				outputDirectory: resolve(linked, "nested"),
				createSynthesizer: () => {
					providerInitializations += 1;
					return async () => ({
						contentType: "audio/mpeg",
						bytes: createDeterministicMp3Fixture(),
					});
				},
			});
			expect(result.status).toBe("failed");
			expect(providerInitializations).toBe(0);
			expect(await filesOrEmpty(physical)).toEqual([".keep"]);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("stops on invalid fixture audio without publishing a partial corpus", async () => {
		const outputDirectory = await mkdtemp(
			resolve(tmpdir(), "botamin-reaction-invalid-"),
		);
		let calls = 0;
		try {
			const result = await generateLocalReactionClips({
				mode: "fixture",
				outputDirectory,
				createSynthesizer: () => async () => {
					calls += 1;
					return calls === 3
						? { contentType: "audio/mpeg", bytes: new Uint8Array([1, 2, 3]) }
						: {
								contentType: "audio/mpeg",
								bytes: createDeterministicMp3Fixture(),
							};
				},
			});
			expect(result.status).toBe("failed");
			expect(calls).toBe(3);
			expect(await filesOrEmpty(outputDirectory)).toEqual([]);
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});
});

describe("production asset and source separation", () => {
	test("allows an absent production corpus, but never a partial or invalid one", async () => {
		const files = (await filesOrEmpty(productionAssets))
			.filter((file) => file.endsWith(".mp3"))
			.sort();
		if (files.length === 0) {
			expect(files).toEqual([]);
			return;
		}
		expect(files).toEqual(
			REACTION_CLIP_MANIFEST.map(({ path }) => basename(path)).sort(),
		);
		let totalBytes = 0;
		let totalDurationMs = 0;
		for (const clip of REACTION_CLIP_MANIFEST) {
			const path = resolve(projectRoot, "apps/web/public", clip.path.slice(1));
			const bytes = new Uint8Array(await readFile(path));
			const durationMs = mp3DurationMs(bytes);
			expect(isCompleteMp3File(bytes)).toBe(true);
			expect(bytes.byteLength).toBeLessThanOrEqual(clip.maxBytes);
			expect(durationMs).not.toBeNull();
			expect(durationMs).toBeLessThanOrEqual(clip.maxDurationMs);
			expect((await stat(path)).mode & 0o777).toBe(0o644);
			totalBytes += bytes.byteLength;
			totalDurationMs += durationMs ?? 0;
		}
		expect(totalBytes).toBeLessThanOrEqual(1_500_000);
		expect(totalDurationMs).toBeLessThanOrEqual(20_000);
	});

	test("keeps paid generation copy and backend dependencies out of browser runtime", async () => {
		const manifestSource = await Bun.file(
			resolve(projectRoot, "apps/web/src/audio/reactionClipManifest.ts"),
		).text();
		const generatorSource = await Bun.file(
			resolve(projectRoot, "scripts/generate-local-reaction-clips.ts"),
		).text();
		const packageJson = await Bun.file(
			resolve(projectRoot, "package.json"),
		).json();

		expect(manifestSource).not.toMatch(/[А-Яа-яЁё]/u);
		expect(manifestSource).not.toMatch(/apps\/server|scripts\//);
		expect(manifestSource).not.toMatch(
			/transcript|userText|generationId|apiKey/i,
		);
		expect(generatorSource).toContain("maxRetries: 0 as const");
		expect(generatorSource).not.toMatch(/console\.(?:error|warn|debug)/);
		expect(PAID_OPT_IN_ENV).toBe("BOTAMIN_GENERATE_LOCAL_REACTION_CLIPS_PAID");
		expect(packageJson.scripts["generate:reaction-clips:paid-opt-in"]).toBe(
			"bun scripts/generate-local-reaction-clips.ts",
		);
		expect(
			packageJson.scripts["generate:reaction-clips:paid-opt-in"],
		).not.toContain(PAID_OPT_IN_ENV);

		const runtimeGlob = new Bun.Glob("apps/web/src/**/*.{ts,tsx}");
		for await (const relativePath of runtimeGlob.scan({ cwd: projectRoot })) {
			if (
				relativePath.endsWith(".test.ts") ||
				relativePath.endsWith(".test.tsx")
			) {
				continue;
			}
			const source = await Bun.file(resolve(projectRoot, relativePath)).text();
			expect(source).not.toContain("generate-local-reaction-clips");
			expect(source).not.toContain("REACTION_CLIP_GENERATION_CORPUS");
		}
	});
});
