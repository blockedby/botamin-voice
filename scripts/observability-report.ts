#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

const FIXED_TOP_LEVEL = [
	"schemaVersion",
	"generatedAt",
	"retention",
	"milestones",
	"latencyMs",
	"providers",
	"business",
	"queue",
	"capacity",
] as const;
const FORBIDDEN_KEYS = new Set([
	"audio",
	"base64",
	"authorization",
	"auth",
	"contact",
	"contacts",
	"conversationid",
	"cookie",
	"email",
	"key",
	"model",
	"name",
	"phone",
	"prompt",
	"providerrequestid",
	"requestid",
	"segmentid",
	"text",
	"token",
	"transcript",
	"turnid",
	"url",
	"value",
	"voice",
	"wav",
	"webhook",
]);

function fail(message: string): never {
	throw new Error(`observability report failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeAggregate(value: unknown, path = "snapshot"): unknown {
	if (value === null) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0)
			fail(`${path} is not a safe number`);
		return value;
	}
	if (typeof value === "string") {
		if (path.endsWith(".currentCircuitState")) {
			if (!["closed", "open", "half-open", "unknown"].includes(value)) {
				fail(`${path} is not a fixed circuit state`);
			}
			return value;
		}
		if (path !== "snapshot.generatedAt") fail(`${path} contains a string`);
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
			fail("generatedAt is not an ISO timestamp");
		}
		return value;
	}
	if (!isRecord(value)) fail(`${path} is not an aggregate object`);
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		const normalized = key.replace(/[_-]/g, "").toLowerCase();
		if (FORBIDDEN_KEYS.has(normalized)) {
			fail(`${path}.${key} is a forbidden field`);
		}
		result[key] = safeAggregate(entry, `${path}.${key}`);
	}
	return result;
}

try {
	const path = process.argv[2];
	if (!path) fail("usage: observability-report.ts SAFE_SNAPSHOT.json");
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
		fail("unsupported snapshot schemaVersion");
	}
	for (const key of Object.keys(parsed)) {
		if (!(FIXED_TOP_LEVEL as readonly string[]).includes(key)) {
			fail(`unexpected top-level field: ${key}`);
		}
	}
	const report: Record<string, unknown> = {};
	for (const key of FIXED_TOP_LEVEL) {
		if (!(key in parsed)) fail(`missing top-level field: ${key}`);
		report[key] = safeAggregate(parsed[key], `snapshot.${key}`);
	}
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
