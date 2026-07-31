import { createHash } from "node:crypto";

export type Clock = () => Date;
export type IdFactory = () => string;

export function createEntityId(): string {
	return Bun.randomUUIDv7();
}

export function toUtcTimestamp(date: Date): string {
	return date.toISOString();
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, sortJson(entry)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

export function requestHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
