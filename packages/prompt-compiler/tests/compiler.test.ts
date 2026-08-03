import { afterAll as after, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ATTRIBUTED_REVENUE_CLAIM_LINES,
	BOOKING_ORDER_SENTENCE,
	compilePromptBundle,
	FORBIDDEN_NATURAL_DIALOGUE_GUIDANCE,
	FORBIDDEN_POLICY_PHRASES,
	MAX_FILE_BYTES,
	NATURAL_DIALOGUE_EXAMPLES,
	PROMPT_ORDER,
	REQUIRED_POLICY_SENTENCES,
	SYNCHRONIZED_DIALOG_POLICY_RULES,
} from "../src/index.js";

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isDistTest = basename(testRoot) === "dist";
const packageRoot = isDistTest ? dirname(testRoot) : testRoot;
const sourceRoot = resolve(packageRoot, "..", "..");
const cliPath = isDistTest
	? join(packageRoot, "dist", "src", "cli.js")
	: join(packageRoot, "src", "cli.ts");
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	temporaryPaths.push(path);
	return path;
}

async function fixtureRoot(
	transform?: (relativePath: string, source: Buffer) => string | Buffer,
): Promise<string> {
	const root = await temporaryDirectory("botamin-prompt-source-");
	for (const relativePath of PROMPT_ORDER) {
		const target = join(root, relativePath);
		const source = await readFile(join(sourceRoot, relativePath));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, transform?.(relativePath, source) ?? source);
	}
	return root;
}

async function runtimeDirectory(): Promise<string> {
	return temporaryDirectory("botamin-prompt-runtime-");
}

after(async () => {
	await Promise.all(
		temporaryPaths.map(async (path) => {
			await chmod(path, 0o700).catch(() => undefined);
			await rm(path, { recursive: true, force: true });
		}),
	);
});

test("compiles in fixed order with stable exact-byte hash and read-only isolated output", async () => {
	const firstRuntime = await runtimeDirectory();
	const secondRuntime = await runtimeDirectory();
	const first = await compilePromptBundle({
		sourceRoot,
		runtimeDir: firstRuntime,
	});
	const second = await compilePromptBundle({
		sourceRoot,
		runtimeDir: secondRuntime,
	});
	const bytes = await readFile(first.outputPath);

	assert.match(first.promptVersion, /^[a-f0-9]{64}$/);
	assert.equal(
		first.promptVersion,
		createHash("sha256").update(bytes).digest("hex"),
	);
	assert.equal(second.promptVersion, first.promptVersion);
	assert.deepEqual(await readFile(second.outputPath), bytes);
	assert.deepEqual(first.files, PROMPT_ORDER);
	assert.equal((await stat(first.outputPath)).mode & 0o777, 0o444);
	assert.deepEqual(await readdir(firstRuntime), ["AGENTS.md"]);

	let previousIndex = -1;
	const output = bytes.toString("utf8");
	for (const relativePath of PROMPT_ORDER) {
		const index = output.indexOf(`<!-- BEGIN ${relativePath} -->`);
		assert.ok(
			index > previousIndex,
			`${relativePath} must follow the fixed order`,
		);
		previousIndex = index;
	}
});

test("normalizes CRLF and a missing final newline before hashing", async () => {
	const normalizedFixture = await fixtureRoot();
	const windowsFixture = await fixtureRoot((_path, source) =>
		source.toString("utf8").trimEnd().replace(/\n/g, "\r\n"),
	);
	const normalized = await compilePromptBundle({
		sourceRoot: normalizedFixture,
		runtimeDir: await runtimeDirectory(),
	});
	const windows = await compilePromptBundle({
		sourceRoot: windowsFixture,
		runtimeDir: await runtimeDirectory(),
	});
	assert.equal(windows.promptVersion, normalized.promptVersion);
});

test("fails for a missing required source file", async () => {
	const fixture = await fixtureRoot();
	await rm(join(fixture, PROMPT_ORDER[1]));
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: fixture,
			runtimeDir: await runtimeDirectory(),
		}),
		/missing required file: prompts\/product\.md/i,
	);
});

test("fails for changed headings or heading levels", async () => {
	const renamedHeading = await fixtureRoot((relativePath, source) =>
		relativePath === "prompts/product.md"
			? source
					.toString("utf8")
					.replace("## Value selection", "## Unexpected heading")
			: source,
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: renamedHeading,
			runtimeDir: await runtimeDirectory(),
		}),
		/unexpected headings.*heading order/i,
	);

	const wrongLevel = await fixtureRoot((relativePath, source) =>
		relativePath === "prompts/product.md"
			? source
					.toString("utf8")
					.replace("## Value selection", "### Value selection")
			: source,
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: wrongLevel,
			runtimeDir: await runtimeDirectory(),
		}),
		/unexpected headings.*heading levels/i,
	);
});

test("enforces per-file and compiled-bundle size limits", async () => {
	const oversizedFile = await fixtureRoot((relativePath, source) =>
		relativePath === "prompts/system.md"
			? `${source.toString("utf8")}\n${"x".repeat(MAX_FILE_BYTES)}`
			: source,
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: oversizedFile,
			runtimeDir: await runtimeDirectory(),
		}),
		/exceeds .* bytes/i,
	);

	const oversizedBundle = await fixtureRoot(
		(_relativePath, source) =>
			`${source.toString("utf8")}\n${"x".repeat(6_500)}`,
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: oversizedBundle,
			runtimeDir: await runtimeDirectory(),
		}),
		/compiled bundle exceeds/i,
	);
});

test("rejects invalid UTF-8, secret-like assignments, and numeric currency prices", async () => {
	const invalidUtf8 = await fixtureRoot();
	await writeFile(
		join(invalidUtf8, "prompts/system.md"),
		Buffer.from([0xff, 0xfe]),
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: invalidUtf8,
			runtimeDir: await runtimeDirectory(),
		}),
		/valid UTF-8/i,
	);

	const secret = await fixtureRoot((relativePath, source) =>
		relativePath === "prompts/system.md"
			? `${source.toString("utf8")}\n${["OPENROUTER_API_", "KEY=not-a-real-key"].join("")}`
			: source,
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: secret,
			runtimeDir: await runtimeDirectory(),
		}),
		/secret-like pattern/i,
	);

	for (const field of ["access_token", "refresh_token", "id_token"]) {
		const authJson = await fixtureRoot((relativePath, source) =>
			relativePath === "prompts/system.md"
				? `${source.toString("utf8")}\n${JSON.stringify({ [field]: "placeholder-token-value" })}`
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: authJson,
				runtimeDir: await runtimeDirectory(),
			}),
			/secret-like pattern/i,
			`must reject quoted ${field} JSON fields`,
		);
	}

	for (const priceClaim of [
		"Price: $100",
		"Стоимость пилота: 100 тысяч рублей",
		"Botamin помог компаниям увеличить выручку на 10–15 миллионов рублей в месяц.",
	]) {
		const price = await fixtureRoot((relativePath, source) =>
			relativePath === "prompts/product.md"
				? `${source.toString("utf8")}\n${priceClaim}`
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: price,
				runtimeDir: await runtimeDirectory(),
			}),
			/numeric currency price/i,
		);
	}

	const unsafeRevenue = await fixtureRoot((relativePath, source) =>
		relativePath === "knowledge/cases.md"
			? source
					.toString("utf8")
					.replace(
						ATTRIBUTED_REVENUE_CLAIM_LINES[0],
						"- **Source claim:** Botamin увеличит вашу выручку на 10–15 миллионов рублей в месяц.",
					)
			: source,
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: unsafeRevenue,
			runtimeDir: await runtimeDirectory(),
		}),
		/invalid attributed revenue claim lines/i,
	);

	for (const mutate of [
		(source: string) => source.replace(ATTRIBUTED_REVENUE_CLAIM_LINES[0], ""),
		(source: string) => `${source}\n${ATTRIBUTED_REVENUE_CLAIM_LINES[0]}\n`,
	]) {
		const invalidClaimLines = await fixtureRoot((relativePath, source) =>
			relativePath === "knowledge/cases.md"
				? mutate(source.toString("utf8"))
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: invalidClaimLines,
				runtimeDir: await runtimeDirectory(),
			}),
			/invalid attributed revenue claim lines/i,
		);
	}

	const nonPriceMagnitude = await fixtureRoot((relativePath, source) =>
		relativePath === "prompts/product.md"
			? `${source.toString("utf8")}\nПилот рассчитан на 100 тысяч обращений.`
			: source,
	);
	await compilePromptBundle({
		sourceRoot: nonPriceMagnitude,
		runtimeDir: await runtimeDirectory(),
	});
});

test("requires the booking-before-qualification rule in system and booking prompts", async () => {
	for (const relativePath of ["prompts/system.md", "prompts/booking.md"]) {
		const fixture = await fixtureRoot((path, source) =>
			path === relativePath
				? source.toString("utf8").replace(BOOKING_ORDER_SENTENCE, "")
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: fixture,
				runtimeDir: await runtimeDirectory(),
			}),
			new RegExp(
				`${relativePath.replace(/[./]/g, "\\$&")}.*booking-order sentence`,
				"i",
			),
		);
	}
});

test("forbids stale qualification-permission wording in active and starter prompts", async () => {
	const promptPaths = PROMPT_ORDER.filter((path) =>
		path.startsWith("prompts/"),
	);
	for (const relativePath of promptPaths) {
		for (const prefix of ["", "starter"]) {
			const source = await readFile(
				join(sourceRoot, prefix, relativePath),
				"utf8",
			);
			for (const phrase of FORBIDDEN_POLICY_PHRASES) {
				assert.ok(
					!source.toLocaleLowerCase("ru-RU").includes(phrase),
					`${join(prefix, relativePath)} contains forbidden phrase: ${phrase}`,
				);
			}
		}
	}

	for (const phrase of FORBIDDEN_POLICY_PHRASES) {
		const fixture = await fixtureRoot((relativePath, source) =>
			relativePath === "prompts/system.md"
				? `${source.toString("utf8")}\n${phrase}\n`
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: fixture,
				runtimeDir: await runtimeDirectory(),
			}),
			/forbidden qualification-permission wording/i,
		);
	}
});

test("rejects stale robotic and unsafe dialogue guidance in active and starter prompts", async () => {
	const promptPaths = PROMPT_ORDER.filter((path) =>
		path.startsWith("prompts/"),
	);
	for (const relativePath of promptPaths) {
		for (const prefix of ["", "starter"]) {
			const source = (
				await readFile(join(sourceRoot, prefix, relativePath), "utf8")
			).toLocaleLowerCase("ru-RU");
			for (const phrase of FORBIDDEN_NATURAL_DIALOGUE_GUIDANCE) {
				assert.ok(
					!source.includes(phrase),
					`${join(prefix, relativePath)} contains forbidden dialogue guidance: ${phrase}`,
				);
			}
		}
	}

	for (const phrase of FORBIDDEN_NATURAL_DIALOGUE_GUIDANCE) {
		const fixture = await fixtureRoot((relativePath, source) =>
			relativePath === "prompts/system.md"
				? `${source.toString("utf8")}\n${phrase}\n`
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: fixture,
				runtimeDir: await runtimeDirectory(),
			}),
			/forbidden robotic or unsafe dialogue guidance/i,
		);
	}
});

test("keeps bounded natural alternatives state-aware, concise, and synchronized", async () => {
	assert.deepEqual(
		NATURAL_DIALOGUE_EXAMPLES.map((example) => example.name),
		[
			"brief discovery",
			"objection",
			"server-supplied scheduling",
			"exact booking confirmation",
			"missing-only qualification",
		],
	);

	for (const example of NATURAL_DIALOGUE_EXAMPLES) {
		const active = await readFile(join(sourceRoot, example.activePath), "utf8");
		const starter = await readFile(
			join(sourceRoot, "starter", example.starterPath),
			"utf8",
		);
		assert.ok(active.includes(example.sourceSentence), example.name);
		assert.ok(starter.includes(example.sourceSentence), example.name);
		assert.doesNotMatch(
			example.spokenText,
			/^(?:Понял|Понимаю|Зафиксировано)\b/u,
		);
		assert.doesNotMatch(
			example.spokenText,
			/(?:https?:\/\/|[`#*_{}[\]<>]|create_booking|append_booking_qualification|allowedActions)/u,
		);
		assert.ok(
			(example.spokenText.match(/\?/gu) ?? []).length <= 1,
			`${example.name} asks more than one question`,
		);
		assert.ok(
			(example.spokenText.match(/[.!?]/gu) ?? []).length <= 2,
			`${example.name} exceeds two spoken sentences`,
		);
	}

	const scheduling = NATURAL_DIALOGUE_EXAMPLES.find(
		(example) => example.name === "server-supplied scheduling",
	);
	assert.match(scheduling?.spokenText ?? "", /завтра в одиннадцать по Москве/u);
	assert.match(
		scheduling?.spokenText ?? "",
		/послезавтра в три часа по Москве/u,
	);
	const confirmation = NATURAL_DIALOGUE_EXAMPLES.find(
		(example) => example.name === "exact booking confirmation",
	);
	assert.match(
		confirmation?.spokenText ?? "",
		/послезавтра в три часа по Москве/u,
	);
	assert.match(
		confirmation?.spokenText ?? "",
		/внешнего календарного события и приглашения нет/u,
	);
});

test("requires proactive cadence, direct missing-only qualification, supplied-slot, contact, and concise-speech rules", async () => {
	for (const [relativePath, sentences] of Object.entries(
		REQUIRED_POLICY_SENTENCES,
	)) {
		for (const sentence of sentences) {
			const fixture = await fixtureRoot((path, source) =>
				path === relativePath
					? source.toString("utf8").replace(sentence, "")
					: source,
			);
			await assert.rejects(
				compilePromptBundle({
					sourceRoot: fixture,
					runtimeDir: await runtimeDirectory(),
				}),
				new RegExp(
					`${relativePath.replace(/[./]/g, "\\$&")}.*(?:required policy sentence|synchronized dialogue policy rule)`,
					"i",
				),
			);
		}
	}
});

test("requires synchronized active and starter dialogue truth and persona rules", async () => {
	for (const rule of SYNCHRONIZED_DIALOG_POLICY_RULES) {
		const starter = await readFile(
			join(sourceRoot, "starter", rule.starterPath),
			"utf8",
		);
		assert.ok(
			starter.includes(rule.starterSentence),
			`starter ${rule.starterPath} is missing ${rule.name}`,
		);

		const fixture = await fixtureRoot((path, source) =>
			path === rule.activePath
				? source.toString("utf8").replace(rule.activeSentence, "")
				: source,
		);
		await assert.rejects(
			compilePromptBundle({
				sourceRoot: fixture,
				runtimeDir: await runtimeDirectory(),
			}),
			new RegExp(
				`${rule.activePath.replace(/[./]/g, "\\$&")}.*synchronized dialogue policy rule.*${rule.name}`,
				"i",
			),
		);
	}
});

test("rejects source file and source-directory symlinks", async () => {
	const fileFixture = await fixtureRoot();
	const systemPath = join(fileFixture, "prompts/system.md");
	await rm(systemPath);
	await symlink(join(sourceRoot, "prompts/system.md"), systemPath);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: fileFixture,
			runtimeDir: await runtimeDirectory(),
		}),
		/regular file, not a symlink/i,
	);

	const directoryFixture = await fixtureRoot();
	await rm(join(directoryFixture, "prompts"), { recursive: true });
	await symlink(join(sourceRoot, "prompts"), join(directoryFixture, "prompts"));
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: directoryFixture,
			runtimeDir: await runtimeDirectory(),
		}),
		/source directory.*not a symlink/i,
	);
});

test("refuses source-contained, symlinked, or contaminated runtime directories", async () => {
	const fixture = await fixtureRoot();
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: fixture,
			runtimeDir: join(fixture, "runtime"),
		}),
		/outside the source repository/i,
	);

	const contaminated = await runtimeDirectory();
	await writeFile(join(contaminated, "unexpected.txt"), "x");
	await assert.rejects(
		compilePromptBundle({ sourceRoot: fixture, runtimeDir: contaminated }),
		/unexpected contents or symlinks/i,
	);

	const symlinkTarget = await runtimeDirectory();
	const symlinkParent = await runtimeDirectory();
	const runtimeSymlink = join(symlinkParent, "runtime-link");
	await symlink(symlinkTarget, runtimeSymlink);
	await assert.rejects(
		compilePromptBundle({ sourceRoot: fixture, runtimeDir: runtimeSymlink }),
		/runtime directory path must not contain symlinks/i,
	);

	const linkedAgentsRuntime = await runtimeDirectory();
	await symlink(
		join(sourceRoot, "prompts/system.md"),
		join(linkedAgentsRuntime, "AGENTS.md"),
	);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: fixture,
			runtimeDir: linkedAgentsRuntime,
		}),
		/unexpected contents or symlinks/i,
	);

	const linkedParent = await runtimeDirectory();
	const parentAlias = join(linkedParent, "source-alias");
	await symlink(fixture, parentAlias);
	await assert.rejects(
		compilePromptBundle({
			sourceRoot: fixture,
			runtimeDir: join(parentAlias, "runtime"),
		}),
		/runtime directory path must not contain symlinks/i,
	);
});

test("CLI emits metadata only and writes the same output contract", async () => {
	const runtime = await runtimeDirectory();
	const result = spawnSync(
		process.execPath,
		[cliPath, "--source-root", sourceRoot, "--runtime-dir", runtime],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const metadata = JSON.parse(result.stdout) as {
		promptVersion: string;
		outputPath: string;
		outputBytes: number;
		files: string[];
	};
	assert.match(metadata.promptVersion, /^[a-f0-9]{64}$/);
	assert.equal(metadata.outputPath, join(runtime, "AGENTS.md"));
	assert.deepEqual(metadata.files, PROMPT_ORDER);
	assert.ok(metadata.outputBytes > 0);
	assert.doesNotMatch(result.stdout, /Identity and hard boundaries/);
	assert.deepEqual(await readdir(runtime), ["AGENTS.md"]);
	assert.equal((await lstat(join(runtime, "AGENTS.md"))).isFile(), true);
});

test("every numeric published case claim has a named source context", async () => {
	const cases = await readFile(join(sourceRoot, "knowledge/cases.md"), "utf8");
	const numericClaimSections = cases
		.split(/^### /mu)
		.filter((section) =>
			/\*\*Source claim:\*\*[\s\S]*?(?:\d[\d ]*%|\d[\d ]{2,})/u.test(section),
		);

	assert.equal(numericClaimSections.length, 5);
	for (const section of numericClaimSections) {
		assert.match(section, /\*\*Named source context:\*\*[^\n]+/u);
		assert.match(section, /\*\*Required attribution:\*\*[^\n]+/u);
		if (section.startsWith("Пользовательский бриф Botamin")) {
			assert.match(section, /пользовательск(?:ом|ий) брифе? Botamin/iu);
			assert.match(section, /не гарантия, прогноз или переносимый результат/iu);
		} else {
			assert.match(section, /опубликованн(?:ом|ый) кейс/u);
		}
	}
});
