#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	type EvalPolicy,
	loadJson,
	loadJsonl,
	type ScenarioFile,
	scoreEval,
} from "./scorer.js";

interface NegativeControlManifest {
	schemaVersion: 1;
	controls: Array<{
		id: string;
		scenarioId: string;
		file: string;
		expectedCriticalCodes: string[];
	}>;
}

interface CliOptions {
	scenarios: string;
	policy: string;
	input?: string;
	fixture: boolean;
	negativeManifest?: string;
	output?: string;
}

function usage(): string {
	return [
		"Usage:",
		"  bun evals/src/cli.ts --fixture [--negative-manifest PATH] [--output PATH]",
		"  bun evals/src/cli.ts --input recorded.jsonl [--output PATH]",
		"Options: --scenarios PATH --policy PATH",
	].join("\n");
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		scenarios: "evals/scenarios/scenarios.json",
		policy: "evals/policy.json",
		fixture: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help") {
			process.stdout.write(`${usage()}\n`);
			process.exit(0);
		}
		if (argument === "--fixture") {
			options.fixture = true;
			continue;
		}
		if (
			![
				"--scenarios",
				"--policy",
				"--input",
				"--negative-manifest",
				"--output",
			].includes(argument ?? "")
		) {
			throw new Error(`Unknown argument: ${argument ?? ""}`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${argument}`);
		if (argument === "--scenarios") options.scenarios = value;
		if (argument === "--policy") options.policy = value;
		if (argument === "--input") options.input = value;
		if (argument === "--negative-manifest") options.negativeManifest = value;
		if (argument === "--output") options.output = value;
		index += 1;
	}
	if (options.fixture === Boolean(options.input)) {
		throw new Error("Choose exactly one of --fixture or --input");
	}
	return options;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const scenarios = await loadJson<ScenarioFile>(options.scenarios);
	const policy = await loadJson<EvalPolicy>(options.policy);
	const inputPath = options.fixture
		? "evals/fixtures/passing-transcripts.jsonl"
		: (options.input as string);
	const summary = scoreEval(
		scenarios,
		await loadJsonl(inputPath),
		policy,
		options.fixture ? "fixture" : "recorded",
	);

	const negativeControls: Array<{
		id: string;
		passed: boolean;
		expectedCriticalCodes: string[];
		observedCriticalCodes: string[];
	}> = [];
	if (options.negativeManifest) {
		const manifestPath = resolve(options.negativeManifest);
		const manifest = await loadJson<NegativeControlManifest>(manifestPath);
		if (manifest.schemaVersion !== 1)
			throw new Error("Unsupported negative-control manifest version");
		for (const control of manifest.controls) {
			const scenario = scenarios.scenarios.find(
				(candidate) => candidate.id === control.scenarioId,
			);
			if (!scenario)
				throw new Error(
					`Negative control ${control.id} uses unknown scenario ${control.scenarioId}`,
				);
			const controlSummary = scoreEval(
				{ schemaVersion: 1, scenarios: [scenario] },
				await loadJsonl(resolve(dirname(manifestPath), control.file)),
				policy,
				"fixture",
			);
			const observed = [
				...new Set(
					controlSummary.results[0]?.criticalFailures.map(
						(failure) => failure.code,
					) ?? [],
				),
			].sort();
			negativeControls.push({
				id: control.id,
				passed: control.expectedCriticalCodes.every((code) =>
					observed.includes(code),
				),
				expectedCriticalCodes: [...control.expectedCriticalCodes].sort(),
				observedCriticalCodes: observed,
			});
		}
	}

	const report = {
		...summary,
		negativeControls: {
			count: negativeControls.length,
			passed: negativeControls.filter((control) => control.passed).length,
			controls: negativeControls,
		},
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output)
		await writeFile(resolve(options.output), serialized, "utf8");
	process.stdout.write(serialized);
	if (
		!summary.aggregatePass ||
		negativeControls.some((control) => !control.passed)
	) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`,
	);
	process.exitCode = 1;
});
