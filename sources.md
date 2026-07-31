# Источники

Дата доступа: 30 июля 2026.

## Botamin

- Официальный сайт: https://botamin.ru/
- Публичная Telegram-лента кейсов: https://t.me/s/GPT_for_sales
- Исходная Notion-ссылка, недоступная на момент работы: https://uprosti.notion.site/conversation-designer

## xAI — официальная документация

- Voice overview: https://docs.x.ai/developers/model-capabilities/audio/voice
- Speech to Text: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
- Text to Speech: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
- Voice REST/WebSocket reference: https://docs.x.ai/developers/rest-api-reference/inference/voice
- Pricing: https://docs.x.ai/developers/pricing

Использованные текущие параметры: Streaming STT `$0.20/hour`, TTS `$15/1M characters`; STT WSS `/v1/stt`, TTS WSS `/v1/tts`; Russian language support; PCM streaming. В списке голосов `iris` описан как подходящий для Sales Support, `eve` — универсальный fallback. Возможный бесплатный allowance конкретного аккаунта не считается публичной гарантией цены.

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
- Vercel AI SDK xAI provider: https://ai-sdk.dev/providers/ai-sdk-providers/xai
- Vercel AI SDK community Codex app-server provider: https://ai-sdk.dev/providers/community-providers/codex-app-server

Вывод: официальный TS SDK удобен для `run`/`runStreamed`, но документированный surface уже, чем app-server protocol; community Codex bridge не принимается как критическая dependency. Для P0 выбран direct app-server adapter, скрытый за `BrainPort`.
