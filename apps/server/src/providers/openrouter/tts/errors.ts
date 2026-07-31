export type OpenRouterTtsErrorCode =
	| "TTS_CONFIG_INVALID"
	| "TTS_INVALID_REQUEST"
	| "TTS_BUDGET_EXCEEDED"
	| "TTS_CONCURRENCY_LIMIT"
	| "TTS_CIRCUIT_OPEN"
	| "TTS_PROVIDER_BAD_REQUEST"
	| "TTS_PROVIDER_AUTH"
	| "TTS_PROVIDER_CREDITS"
	| "TTS_PROVIDER_FORBIDDEN"
	| "TTS_PROVIDER_MODEL_UNAVAILABLE"
	| "TTS_PROVIDER_REQUEST_TOO_LARGE"
	| "TTS_PROVIDER_RATE_LIMITED"
	| "TTS_PROVIDER_UPSTREAM"
	| "TTS_PROVIDER_REJECTED"
	| "TTS_NETWORK"
	| "TTS_TIMEOUT"
	| "TTS_INVALID_RESPONSE"
	| "TTS_RESPONSE_TOO_LARGE";

const SAFE_MESSAGES: Record<OpenRouterTtsErrorCode, string> = {
	TTS_CONFIG_INVALID: "Speech synthesis is not configured",
	TTS_INVALID_REQUEST: "Speech synthesis request is invalid",
	TTS_BUDGET_EXCEEDED: "Speech synthesis character budget is exhausted",
	TTS_CONCURRENCY_LIMIT: "Speech synthesis capacity is temporarily full",
	TTS_CIRCUIT_OPEN: "Speech synthesis is temporarily unavailable",
	TTS_PROVIDER_BAD_REQUEST: "Speech provider rejected the synthesis request",
	TTS_PROVIDER_AUTH: "Speech provider authentication is unavailable",
	TTS_PROVIDER_CREDITS: "Speech provider credits are unavailable",
	TTS_PROVIDER_FORBIDDEN: "Speech provider policy rejected the request",
	TTS_PROVIDER_MODEL_UNAVAILABLE: "Speech synthesis model is unavailable",
	TTS_PROVIDER_REQUEST_TOO_LARGE: "Speech provider rejected oversized text",
	TTS_PROVIDER_RATE_LIMITED: "Speech synthesis is rate limited",
	TTS_PROVIDER_UPSTREAM: "Speech synthesis provider is unavailable",
	TTS_PROVIDER_REJECTED: "Speech synthesis provider rejected the request",
	TTS_NETWORK: "Speech synthesis network request failed",
	TTS_TIMEOUT: "Speech synthesis request timed out",
	TTS_INVALID_RESPONSE: "Speech provider returned invalid audio",
	TTS_RESPONSE_TOO_LARGE: "Speech provider audio exceeded a local limit",
};

export class OpenRouterTtsError extends Error {
	readonly status: number | undefined;

	constructor(
		readonly code: OpenRouterTtsErrorCode,
		readonly retryable: boolean,
		readonly degradeToText: boolean,
		status?: number,
	) {
		super(SAFE_MESSAGES[code]);
		this.name = "OpenRouterTtsError";
		this.status = status;
	}
}
