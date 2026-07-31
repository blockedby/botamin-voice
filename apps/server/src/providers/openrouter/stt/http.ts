export type OpenRouterFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class OpenRouterTimeoutError extends Error {
	constructor(readonly phase: "connect" | "total") {
		super(`OpenRouter ${phase} timeout`);
		this.name = "OpenRouterTimeoutError";
	}
}

export class OpenRouterResponseLimitError extends Error {
	constructor() {
		super("OpenRouter response exceeded the configured byte limit");
		this.name = "OpenRouterResponseLimitError";
	}
}

export function createAbortError(
	message = "OpenRouter request aborted",
): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? createAbortError();
}

export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortReason(signal);
}

export interface TimedSignal {
	signal: AbortSignal;
	dispose(): void;
}

/** Compose caller cancellation with one whole-operation deadline. */
export function createTotalTimeoutSignal(
	parent: AbortSignal,
	totalTimeoutMs: number,
): TimedSignal {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(abortReason(parent));
	if (parent.aborted) onAbort();
	else parent.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new OpenRouterTimeoutError("total")),
		totalTimeoutMs,
	);
	return {
		signal: controller.signal,
		dispose(): void {
			clearTimeout(timer);
			parent.removeEventListener("abort", onAbort);
		},
	};
}

/** Race a promise even when a test double does not itself observe AbortSignal. */
export function raceWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** A connect deadline covers fetch until response headers become available. */
export async function fetchWithConnectTimeout(
	fetcher: OpenRouterFetch,
	input: string,
	init: RequestInit,
	parentSignal: AbortSignal,
	connectTimeoutMs: number,
): Promise<Response> {
	throwIfAborted(parentSignal);
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(abortReason(parentSignal));
	parentSignal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new OpenRouterTimeoutError("connect")),
		connectTimeoutMs,
	);
	try {
		return await raceWithSignal(
			fetcher(input, { ...init, signal: controller.signal }),
			controller.signal,
		);
	} finally {
		clearTimeout(timer);
		parentSignal.removeEventListener("abort", onAbort);
	}
}

/** Fully buffer one response while enforcing the limit before concatenation. */
export async function readBoundedResponseBytes(
	response: Response,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	throwIfAborted(signal);
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const item = await raceWithSignal(reader.read(), signal);
			if (item.done) break;
			const chunk = item.value;
			total += chunk.byteLength;
			if (total > maximumBytes) {
				await reader.cancel().catch(() => undefined);
				throw new OpenRouterResponseLimitError();
			}
			chunks.push(chunk.slice());
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function discardBoundedErrorBody(
	response: Response,
	signal: AbortSignal,
): Promise<void> {
	try {
		await readBoundedResponseBytes(response, 8_192, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		// Provider error content is intentionally discarded and never exposed.
	}
}

/** Supports Retry-After delta-seconds and HTTP dates, always capped locally. */
export function boundedRetryAfterMs(
	header: string | null,
	fallbackMs: number,
	maximumMs: number,
	nowMs: number,
): number {
	if (header === null || header.trim() === "") {
		return Math.min(fallbackMs, maximumMs);
	}
	const trimmed = header.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(Math.ceil(seconds * 1_000), maximumMs);
		}
	}
	const date = Date.parse(trimmed);
	if (Number.isFinite(date)) {
		return Math.min(Math.max(0, date - nowMs), maximumMs);
	}
	return Math.min(fallbackMs, maximumMs);
}

export function sleepWithSignal(
	delayMs: number,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	if (delayMs <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function safeProviderRequestId(response: Response): string | undefined {
	const value =
		response.headers.get("x-openrouter-generation-id") ??
		response.headers.get("x-request-id");
	if (value === null || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
		return undefined;
	}
	return value;
}
