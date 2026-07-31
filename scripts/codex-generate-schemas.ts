#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGE_DIR = join(ROOT, "packages", "codex-schemas");
const GENERATED_DIR = join(PACKAGE_DIR, "generated");
const METADATA_PATH = join(PACKAGE_DIR, "protocol-version.json");
const FILES = [
	"codex_app_server_protocol.schemas.json",
	"codex_app_server_protocol.v2.schemas.json",
] as const;

interface Metadata {
	codexCliVersion: string;
	generationMode: string;
	generatedAtPolicy: string;
	files: Record<string, string>;
}

const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write")
	throw new Error(
		"Usage: bun scripts/codex-generate-schemas.ts [--check|--write]",
	);

const metadata = JSON.parse(await readFile(METADATA_PATH, "utf8")) as Metadata;
const codexBin = process.env.CODEX_BIN ?? "codex";
const version = await commandOutput([codexBin, "--version"]);
if (version.trim() !== metadata.codexCliVersion)
	throw new Error(
		`Codex CLI version mismatch: expected ${metadata.codexCliVersion}, got ${version.trim()}`,
	);

const temporary = await mkdtemp(join(tmpdir(), "botamin-codex-schemas-"));
try {
	await run([
		codexBin,
		"app-server",
		"generate-json-schema",
		"--experimental",
		"--out",
		temporary,
	]);
	await mkdir(GENERATED_DIR, { recursive: true });
	const hashes: Record<string, string> = {};
	for (const name of FILES) {
		const generated = JSON.parse(
			await readFile(join(temporary, name), "utf8"),
		) as unknown;
		// Rust map iteration can reorder equivalent definitions between runs.
		// Canonical recursive key ordering makes protocol drift checks reproducible.
		const bytes = Buffer.from(
			`${JSON.stringify(sortJson(generated), null, 2)}\n`,
		);
		const relative = `generated/${name}`;
		hashes[relative] = createHash("sha256").update(bytes).digest("hex");
		if (mode === "--write") await writeFile(join(GENERATED_DIR, name), bytes);
		else if (metadata.files[relative] !== hashes[relative])
			throw new Error(
				`Codex protocol drift: ${relative} expected ${metadata.files[relative] ?? "<missing>"}, got ${hashes[relative]}`,
			);
	}
	if (mode === "--write") {
		metadata.files = hashes;
		await writeFile(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
	}
	process.stdout.write(
		`${JSON.stringify({ ok: true, mode, codexCliVersion: version.trim(), files: hashes })}\n`,
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortJson(entry)]),
	);
}

async function commandOutput(command: string[]): Promise<string> {
	const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0)
		throw new Error(`Command failed (${code}): ${stderr.trim() || command[0]}`);
	return stdout;
}

async function run(command: string[]): Promise<void> {
	await commandOutput(command);
}
