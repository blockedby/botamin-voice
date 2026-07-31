import {
	type SttHealth,
	type SttPort,
	type SttTranscriptionRequest,
	SttTranscriptionRequestDataSchema,
	type SttTranscriptionResult,
	SttTranscriptionResultSchema,
} from "@botamin/contracts";
import { type CircuitState, OpenRouterCircuitBreaker } from "./circuit";
import {
	createOpenRouterHeaders,
	loadOpenRouterVoiceConfig,
	type OpenRouterVoiceConfig,
} from "./config";
import { OpenRouterSttError } from "./errors";
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
} from "./http";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 524, 529]);
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 256_000;
const MAX_OBSOLETE_TURNS = 10_000;
const RUSSIAN_TRANSCRIPT_ONLY_INSTRUCTION =
	"Transcribe the Russian speech accurately. Return only the transcript text, without commentary, labels, translation, or formatting.";

export interface OpenRouterSttTelemetryEvent {
	provider: "openrouter";
	operation: "stt";
	model: string;
	format: "wav";
	conversationId: string;
	turnId: string;
	audioBytes: number;
	durationMs: number;
	attempt: number;
	retry: boolean;
	status: number | "network";
	latencyMs: number;
	circuit: CircuitState;
	providerRequestId?: string;
}

export interface OpenRouterSttAdapterOptions {
	config?: OpenRouterVoiceConfig;
	fetch?: OpenRouterFetch;
	now?: () => number;
	telemetry?: (event: OpenRouterSttTelemetryEvent) => void;
	isTurnCurrent?: (conversationId: string, turnId: string) => boolean;
}

interface ValidatedWav {
	durationMs: number;
}

export class OpenRouterSttAdapter implements SttPort {
	readonly #config: OpenRouterVoiceConfig;
	readonly #fetch: OpenRouterFetch;
	readonly #now: () => number;
	readonly #telemetry:
		| ((event: OpenRouterSttTelemetryEvent) => void)
		| undefined;
	readonly #isTurnCurrent:
		| ((conversationId: string, turnId: string) => boolean)
		| undefined;
	readonly #circuit: OpenRouterCircuitBreaker;
	readonly #obsoleteTurns = new Set<string>();
	readonly #activeTurns = new Set<string>();
	#activeCount = 0;

	constructor(options: OpenRouterSttAdapterOptions = {}) {
		this.#config = options.config ?? loadOpenRouterVoiceConfig();
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#telemetry = options.telemetry;
		this.#isTurnCurrent = options.isTurnCurrent;
		this.#circuit = new OpenRouterCircuitBreaker({
			failureThreshold: this.#config.stt.circuitFailureThreshold,
			cooldownMs: this.#config.stt.circuitCooldownMs,
			now: this.#now,
		});
	}

	markTurnObsolete(turnId: string): void {
		if (!this.#obsoleteTurns.has(turnId)) {
			while (this.#obsoleteTurns.size >= MAX_OBSOLETE_TURNS) {
				const oldest = this.#obsoleteTurns.values().next().value;
				if (oldest === undefined) break;
				this.#obsoleteTurns.delete(oldest);
			}
			this.#obsoleteTurns.add(turnId);
		}
	}

	async health(): Promise<SttHealth> {
		if (this.#config.apiKey === null) return "unavailable";
		return this.#circuit.state === "closed" ? "ready" : "degraded";
	}

	async transcribe(
		request: SttTranscriptionRequest,
	): Promise<SttTranscriptionResult> {
		this.#validateRequestData(request);
		this.#ensureCurrent(request);
		if (this.#config.apiKey === null) {
			throw new OpenRouterSttError("STT_CONFIG_INVALID", false);
		}
		const wav = validateCanonicalWav(
			request.audio,
			this.#config.stt.maxAudioBytes,
			this.#config.stt.maxUtteranceMs,
		);
		const turnKey = `${request.conversationId}:${request.turnId}`;
		if (this.#activeTurns.has(turnKey)) {
			throw new OpenRouterSttError("STT_INVALID_REQUEST", false);
		}
		if (this.#activeCount >= this.#config.stt.maxConcurrency) {
			throw new OpenRouterSttError("STT_CONCURRENCY_LIMIT", true);
		}

		this.#activeTurns.add(turnKey);
		this.#activeCount += 1;
		let circuitAcquired = false;
		try {
			if (!this.#circuit.tryAcquire()) {
				throw new OpenRouterSttError("STT_CIRCUIT_OPEN", true);
			}
			circuitAcquired = true;
			const result = await this.#transcribeWithRetry(request, wav);
			this.#circuit.recordSuccess();
			this.#ensureCurrent(request);
			return result;
		} catch (error) {
			if (isCancellation(error) || !this.#isCurrent(request)) {
				if (circuitAcquired) this.#circuit.cancelProbe();
				throw createAbortError("STT transcription aborted or turn obsolete");
			}
			if (circuitAcquired && error instanceof OpenRouterSttError) {
				this.#circuit.recordFailure({
					retryable: error.retryable,
					forceOpen: [401, 402, 404].includes(error.status ?? -1),
				});
			}
			throw error;
		} finally {
			this.#activeTurns.delete(turnKey);
			this.#activeCount -= 1;
		}
	}

	async #transcribeWithRetry(
		request: SttTranscriptionRequest,
		wav: ValidatedWav,
	): Promise<SttTranscriptionResult> {
		const timed = createTotalTimeoutSignal(
			request.signal,
			this.#config.stt.totalTimeoutMs,
		);
		try {
			for (
				let attempt = 1;
				attempt <= this.#config.stt.maxRetries + 1;
				attempt += 1
			) {
				this.#ensureCurrent(request, timed.signal);
				try {
					return await this.#requestAttempt(
						request,
						wav,
						attempt,
						timed.signal,
					);
				} catch (error) {
					const typed = mapTransportError(error);
					const mayRetry =
						typed instanceof SttHttpError &&
						typed.retryable &&
						attempt <= this.#config.stt.maxRetries;
					if (!mayRetry) throw typed;
					this.#ensureCurrent(request, timed.signal);
					const retryAfter =
						typed instanceof SttHttpError ? typed.retryAfter : null;
					const delayMs = boundedRetryAfterMs(
						retryAfter,
						this.#config.stt.retryBaseMs,
						this.#config.stt.maxRetryAfterMs,
						this.#now(),
					);
					await sleepWithSignal(delayMs, timed.signal);
				}
			}
			throw new OpenRouterSttError("STT_PROVIDER_UPSTREAM", true);
		} finally {
			timed.dispose();
		}
	}

	async #requestAttempt(
		request: SttTranscriptionRequest,
		wav: ValidatedWav,
		attempt: number,
		signal: AbortSignal,
	): Promise<SttTranscriptionResult> {
		const startedAt = this.#now();
		let telemetryStatus: number | "network" = "network";
		let providerRequestId: string | undefined;
		try {
			const response = await fetchWithConnectTimeout(
				this.#fetch,
				`${this.#config.baseUrl}/chat/completions`,
				{
					method: "POST",
					headers: createOpenRouterHeaders(this.#config, {
						disableCache: false,
					}),
					body: JSON.stringify({
						model: this.#config.stt.model,
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text: RUSSIAN_TRANSCRIPT_ONLY_INSTRUCTION,
									},
									{
										type: "input_audio",
										input_audio: {
											data: Buffer.from(
												request.audio.buffer,
												request.audio.byteOffset,
												request.audio.byteLength,
											).toString("base64"),
											format: this.#config.stt.audioFormat,
										},
									},
								],
							},
						],
					}),
				},
				signal,
				this.#config.stt.connectTimeoutMs,
			);
			telemetryStatus = response.status;
			providerRequestId = safeProviderRequestId(response);
			if (!response.ok) {
				await discardBoundedErrorBody(response, signal);
				throw mapHttpStatus(
					response.status,
					response.headers.get("Retry-After"),
				);
			}
			const contentType = response.headers.get("Content-Type") ?? "";
			if (!contentType.toLowerCase().includes("application/json")) {
				await discardBoundedErrorBody(response, signal);
				throw new OpenRouterSttError("STT_INVALID_RESPONSE", false);
			}
			const bytes = await readBoundedResponseBytes(
				response,
				MAX_TRANSCRIPTION_RESPONSE_BYTES,
				signal,
			);
			const text = decodeTranscriptResponse(bytes);
			this.#ensureCurrent(request, signal);
			return SttTranscriptionResultSchema.parse({
				conversationId: request.conversationId,
				turnId: request.turnId,
				text,
				final: true,
			});
		} finally {
			const event: OpenRouterSttTelemetryEvent = {
				provider: "openrouter",
				operation: "stt",
				model: this.#config.stt.model,
				format: "wav",
				conversationId: request.conversationId,
				turnId: request.turnId,
				audioBytes: request.audio.byteLength,
				durationMs: wav.durationMs,
				attempt,
				retry: attempt > 1,
				status: telemetryStatus,
				latencyMs: Math.max(0, this.#now() - startedAt),
				circuit: this.#circuit.state,
				...(providerRequestId === undefined ? {} : { providerRequestId }),
			};
			try {
				this.#telemetry?.(event);
			} catch {
				// Observability must never change provider request semantics.
			}
		}
	}

	#validateRequestData(request: SttTranscriptionRequest): void {
		try {
			SttTranscriptionRequestDataSchema.parse({
				conversationId: request.conversationId,
				turnId: request.turnId,
				audio: request.audio,
				contentType: request.contentType,
				language: request.language,
			});
			if (!(request.signal instanceof AbortSignal)) throw new Error("signal");
			if (request.language !== this.#config.stt.language) {
				throw new Error("language");
			}
		} catch {
			throw new OpenRouterSttError("STT_INVALID_REQUEST", false);
		}
	}

	#isCurrent(request: SttTranscriptionRequest): boolean {
		return (
			!request.signal.aborted &&
			!this.#obsoleteTurns.has(request.turnId) &&
			(this.#isTurnCurrent?.(request.conversationId, request.turnId) ?? true)
		);
	}

	#ensureCurrent(
		request: SttTranscriptionRequest,
		signal: AbortSignal = request.signal,
	): void {
		throwIfAborted(signal);
		if (!this.#isCurrent(request)) {
			throw createAbortError("STT transcription aborted or turn obsolete");
		}
	}
}

class SttHttpError extends OpenRouterSttError {
	constructor(
		code: ConstructorParameters<typeof OpenRouterSttError>[0],
		retryable: boolean,
		status: number,
		readonly retryAfter: string | null,
	) {
		super(code, retryable, status);
	}
}

function mapHttpStatus(
	status: number,
	retryAfter: string | null,
): SttHttpError {
	switch (status) {
		case 400:
			return new SttHttpError("STT_PROVIDER_BAD_REQUEST", false, status, null);
		case 401:
			return new SttHttpError("STT_PROVIDER_AUTH", false, status, null);
		case 402:
			return new SttHttpError("STT_PROVIDER_CREDITS", false, status, null);
		case 404:
			return new SttHttpError(
				"STT_PROVIDER_MODEL_UNAVAILABLE",
				false,
				status,
				null,
			);
		case 413:
			return new SttHttpError(
				"STT_PROVIDER_REQUEST_TOO_LARGE",
				false,
				status,
				null,
			);
		case 429:
			return new SttHttpError(
				"STT_PROVIDER_RATE_LIMITED",
				true,
				status,
				retryAfter,
			);
		default:
			if (RETRYABLE_STATUSES.has(status)) {
				return new SttHttpError(
					"STT_PROVIDER_UPSTREAM",
					true,
					status,
					retryAfter,
				);
			}
			return new SttHttpError("STT_PROVIDER_REJECTED", false, status, null);
	}
}

function mapTransportError(error: unknown): unknown {
	if (error instanceof OpenRouterSttError) return error;
	if (error instanceof OpenRouterTimeoutError) {
		return new OpenRouterSttError("STT_TIMEOUT", true);
	}
	if (error instanceof OpenRouterResponseLimitError) {
		return new OpenRouterSttError("STT_INVALID_RESPONSE", false);
	}
	if (isCancellation(error)) return error;
	return new OpenRouterSttError("STT_NETWORK", false);
}

function isCancellation(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function decodeTranscriptResponse(bytes: Uint8Array): string {
	try {
		const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const value: unknown = JSON.parse(jsonText);
		if (typeof value !== "object" || value === null) throw new Error("object");
		const choices = Reflect.get(value, "choices");
		if (!Array.isArray(choices) || choices.length !== 1) {
			throw new Error("choices");
		}
		const choice = choices[0];
		if (typeof choice !== "object" || choice === null)
			throw new Error("choice");
		const message = Reflect.get(choice, "message");
		if (typeof message !== "object" || message === null) {
			throw new Error("message");
		}
		const content = Reflect.get(message, "content");
		if (typeof content !== "string") throw new Error("content");
		const transcript = content.trim();
		if (transcript.length === 0 || transcript.length > 20_000) {
			throw new Error("transcript");
		}
		return transcript;
	} catch (error) {
		if (error instanceof OpenRouterSttError) throw error;
		throw new OpenRouterSttError("STT_INVALID_RESPONSE", false);
	}
}

/** Strict canonical 44-byte-header RIFF/WAVE parser; deliberately not an encoder. */
function validateCanonicalWav(
	bytes: Uint8Array,
	maximumBytes: number,
	maximumDurationMs: number,
): ValidatedWav {
	if (bytes.byteLength > maximumBytes) {
		throw new OpenRouterSttError("STT_AUDIO_TOO_LARGE", false);
	}
	try {
		if (bytes.byteLength < 46) throw new Error("truncated");
		const ascii = (offset: number, length: number): string =>
			String.fromCharCode(...bytes.subarray(offset, offset + length));
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
			throw new Error("container");
		}
		if (
			view.getUint32(4, true) !== bytes.byteLength - 8 ||
			ascii(12, 4) !== "fmt " ||
			view.getUint32(16, true) !== 16 ||
			view.getUint16(20, true) !== 1 ||
			view.getUint16(22, true) !== 1 ||
			view.getUint32(24, true) !== 16_000 ||
			view.getUint32(28, true) !== 32_000 ||
			view.getUint16(32, true) !== 2 ||
			view.getUint16(34, true) !== 16 ||
			ascii(36, 4) !== "data"
		) {
			throw new Error("format");
		}
		const dataBytes = view.getUint32(40, true);
		if (
			dataBytes === 0 ||
			dataBytes % 2 !== 0 ||
			dataBytes !== bytes.byteLength - 44
		) {
			throw new Error("data");
		}
		const durationMs = dataBytes / 32;
		if (durationMs > maximumDurationMs) {
			throw new OpenRouterSttError("STT_AUDIO_TOO_LARGE", false);
		}
		return { durationMs };
	} catch (error) {
		if (error instanceof OpenRouterSttError) throw error;
		throw new OpenRouterSttError("STT_INVALID_REQUEST", false);
	}
}
