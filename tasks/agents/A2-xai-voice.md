# Agent A2 — xAI STT and TTS adapters

## Mission

Реализовать server-side low-latency voice adapters without exposing xAI credentials to the browser.

## Read first

- xAI sections in `docs/03-system-architecture.md`
- provider errors and WS contracts in `docs/05-api-events-data.md`
- T11 and T12 in `tasks/tasks.yaml`
- `sources.md`

## Branch and ownership

Branch: `agent/xai-voice`.

Owned: `apps/server/src/providers/xai/**`. Shared events are consumed, not redefined.

## STT defaults

`wss://api.x.ai/v1/stt`, 16 kHz PCM16, interim results, Russian, Smart Turn configurable. Send raw binary frames and map provider events to internal events.

## TTS defaults

`wss://api.x.ai/v1/tts`, Russian, configurable voice, PCM 24 kHz, streamed text/audio, multi-utterance reuse, cancellation. Start the smoke comparison with `iris` and `eve`; choose by Russian intelligibility and product tone, not by the name alone.

## Deliverables

- typed adapters and fakes;
- bounded buffers/backpressure;
- provider timeout and close mapping;
- character/audio duration telemetry;
- external smoke command that is not run by default;
- no secret in errors/logs.

## Acceptance focus

First audio must be streamable before full text completion. Cancellation must make late chunks non-playable. Text fallback must be possible when TTS fails.

## Completion report

Commit SHA, external docs/version assumptions, commands/tests, measured smoke latency, voice tested, and unresolved provider quirks.
