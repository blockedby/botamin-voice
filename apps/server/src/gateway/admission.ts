import { isIP } from "node:net";

export interface SourceAdmissionOptions {
	windowMs: number;
	maxCreatesPerSource: number;
	maxSocketConnectionsPerSource: number;
	maxTrackedSources?: number;
	now?: () => number;
}

interface SourceWindow {
	creates: number[];
	sockets: number[];
	lastSeenAt: number;
}

/**
 * Process-local abuse guard. Active-conversation ownership is enforced by the
 * registry; this limiter bounds valid create and WebSocket upgrade attempts.
 */
export class SourceAdmissionLimiter {
	readonly #windowMs: number;
	readonly #maxCreates: number;
	readonly #maxSockets: number;
	readonly #maxTrackedSources: number;
	readonly #now: () => number;
	readonly #sources = new Map<string, SourceWindow>();
	#operations = 0;

	constructor(options: SourceAdmissionOptions) {
		this.#windowMs = options.windowMs;
		this.#maxCreates = options.maxCreatesPerSource;
		this.#maxSockets = options.maxSocketConnectionsPerSource;
		this.#maxTrackedSources = options.maxTrackedSources ?? 4_096;
		this.#now = options.now ?? Date.now;
	}

	allowCreate(sourceKey: string): boolean {
		return this.#allow(sourceKey, "creates", this.#maxCreates);
	}

	allowSocket(sourceKey: string): boolean {
		return this.#allow(sourceKey, "sockets", this.#maxSockets);
	}

	get trackedSourceCount(): number {
		return this.#sources.size;
	}

	#allow(
		sourceKey: string,
		kind: "creates" | "sockets",
		maximum: number,
	): boolean {
		const now = this.#now();
		this.#operations += 1;
		if (
			this.#sources.size >= this.#maxTrackedSources ||
			this.#operations % 128 === 0
		) {
			this.#pruneExpired(now);
		}
		let source = this.#sources.get(sourceKey);
		if (!source) {
			if (this.#sources.size >= this.#maxTrackedSources) return false;
			source = { creates: [], sockets: [], lastSeenAt: now };
			this.#sources.set(sourceKey, source);
		}
		const cutoff = now - this.#windowMs;
		while ((source[kind][0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
			source[kind].shift();
		}
		source.lastSeenAt = now;
		if (source[kind].length >= maximum) return false;
		source[kind].push(now);
		return true;
	}

	#pruneExpired(now: number): void {
		const cutoff = now - this.#windowMs;
		for (const [key, source] of this.#sources) {
			if (source.lastSeenAt > cutoff) continue;
			this.#sources.delete(key);
		}
	}
}

/**
 * Derives a stable source key without trusting forwarding headers by default.
 * When trustedProxyHops is non-zero, every X-Forwarded-For entry must be a
 * literal IP and the configured right-most trusted hop is removed.
 */
export function resolveRequestSourceKey(input: {
	headers: Headers;
	directAddress?: string | null;
	trustedProxyHops: number;
}): string | null {
	const direct = normalizeIp(input.directAddress ?? "") ?? "unknown";
	if (input.trustedProxyHops === 0) return `ip:${direct}`;

	const forwarded = input.headers.get("x-forwarded-for");
	if (forwarded === null || forwarded.trim() === "") return `ip:${direct}`;
	if (forwarded.length > 512) return null;
	const entries = forwarded.split(",").map((entry) => entry.trim());
	if (
		entries.length < input.trustedProxyHops ||
		entries.length > 8 ||
		entries.some((entry) => normalizeIp(entry) === null)
	) {
		return null;
	}
	const index = entries.length - input.trustedProxyHops;
	const selected = normalizeIp(entries[index] ?? "");
	return selected === null ? null : `ip:${selected}`;
}

function normalizeIp(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed.startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4) {
		return trimmed.slice(7);
	}
	return isIP(trimmed) === 0 ? null : trimmed.toLowerCase();
}
