# Источники

Дата доступа: 31 июля 2026.

## Botamin

- Официальный сайт: https://botamin.ru/
- Публичная Telegram-лента кейсов: https://t.me/s/GPT_for_sales
- Исходная Notion-ссылка, недоступная на момент работы: https://uprosti.notion.site/conversation-designer

## OpenRouter voice — официальная документация

- Multimodal audio input/output guide: https://openrouter.ai/docs/guides/overview/multimodal/audio
- Audio-input model endpoint evidence for `openai/gpt-audio-mini`: https://openrouter.ai/api/v1/models/openai/gpt-audio-mini/endpoints
- Audio-input model discovery: https://openrouter.ai/api/v1/models?input_modalities=audio

Проверенные факты для STT: audio input идёт через `/api/v1/chat/completions` как base64 `input_audio`; format указывается в request и зависит от модели; каталог можно фильтровать по audio input. Endpoint evidence на дату доступа содержит `audio` в `input_modalities` для configurable default `openai/gpt-audio-mini`. В активных evidence нет документированного dedicated realtime STT WebSocket, поэтому P0 использует atomic phrase-level WAV request и final transcript only.

### TTS

- TTS guide: https://openrouter.ai/docs/guides/overview/multimodal/tts
- Create speech API: https://openrouter.ai/docs/api/api-reference/tts/create-speech
- Speech-output model discovery: https://openrouter.ai/api/v1/models?output_modalities=speech
- Filtered models page: https://openrouter.ai/models?input_modalities=text&output_modalities=speech
- P0 model page: https://openrouter.ai/x-ai/grok-voice-tts-1.0
- Authentication: https://openrouter.ai/docs/api_reference/authentication
- Errors and debugging: https://openrouter.ai/docs/api_reference/errors-and-debugging
- App attribution: https://openrouter.ai/docs/app-attribution

OpenRouter TTS is paid usage; no free tier is assumed. Default release candidate profile is `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`, but availability, voices and prices are runtime facts verified before release. P0 transport is backend-only native Bun `fetch` to `/api/v1/audio/speech`.

## OpenAI Codex — официальная документация

- Codex app-server: https://developers.openai.com/codex/app-server
- Authentication: https://developers.openai.com/codex/auth
- Trusted CI/CD account auth: https://developers.openai.com/codex/auth/ci-cd-auth
- Codex models: https://developers.openai.com/codex/models
- Codex pricing/limits: https://developers.openai.com/codex/pricing
- Developer commands / device auth: https://developers.openai.com/codex/developer-commands
- Codex SDK: https://developers.openai.com/codex/codex-sdk
- AGENTS.md instructions: https://developers.openai.com/codex/agent-configuration/agents-md

Критичные выводы: ChatGPT sign-in поддерживает subscription access; app-server предоставляет JSON-RPC, threads, streamed agent deltas и interrupt; Luna запускается как `gpt-5.6-luna`; dynamic tools — experimental; account-auth automation рекомендуется только на trusted private infrastructure и с одной машиной/сериализованным использованием auth copy.

## AI SDK candidates

- Official Codex TypeScript SDK: https://developers.openai.com/codex/codex-sdk
- Official Codex TypeScript SDK source/README: https://github.com/openai/codex/tree/main/sdk/typescript
- Vercel AI SDK overview: https://ai-sdk.dev/
- Vercel AI SDK community Codex app-server provider: https://ai-sdk.dev/providers/community-providers/codex-app-server

Вывод: официальный TS SDK удобен для `run`/`runStreamed`, но документированный surface уже, чем app-server protocol; community Codex bridge не принимается как критическая dependency. Для P0 выбран direct app-server adapter, скрытый за `BrainPort`.
