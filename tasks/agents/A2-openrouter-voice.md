# Agent A2 — OpenRouter TypeScript-native STT and TTS adapters

## Mission

Implement **OpenRouter TypeScript-native STT + TTS only** behind provider-neutral ports. One backend-only `OPENROUTER_API_KEY` authorizes both. Do not add another voice gateway, provider credential, provider SDK, Python runtime, or sidecar.

## Read first

- `corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md`
- voice sections in `docs/03-system-architecture.md`
- provider errors and contracts in `docs/05-api-events-data.md`
- T11 and T12 in `tasks/tasks.yaml`
- `sources.md`

## Branch and ownership

Branch: `agent/openrouter-voice`.

Owned:

```text
apps/server/src/providers/openrouter/stt/**
apps/server/src/providers/openrouter/tts/**
scripts/openrouter-stt*
scripts/openrouter-tts*
```

Shared events and ports are consumed, not redefined.

## STT contract

Use native Bun `fetch` to `POST https://openrouter.ai/api/v1/chat/completions`. After backend end-of-turn / `audio.commit`, bound the 16 kHz mono PCM16 utterance by duration and bytes, wrap it as WAV, base64-encode it, and send one `input_audio` content part. Default model is configurable as `openai/gpt-audio-mini`, format `wav`, language `ru`.

This is phrase-level final transcription, **not provider streaming STT**. Emit one final transcript only. Do not promise provider partials, create a provider session abstraction, or forward browser chunks directly to OpenRouter.

Required behavior: connect/total timeouts; at most one bounded retry; `AbortSignal`; stale-turn suppression; typed `400/401/402/404/413/429/5xx`; response validation; and telemetry without API key, WAV/base64 audio, transcript text, or PII. STT retry repeats only pure transcription and can never invoke Luna, tools, or notifier side effects.

## TTS contract

Use native Bun `fetch` to `POST https://openrouter.ai/api/v1/audio/speech`, model `x-ai/grok-voice-tts-1.0`, voice `eve`, and complete `audio/mpeg` MP3 phrase segments. Preserve bounded retries, cancellation, stale-generation suppression, response validation, circuit/budget guards, and text-only output degradation. A TTS retry repeats only synthesis.

## Tests and smoke commands

- Protocol-faithful fake chat-completions endpoint validates base64 WAV `input_audio`, success final transcript, malformed response, limits, timeout, abort, stale turn and retry/error mapping.
- Protocol-faithful fake speech endpoint validates complete MP3 and typed errors.
- Default tests need no credentials.
- Separate paid Russian STT and TTS smoke commands are opt-in and excluded from default CI. Never claim they passed without actually running them.

## Completion report

Return commit SHA, changed paths, official evidence/version assumptions, fake test results, exact model/voice/format, external smoke status (including **not run** when applicable), measured latency only when observed, and unresolved provider quirks.
