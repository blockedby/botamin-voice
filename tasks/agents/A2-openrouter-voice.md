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

Use native Bun `fetch` to `POST https://openrouter.ai/api/v1/chat/completions`. The gateway/utterance assembler—not this adapter—owns duration/byte-bounded 16 kHz mono PCM16 assembly and PCM16-to-WAV encoding after `audio.commit`. `OpenRouterSttAdapter` receives one atomic request whose bytes are already a validated WAV and whose content type is `audio/wav`. It independently validates WAV format and request bounds, rejects raw PCM/malformed WAV/content-type mismatch, base64-encodes the unchanged WAV bytes, and sends one `input_audio` content part. Default model is configurable as `openai/gpt-audio-mini`, format `wav`, language `ru`.

Emit one final transcript only. Do not create a provider session abstraction or forward browser chunks directly to OpenRouter.

Required behavior: WAV/request validation without PCM conversion; connect/total timeouts; at most one bounded retry; `AbortSignal`; stale-turn suppression; typed `400/401/402/404/413/429/5xx`; response validation; and telemetry without API key, WAV/base64 audio, transcript text, or PII. STT retry repeats only pure transcription and can never invoke Luna, tools, or notifier side effects.

## TTS contract

Use native Bun `fetch` to `POST https://openrouter.ai/api/v1/audio/speech`, model `x-ai/grok-voice-tts-1.0`, voice `eve`, and complete `audio/mpeg` MP3 phrase segments. Preserve bounded retries, cancellation, stale-generation suppression, response validation, circuit/budget guards, and text-only output degradation. A TTS retry repeats only synthesis.

## Tests and smoke commands

- Adapter tests start from already-WAV fixtures; a protocol-faithful fake chat-completions endpoint verifies unchanged-byte base64 `input_audio`, raw PCM/malformed WAV rejection, success final transcript, request limits, timeout, abort, stale turn and retry/error mapping.
- Gateway PCM16-to-WAV encoder behavior is tested separately by its owner; A2 must not duplicate that encoder inside the adapter.
- Protocol-faithful fake speech endpoint validates complete MP3 and typed errors.
- Default tests need no credentials.
- Separate paid Russian STT and TTS smoke commands are opt-in and excluded from default CI. Never claim they passed without actually running them.

## Completion report

Return commit SHA, changed paths, official evidence/version assumptions, fake test results, exact model/voice/format, external smoke status (including **not run** when applicable), measured latency only when observed, and unresolved provider quirks.
