import type { OpenRouterFixtureStatus } from "../../packages/test-fixtures/src/openrouter";

// Intentional negative control: if this stops being a type error, tsc reports the
// now-unused @ts-expect-error and proves the tests project is on the typecheck path.
// @ts-expect-error HTTP 201 is deliberately not a scriptable provider status.
const unsupportedProviderStatus: OpenRouterFixtureStatus = 201;

void unsupportedProviderStatus;
