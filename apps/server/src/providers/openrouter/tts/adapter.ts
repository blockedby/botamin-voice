import {
	MpegAudioBytesSchema,
	type TtsAudioSegment,
	TtsAudioSegmentSchema,
	type TtsHealth,
	type TtsPort,
	type TtsSynthesisRequest,
	TtsSynthesisRequestDataSchema,
} from "@botamin/contracts";
import { monotonicNowMs } from "../../../observability/clock";
import { type CircuitState, OpenRouterCircuitBreaker } from "../stt/circuit";
import {
	createOpenRouterHeaders,
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "../stt/config";
import {
	type OpenRouterCredentialHealth,
	resolveOpenRouterCredentialHealth,
} from "../stt/credential-health";
import {
	boundedRetryAfterMs,
	createAbortError,
	createTotalTimeoutSignal,
	discardBoundedErrorBody,
	fetchWithConnectTimeout,
	type OpenRouterFetch,
	OpenRouterResponseLimitError,
	OpenRouterTimeoutError,
	readBoundedResponseBytes,
	safeProviderRequestId,
	sleepWithSignal,
	throwIfAborted,
} from "../stt/http";
import { OpenRouterTtsError } from "./errors";
import { isCompleteMp3File } from "./mp3";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 524, 529]);
const MAX_OBSOLETE_GENERATIONS = 10_000;
const MAX_TRACKED_SESSIONS = 256;
const MAX_TRACKED_TURNS = 4_096;

export interface OpenRouterTtsTelemetryEvent {
	provider: "openrouter";
	operation: "tts";
	model: string;
	voice: string;
	format: "mp3";
	characters: number;
	attempt: number;
	retry: boolean;
	status: number | "network";
	latencyMs: number;
	bytes: number;
	circuit: CircuitState;
	outcome: "success" | "failure" | "stale";
}

export interface OpenRouterTtsAdapterOptions {
	config?: OpenRouterVoiceConfig;
	fetch?: OpenRouterFetch;
	monotonicNow?: () => number;
	wallNow?: () => number;
	telemetry?: (event: OpenRouterTtsTelemetryEvent) => void;
	circuitTelemetry?: (state: CircuitState) => void;
	capacityTelemetry?: (event: {
		active: number;
		limit: number;
		rejected: boolean;
	}) => void;
	isGenerationCurrent?: (
		conversationId: string,
		generationId: string,
	) => boolean;
	/** Inject the same instance into STT and TTS for one-key health. */
	credentialHealth?: OpenRouterCredentialHealth;
}

export interface OpenRouterTtsUsage {
	sessionCharacters: number;
	turnCharacters: number;
}

export class OpenRouterTtsAdapter implements TtsPort {
	readonly #config: OpenRouterVoiceConfig;
	readonly #fetch: OpenRouterFetch;
	readonly #monotonicNow: () => number;
	readonly #wallNow: () => number;
	readonly #telemetry:
		| ((event: OpenRouterTtsTelemetryEvent) => void)
		| undefined;
	readonly #circuitTelemetry: ((state: CircuitState) => void) | undefined;
	readonly #capacityTelemetry:
		| ((event: { active: number; limit: number; rejected: boolean }) => void)
		| undefined;
	readonly #isGenerationCurrent:
		| ((conversationId: string, generationId: string) => boolean)
		| undefined;
	readonly #circuit: OpenRouterCircuitBreaker;
	readonly #credentialHealth: OpenRouterCredentialHealth;
	readonly #obsoleteGenerations = new Set<string>();
	readonly #activeSegments = new Set<string>();
	readonly #sessionCharacters = new Map<string, number>();
	readonly #turnCharacters = new Map<string, number>();
	#activeCount = 0;

	constructor(options: OpenRouterTtsAdapterOptions = {}) {
		this.#config = options.config ?? loadOpenRouterVoiceConfig();
		this.#fetch = options.fetch ?? fetch;
		this.#credentialHealth =
			options.credentialHealth ??
			resolveOpenRouterCredentialHealth(
				this.#config,
				options.config === undefined,
			);
		this.#monotonicNow = options.monotonicNow ?? monotonicNowMs;
		this.#wallNow = options.wallNow ?? Date.now;
		this.#telemetry = options.telemetry;
		this.#circuitTelemetry = options.circuitTelemetry;
		this.#capacityTelemetry = options.capacityTelemetry;
		this.#isGenerationCurrent = options.isGenerationCurrent;
		this.#circuit = new OpenRouterCircuitBreaker({
			failureThreshold: this.#config.tts.circuitFailureThreshold,
			cooldownMs: this.#config.tts.circuitCooldownMs,
			now: this.#monotonicNow,
		});
		this.#emitCircuitState();
		this.#emitCapacity(false);
	}

	markGenerationObsolete(generationId: string): void {
		if (!this.#obsoleteGenerations.has(generationId)) {
			while (this.#obsoleteGenerations.size >= MAX_OBSOLETE_GENERATIONS) {
				const oldest = this.#obsoleteGenerations.values().next().value;
				if (oldest === undefined) break;
				this.#obsoleteGenerations.delete(oldest);
			}
			this.#obsoleteGenerations.add(generationId);
		}
	}

	resetSession(conversationId: string): void {
		this.#sessionCharacters.delete(conversationId);
		for (const key of this.#turnCharacters.keys()) {
			if (key.startsWith(`${conversationId}:`))
				this.#turnCharacters.delete(key);
		}
		for (const key of this.#activeSegments) {
			if (key.startsWith(`${conversationId}:`))
				this.#activeSegments.delete(key);
		}
	}

	usage(conversationId: string, turnId: string): OpenRouterTtsUsage {
		return {
			sessionCharacters: this.#sessionCharacters.get(conversationId) ?? 0,
			turnCharacters:
				this.#turnCharacters.get(`${conversationId}:${turnId}`) ?? 0,
		};
	}

	async health(): Promise<TtsHealth> {
		if (this.#config.apiKey === null) return "unavailable";
		if (this.#credentialHealth.ready && this.#circuit.state === "closed") {
			return "ready";
		}
		return this.#config.tts.textOnlyFallback ? "degraded" : "unavailable";
	}

	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.#validateRequestData(request);
		this.#ensureCurrent(request);
		if (this.#config.apiKey === null) {
			throw new OpenRouterTtsError(
				"TTS_CONFIG_INVALID",
				false,
				this.#config.tts.textOnlyFallback,
			);
		}
		const characters = countCharacters(request.text);
		this.#assertBudget(request, characters);
		const segmentKey = `${request.conversationId}:${request.generationId}:${request.segmentId}`;
		if (this.#activeSegments.has(segmentKey)) {
			throw new OpenRouterTtsError("TTS_INVALID_REQUEST", false, false);
		}
		if (this.#activeCount >= this.#config.tts.maxConcurrency) {
			this.#emitCapacity(true);
			throw new OpenRouterTtsError(
				"TTS_CONCURRENCY_LIMIT",
				true,
				this.#config.tts.textOnlyFallback,
			);
		}

		this.#activeSegments.add(segmentKey);
		this.#activeCount += 1;
		this.#emitCapacity(false);
		let circuitAcquired = false;
		try {
			const circuitBeforeAcquire = this.#circuit.state;
			if (!this.#circuit.tryAcquire()) {
				this.#emitCircuitState();
				throw new OpenRouterTtsError(
					"TTS_CIRCUIT_OPEN",
					true,
					this.#config.tts.textOnlyFallback,
				);
			}
			circuitAcquired = true;
			// tryAcquire owns the open -> half-open transition; emit that actual
			// transition before the probe yields to provider I/O.
			if (this.#circuit.state !== circuitBeforeAcquire) {
				this.#emitCircuitState();
			}
			this.#reserveBudget(request, characters);
			const result = await this.#synthesizeWithRetry(request, characters);
			this.#credentialHealth.recordSuccess();
			this.#circuit.recordSuccess();
			this.#emitCircuitState();
			this.#ensureCurrent(request);
			return result;
		} catch (error) {
			if (isCancellation(error) || !this.#isCurrent(request)) {
				if (circuitAcquired) this.#circuit.cancelProbe();
				this.#emitCircuitState();
				throw createAbortError("TTS synthesis aborted or generation obsolete");
			}
			if (circuitAcquired && error instanceof OpenRouterTtsError) {
				if (error.status === 401 || error.status === 402) {
					this.#credentialHealth.recordFailure(error.status);
				}
				this.#circuit.recordFailure({
					retryable: error.retryable,
					forceOpen: [401, 402, 404].includes(error.status ?? -1),
				});
				this.#emitCircuitState();
			}
			throw error;
		} finally {
			this.#activeSegments.delete(segmentKey);
			this.#activeCount -= 1;
			this.#emitCapacity(false);
		}
	}

	async #synthesizeWithRetry(
		request: TtsSynthesisRequest,
		characters: number,
	): Promise<TtsAudioSegment> {
		const timed = createTotalTimeoutSignal(
			request.signal,
			this.#config.tts.totalTimeoutMs,
		);
		try {
			for (
				let attempt = 1;
				attempt <= this.#config.tts.maxRetries + 1;
				attempt += 1
			) {
				this.#ensureCurrent(request, timed.signal);
				try {
					return await this.#requestAttempt(
						request,
						characters,
						attempt,
						timed.signal,
					);
				} catch (error) {
					const typed = mapTransportError(
						error,
						this.#config.tts.textOnlyFallback,
					);
					const mayRetry =
						typed instanceof TtsHttpError &&
						typed.retryable &&
						attempt <= this.#config.tts.maxRetries;
					if (!mayRetry) throw typed;
					this.#ensureCurrent(request, timed.signal);
					const delayMs = boundedRetryAfterMs(
						typed.retryAfter,
						this.#config.tts.retryBaseMs,
						this.#config.tts.maxRetryAfterMs,
						this.#wallNow(),
					);
					await sleepWithSignal(delayMs, timed.signal);
				}
			}
			throw new OpenRouterTtsError(
				"TTS_PROVIDER_UPSTREAM",
				true,
				this.#config.tts.textOnlyFallback,
			);
		} finally {
			timed.dispose();
		}
	}

	async #requestAttempt(
		request: TtsSynthesisRequest,
		characters: number,
		attempt: number,
		signal: AbortSignal,
	): Promise<TtsAudioSegment> {
		const startedAt = this.#monotonicNow();
		let telemetryStatus: number | "network" = "network";
		let responseBytes = 0;
		let providerRequestId: string | undefined;
		let outcome: OpenRouterTtsTelemetryEvent["outcome"] = "failure";
		try {
			const response = await fetchWithConnectTimeout(
				this.#fetch,
				`${this.#config.baseUrl}/audio/speech`,
				{
					method: "POST",
					headers: createOpenRouterHeaders(this.#config, {
						disableCache: true,
					}),
					body: JSON.stringify({
						model: this.#config.tts.model,
						voice: this.#config.tts.voice,
						input: request.text,
						response_format: this.#config.tts.responseFormat,
						...(this.#config.tts.speed === undefined
							? {}
							: { speed: this.#config.tts.speed }),
					}),
				},
				signal,
				this.#config.tts.connectTimeoutMs,
			);
			telemetryStatus = response.status;
			providerRequestId = safeProviderRequestId(response);
			if (!response.ok) {
				await discardBoundedErrorBody(response, signal);
				throw mapHttpStatus(
					response.status,
					response.headers.get("Retry-After"),
					this.#config.tts.textOnlyFallback,
				);
			}
			const contentType = response.headers.get("Content-Type") ?? "";
			if (!/^audio\/mpeg(?:\s*;|\s*$)/i.test(contentType)) {
				await discardBoundedErrorBody(response, signal);
				throw new OpenRouterTtsError(
					"TTS_INVALID_RESPONSE",
					false,
					this.#config.tts.textOnlyFallback,
				);
			}
			const bytes = await readBoundedResponseBytes(
				response,
				this.#config.tts.maxResponseBytes,
				signal,
			);
			responseBytes = bytes.byteLength;
			const parsed = MpegAudioBytesSchema.safeParse(bytes);
			if (!parsed.success || !isCompleteMp3File(bytes)) {
				throw new OpenRouterTtsError(
					"TTS_INVALID_RESPONSE",
					false,
					this.#config.tts.textOnlyFallback,
				);
			}
			this.#ensureCurrent(request, signal);
			outcome = "success";
			return TtsAudioSegmentSchema.parse({
				generationId: request.generationId,
				segmentId: request.segmentId,
				...(providerRequestId === undefined
					? {}
					: { providerGenerationId: providerRequestId }),
				contentType: "audio/mpeg",
				bytes: parsed.data,
				final: true,
			});
		} finally {
			if (!this.#isCurrent(request)) outcome = "stale";
			const event: OpenRouterTtsTelemetryEvent = {
				provider: "openrouter",
				operation: "tts",
				model: this.#config.tts.model,
				voice: this.#config.tts.voice,
				format: "mp3",
				characters,
				attempt,
				retry: attempt > 1,
				status: telemetryStatus,
				latencyMs: Math.max(0, this.#monotonicNow() - startedAt),
				bytes: responseBytes,
				circuit: this.#circuit.state,
				outcome,
			};
			try {
				this.#telemetry?.(event);
			} catch {
				// Observability must never change provider request semantics.
			}
		}
	}

	#emitCapacity(rejected: boolean): void {
		try {
			this.#capacityTelemetry?.({
				active: this.#activeCount,
				limit: this.#config.tts.maxConcurrency,
				rejected,
			});
		} catch {
			// Observability must never change provider admission semantics.
		}
	}

	#emitCircuitState(): void {
		try {
			this.#circuitTelemetry?.(this.#circuit.state);
		} catch {
			// Observability must never change provider circuit semantics.
		}
	}

	#validateRequestData(request: TtsSynthesisRequest): void {
		try {
			TtsSynthesisRequestDataSchema.parse({
				conversationId: request.conversationId,
				turnId: request.turnId,
				generationId: request.generationId,
				segmentId: request.segmentId,
				text: request.text,
			});
			if (!(request.signal instanceof AbortSignal)) throw new Error("signal");
			if (request.text.trim().length === 0) throw new Error("text");
		} catch {
			throw new OpenRouterTtsError("TTS_INVALID_REQUEST", false, false);
		}
	}

	#assertBudget(request: TtsSynthesisRequest, characters: number): void {
		const usage = this.usage(request.conversationId, request.turnId);
		if (
			characters > this.#config.tts.maxCharsPerSegment ||
			usage.turnCharacters + characters > this.#config.tts.maxCharsPerTurn ||
			usage.sessionCharacters + characters > this.#config.tts.maxCharsPerSession
		) {
			throw new OpenRouterTtsError(
				"TTS_BUDGET_EXCEEDED",
				false,
				this.#config.tts.textOnlyFallback,
			);
		}
	}

	#reserveBudget(request: TtsSynthesisRequest, characters: number): void {
		const turnKey = `${request.conversationId}:${request.turnId}`;
		if (!this.#sessionCharacters.has(request.conversationId)) {
			while (this.#sessionCharacters.size >= MAX_TRACKED_SESSIONS) {
				const oldest = this.#sessionCharacters.keys().next().value;
				if (!oldest) break;
				this.#sessionCharacters.delete(oldest);
			}
		}
		if (!this.#turnCharacters.has(turnKey)) {
			while (this.#turnCharacters.size >= MAX_TRACKED_TURNS) {
				const oldest = this.#turnCharacters.keys().next().value;
				if (!oldest) break;
				this.#turnCharacters.delete(oldest);
			}
		}
		this.#sessionCharacters.set(
			request.conversationId,
			(this.#sessionCharacters.get(request.conversationId) ?? 0) + characters,
		);
		this.#turnCharacters.set(
			turnKey,
			(this.#turnCharacters.get(turnKey) ?? 0) + characters,
		);
	}

	#isCurrent(request: TtsSynthesisRequest): boolean {
		return (
			!request.signal.aborted &&
			!this.#obsoleteGenerations.has(request.generationId) &&
			(this.#isGenerationCurrent?.(
				request.conversationId,
				request.generationId,
			) ??
				true)
		);
	}

	#ensureCurrent(
		request: TtsSynthesisRequest,
		signal: AbortSignal = request.signal,
	): void {
		throwIfAborted(signal);
		if (!this.#isCurrent(request)) {
			throw createAbortError("TTS synthesis aborted or generation obsolete");
		}
	}
}

class TtsHttpError extends OpenRouterTtsError {
	constructor(
		code: ConstructorParameters<typeof OpenRouterTtsError>[0],
		retryable: boolean,
		degradeToText: boolean,
		status: number,
		readonly retryAfter: string | null,
	) {
		super(code, retryable, degradeToText, status);
	}
}

function mapHttpStatus(
	status: number,
	retryAfter: string | null,
	fallback: boolean,
): TtsHttpError {
	switch (status) {
		case 400:
			return new TtsHttpError(
				"TTS_PROVIDER_BAD_REQUEST",
				false,
				fallback,
				status,
				null,
			);
		case 401:
			return new TtsHttpError(
				"TTS_PROVIDER_AUTH",
				false,
				fallback,
				status,
				null,
			);
		case 402:
			return new TtsHttpError(
				"TTS_PROVIDER_CREDITS",
				false,
				fallback,
				status,
				null,
			);
		case 403:
			return new TtsHttpError(
				"TTS_PROVIDER_FORBIDDEN",
				false,
				fallback,
				status,
				null,
			);
		case 404:
			return new TtsHttpError(
				"TTS_PROVIDER_MODEL_UNAVAILABLE",
				false,
				fallback,
				status,
				null,
			);
		case 413:
			return new TtsHttpError(
				"TTS_PROVIDER_REQUEST_TOO_LARGE",
				false,
				fallback,
				status,
				null,
			);
		case 429:
			return new TtsHttpError(
				"TTS_PROVIDER_RATE_LIMITED",
				true,
				fallback,
				status,
				retryAfter,
			);
		default:
			if (RETRYABLE_STATUSES.has(status)) {
				return new TtsHttpError(
					"TTS_PROVIDER_UPSTREAM",
					true,
					fallback,
					status,
					retryAfter,
				);
			}
			return new TtsHttpError(
				"TTS_PROVIDER_REJECTED",
				false,
				fallback,
				status,
				null,
			);
	}
}

function mapTransportError(error: unknown, fallback: boolean): unknown {
	if (error instanceof OpenRouterTtsError) return error;
	if (error instanceof OpenRouterTimeoutError) {
		return new OpenRouterTtsError("TTS_TIMEOUT", true, fallback);
	}
	if (error instanceof OpenRouterResponseLimitError) {
		return new OpenRouterTtsError("TTS_RESPONSE_TOO_LARGE", false, fallback);
	}
	if (isCancellation(error)) return error;
	return new OpenRouterTtsError("TTS_NETWORK", false, fallback);
}

function isCancellation(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function countCharacters(value: string): number {
	return Array.from(value).length;
}
