#!/usr/bin/env bun
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SDK_VERSION = "0.146.0";
const temporary = await mkdtemp(join(tmpdir(), "botamin-codex-sdk-spike-"));
try {
	const tarball = `openai-codex-sdk-${SDK_VERSION}.tgz`;
	await run(
		["npm", "pack", "--silent", `@openai/codex-sdk@${SDK_VERSION}`],
		temporary,
	);
	await run(["tar", "-xzf", tarball], temporary);
	const declarations = await readFile(
		join(temporary, "package", "dist", "index.d.ts"),
		"utf8",
	);
	const packageJson = JSON.parse(
		await readFile(join(temporary, "package", "package.json"), "utf8"),
	) as { version: string; engines?: { node?: string } };
	await run(
		[
			"bun",
			"-e",
			`const sdk = await import(${JSON.stringify(join(temporary, "package", "dist", "index.js"))}); if (typeof sdk.Codex !== "function") process.exit(2);`,
		],
		temporary,
	);
	const capabilities = {
		bunImport: true,
		streamedEvents: declarations.includes("runStreamed("),
		threadId: declarations.includes("get id(): string | null"),
		structuredOutput: declarations.includes("outputSchema?: unknown"),
		addressableTurnInterrupt:
			declarations.includes("turn/interrupt") ||
			declarations.includes("interrupt("),
		instructionSources: declarations.includes("instructionSources"),
		dynamicTools: declarations.includes("dynamicTools"),
		appServerInitialize: declarations.includes("initialize("),
		modelList: declarations.includes("model/list"),
	};
	const mandatoryPass = Object.values(capabilities).every(Boolean);
	process.stdout.write(
		`${JSON.stringify({
			package: "@openai/codex-sdk",
			version: packageJson.version,
			declaredNodeEngine: packageJson.engines?.node ?? null,
			capabilities,
			mandatoryPass,
			decision: mandatoryPass ? "sdk" : "direct-app-server-jsonl",
		})}\n`,
	);
	if (mandatoryPass) process.exitCode = 2;
} finally {
	await rm(temporary, { recursive: true, force: true });
}

async function run(command: string[], cwd: string): Promise<void> {
	const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0)
		throw new Error(
			`Spike command failed (${code}): ${stderr.trim() || command[0]}`,
		);
}
