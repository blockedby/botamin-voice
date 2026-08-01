#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	configuredCriticalDetectorCodes,
	type EvalPolicy,
	loadJson,
	loadJsonl,
	type NegativeControlManifest,
	type ScenarioFile,
	scoreEval,
	validateNegativeControlManifest,
} from "./scorer.js";

const artifactPath = resolve("evals/artifacts/baseline-fixture-summary.json");
const scenarioPath = resolve("evals/scenarios/scenarios.json");
const policyPath = resolve("evals/policy.json");
const fixturePath = resolve("evals/fixtures/passing-transcripts.jsonl");
const manifestPath = resolve("evals/fixtures/negative-controls/manifest.json");

async function sha256(paths: string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const path of [...paths].sort()) {
		hash.update(path);
		hash.update("\0");
		hash.update(await readFile(resolve(path)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function buildArtifact(): Promise<object> {
	const scenarios = await loadJson<ScenarioFile>(scenarioPath);
	const policy = await loadJson<EvalPolicy>(policyPath);
	const manifest = await loadJson<NegativeControlManifest>(manifestPath);
	validateNegativeControlManifest(manifest, policy);
	const summary = scoreEval(
		scenarios,
		await loadJsonl(fixturePath),
		policy,
		"fixture",
	);
	const controls = [];
	for (const control of manifest.controls) {
		const scenario = scenarios.scenarios.find(
			(candidate) => candidate.id === control.scenarioId,
		);
		if (!scenario)
			throw new Error(`Unknown control scenario ${control.scenarioId}`);
		const result = scoreEval(
			{ schemaVersion: 1, scenarios: [scenario] },
			await loadJsonl(resolve(dirname(manifestPath), control.file)),
			policy,
			"fixture",
		).results[0];
		const observed = [
			...new Set(result?.criticalFailures.map((failure) => failure.code) ?? []),
		].sort();
		controls.push({
			id: control.id,
			passed: control.expectedCriticalCodes.every((code) =>
				observed.includes(code),
			),
		});
	}
	const inputPaths = [
		"evals/src/scorer.ts",
		"evals/src/generate-baseline.ts",
		"evals/tests/scorer.test.ts",
		"evals/event.schema.json",
		"evals/scenario.schema.json",
		"evals/policy.json",
		"evals/scenarios/scenarios.json",
		"evals/fixtures/passing-transcripts.jsonl",
		"evals/fixtures/negative-controls/manifest.json",
		...manifest.controls.map(
			(control) => `evals/fixtures/negative-controls/${control.file}`,
		),
	];
	const promptPaths = [
		"prompts/system.md",
		"prompts/product.md",
		"prompts/conversation-policy.md",
		"prompts/objections.md",
		"prompts/booking.md",
		"prompts/qualification.md",
		"prompts/speech-style.md",
		"knowledge/botamin-overview.md",
		"knowledge/use-cases.md",
		"knowledge/cases.md",
		"knowledge/faq.md",
		"knowledge/allowed-claims.md",
		"knowledge/prohibited-claims.md",
	];
	return {
		schemaVersion: 1,
		generatedBy: "bun evals/src/generate-baseline.ts",
		evidenceMode: "fixture-only",
		realLuna: {
			status: "not-run",
			reason:
				"No safe eval recorder currently captures the required server-owned evidence without risking model-output PII in logs or artifacts.",
			followUp:
				"Add an opt-in, redacting recorder and run this same catalog against real Luna before making model-quality or prompt-tuning claims.",
		},
		providerCalls: 0,
		credentialsRequired: false,
		promptTuningClaimed: true,
		prompt: {
			sourceChangedByProactivePromptTask: true,
			sourceSha256: await sha256(promptPaths),
		},
		inputsSha256: await sha256(inputPaths),
		fixture: {
			scenarioCount: summary.scenarioCount,
			passedScenarios: summary.passedScenarios,
			passRate: summary.passRate,
			criticalFailureCount: summary.criticalFailureCount,
			bookingOrder: summary.bookingOrder,
			fabricatedPriceCount: summary.fabricatedPriceCount,
			guaranteeCount: summary.guaranteeCount,
			secretDisclosureCount: summary.secretDisclosureCount,
			aggregatePass: summary.aggregatePass,
		},
		negativeControls: {
			count: controls.length,
			passed: controls.filter((control) => control.passed).length,
			detectorCoverage: configuredCriticalDetectorCodes(policy),
			ids: controls.map((control) => control.id),
		},
	};
}

const serialized = `${JSON.stringify(await buildArtifact(), null, "\t")}\n`;
if (process.argv.includes("--check")) {
	const committed = await readFile(artifactPath, "utf8");
	if (committed !== serialized) {
		throw new Error(
			"Committed baseline artifact is stale; run bun evals/src/generate-baseline.ts",
		);
	}
	process.stdout.write("Baseline artifact is deterministic and current.\n");
} else {
	await writeFile(artifactPath, serialized, "utf8");
	process.stdout.write(`Wrote ${artifactPath}\n`);
}
