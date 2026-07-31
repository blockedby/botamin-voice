# Current decisions

**Spec:** `0.5-demo`
**Status:** authoritative active decisions

- OpenRouter is the **only** STT and TTS provider/gateway. One backend-only `OPENROUTER_API_KEY` authorizes both; the browser never receives credentials or calls OpenRouter directly.
- Authoritative pipeline: **browser PCM16 chunks → gateway/utterance assembler bounds mono PCM16 and emits one validated WAV → atomic `audio/wav` `SttPort` request → OpenRouter audio-input chat completion final transcript → Codex subscription / `gpt-5.6-luna` → OpenRouter TTS complete MP3 segment**.
- STT is one atomic phrase-level native `fetch` to `/api/v1/chat/completions` after end-of-turn / `audio.commit`, with base64 `input_audio`, format `wav`, and configurable default model `openai/gpt-audio-mini`. The only STT text event is `transcript.final`.
- `SttPort` is provider-neutral: one request carries a bounded, validated `audio/wav` payload and returns one final result. Browser-to-backend microphone transport remains chunked PCM16; the gateway/utterance assembler alone builds the WAV. `OpenRouterSttAdapter` validates and bounds the already-WAV bytes, base64-encodes them without conversion, applies request timeout/retry, and suppresses aborted or stale results.
- TTS uses native Bun `fetch` to `/api/v1/audio/speech`, model `x-ai/grok-voice-tts-1.0`, voice `eve`, and complete MP3 phrase segments. `TtsPort` remains provider-neutral; playback is ordered, cancellable, generation-filtered, and can degrade to text-only output.
- Phrase-level STT adds end-of-turn upload/inference latency. UI states show listening, processing, and `transcript.final` only.
- Booking is committed before optional qualification. STT or TTS retries/failures never repeat Luna, business tools, or notifier side effects.
- Prompts remain Markdown, the app remains one TypeScript full-stack Compose deployment, and no real calendar event is created.
