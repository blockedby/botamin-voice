# Agent A2 — xAI STT and OpenRouter TypeScript-native TTS adapters

## Mission

xAI Streaming STT + OpenRouter TypeScript-native TTS. TTS is a native Bun `fetch` adapter behind `TtsPort`; delete Edge/Python deliverables and do not add direct xAI TTS.

Реализовать server-side low-latency voice adapters without exposing xAI credentials to the browser.

## Read first

- xAI sections in `docs/03-system-architecture.md`
- provider errors and WS contracts in `docs/05-api-events-data.md`
- T11 and T12 in `tasks/tasks.yaml`
- `sources.md`

## Branch and ownership

Branch: `agent/xai-voice`.

Owned: `apps/server/src/providers/xai/stt*`, `apps/server/src/providers/openrouter/tts/**`, `scripts/openrouter-tts*`. Shared events are consumed, not redefined.

## STT defaults

`wss://api.x.ai/v1/stt`, 16 kHz PCM16, interim results, Russian, Smart Turn configurable. Send raw binary frames and map provider events to internal events.

## TTS defaults

`POST https://openrouter.ai/api/v1/audio/speech`, model `x-ai/grok-voice-tts-1.0`, voice `eve`, complete `audio/mpeg` MP3 phrase segments, bounded retries, cancellation and text-only fallback.

## Deliverables

- typed adapters and fakes;
- bounded STT buffers/backpressure and bounded complete MP3 response bytes;
- OpenRouter request validation, `audio/mpeg`/non-empty checks and bounded error parsing;
- typed mapping for `400/401/402/403/404/413/429/500/502/503/524/529`;
- at most one retry for `429`/retryable failures, bounded `Retry-After`, timeout, circuit breaker and text-only degradation;
- per-segment/turn/session character budgets and concurrency guard;
- character, latency, status, bytes and safe provider generation telemetry without input text or PII;
- paid external Russian smoke command that is tagged out of default CI;
- no secret in client, errors or ordinary logs.

## Acceptance focus

The first short complete MP3 phrase can play before Luna finishes the full answer. Abort or obsolete generation emits no later playable segment. Retry repeats only the pure synthesis request, never Luna, booking/qualification tools or notifier. `401`/`402`/`404`, budget and circuit failures enter safe text-only behavior.

## Completion report

Commit SHA, external docs/version assumptions, commands/tests, measured smoke latency, voice tested, and unresolved provider quirks.
