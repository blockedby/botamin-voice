# Current decisions

**Spec:** `0.4-demo`
**Status:** authoritative active decisions

- Pipeline: browser PCM16 → xAI Streaming STT → Codex subscription / `gpt-5.6-luna` → sanitized phrase chunks → OpenRouter TTS.
- P0 TTS uses native Bun `fetch` to `POST /api/v1/audio/speech`, configured by `OPENROUTER_TTS_MODEL`, `OPENROUTER_TTS_VOICE`, and MP3 response format. The OpenRouter key is backend-only and usage is paid; no free tier is assumed.
- `TtsPort` remains provider-neutral. Each request returns one complete `audio/mpeg` phrase segment; browser playback is ordered, cancellable, generation-filtered, and text-only degradation is supported.
- xAI is STT-only. The retired speech-output stacks and variables named by Correction 003 are not active.
- Booking is committed before optional qualification; TTS retries/failures never repeat Luna or business-tool side effects.
- Prompts remain Markdown, the app remains one TypeScript full-stack Compose deployment, and no real calendar event is created.
