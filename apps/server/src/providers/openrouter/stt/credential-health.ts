export type OpenRouterCredentialFailure = "auth" | "credits";

/**
 * Process-local health for the single credential shared by OpenRouter STT/TTS.
 * Construct one per configured voice runtime and inject it into both adapters;
 * tests should construct their own instance so failure state cannot leak.
 */
export class OpenRouterCredentialHealth {
	#failure: OpenRouterCredentialFailure | null = null;

	get failure(): OpenRouterCredentialFailure | null {
		return this.#failure;
	}

	get ready(): boolean {
		return this.#failure === null;
	}

	recordFailure(status: 401 | 402): void {
		this.#failure = status === 401 ? "auth" : "credits";
	}

	/** Any fully validated voice response proves the shared key/credits usable. */
	recordSuccess(): void {
		this.#failure = null;
	}
}

const defaultOpenRouterCredentialHealth = new OpenRouterCredentialHealth();
const configuredCredentialHealth = new WeakMap<
	object,
	OpenRouterCredentialHealth
>();

/**
 * Default constructors share one process scope. Explicitly configured adapters
 * share by config-object identity, so one runtime can coordinate without a
 * global key registry and separate test/runtime configs cannot leak state.
 */
export function resolveOpenRouterCredentialHealth(
	config: object,
	usesDefaultRuntimeConfig: boolean,
): OpenRouterCredentialHealth {
	if (usesDefaultRuntimeConfig) return defaultOpenRouterCredentialHealth;
	const existing = configuredCredentialHealth.get(config);
	if (existing !== undefined) return existing;
	const created = new OpenRouterCredentialHealth();
	configuredCredentialHealth.set(config, created);
	return created;
}
