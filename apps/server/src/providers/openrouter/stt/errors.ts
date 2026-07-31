export type OpenRouterSttErrorCode =
	| "STT_CONFIG_INVALID"
	| "STT_INVALID_REQUEST"
	| "STT_AUDIO_TOO_LARGE"
	| "STT_CONCURRENCY_LIMIT"
	| "STT_CIRCUIT_OPEN"
	| "STT_PROVIDER_BAD_REQUEST"
	| "STT_PROVIDER_AUTH"
	| "STT_PROVIDER_CREDITS"
	| "STT_PROVIDER_MODEL_UNAVAILABLE"
	| "STT_PROVIDER_REQUEST_TOO_LARGE"
	| "STT_PROVIDER_RATE_LIMITED"
	| "STT_PROVIDER_UPSTREAM"
	| "STT_PROVIDER_REJECTED"
	| "STT_NETWORK"
	| "STT_TIMEOUT"
	| "STT_INVALID_RESPONSE";

const SAFE_MESSAGES: Record<OpenRouterSttErrorCode, string> = {
	STT_CONFIG_INVALID: "Speech transcription is not configured",
	STT_INVALID_REQUEST: "Speech transcription request is invalid",
	STT_AUDIO_TOO_LARGE: "Speech transcription audio exceeds a local limit",
	STT_CONCURRENCY_LIMIT: "Speech transcription capacity is temporarily full",
	STT_CIRCUIT_OPEN: "Speech transcription is temporarily unavailable",
	STT_PROVIDER_BAD_REQUEST: "Speech provider rejected the audio request",
	STT_PROVIDER_AUTH: "Speech provider authentication is unavailable",
	STT_PROVIDER_CREDITS: "Speech provider credits are unavailable",
	STT_PROVIDER_MODEL_UNAVAILABLE: "Speech transcription model is unavailable",
	STT_PROVIDER_REQUEST_TOO_LARGE: "Speech provider rejected oversized audio",
	STT_PROVIDER_RATE_LIMITED: "Speech transcription is rate limited",
	STT_PROVIDER_UPSTREAM: "Speech transcription provider is unavailable",
	STT_PROVIDER_REJECTED: "Speech transcription provider rejected the request",
	STT_NETWORK: "Speech transcription network request failed",
	STT_TIMEOUT: "Speech transcription request timed out",
	STT_INVALID_RESPONSE:
		"Speech transcription provider returned an invalid response",
};

export class OpenRouterSttError extends Error {
	readonly status: number | undefined;

	constructor(
		readonly code: OpenRouterSttErrorCode,
		readonly retryable: boolean,
		status?: number,
	) {
		super(SAFE_MESSAGES[code]);
		this.name = "OpenRouterSttError";
		this.status = status;
	}
}
