# 07. Trade-offs и Architecture Decision Records

## ADR-001. Разделить OpenRouter voice gateway и Codex/Luna brain

**Статус:** accepted.

### Решение

- OpenRouter phrase-level STT: речь → текст;
- Codex app-server + `gpt-5.6-luna` по умолчанию: диалог, policy, tools; model/effort остаются конфигурацией;
- OpenRouter TTS: текст → complete MP3 phrase segments через server-side Bun adapter.

### Почему

- пользователь уже имеет Codex subscription;
- Luna — быстрый и дешёвый вариант в семействе для повторяемых high-volume turns;
- voice provider и brain можно менять независимо;
- backend сохраняет полный контроль над business state.

### Цена решения

- phrase-level STT ждёт конец реплики, WAV upload и inference до появления final transcript, поэтому end-to-end latency выше;
- больше HTTP requests и failure modes;
- нужен sentence chunker и interruption coordination;
- subscription auth требует операционной дисциплины.

### Митигация

chunked browser capture, bounded utterance, short TTS phrases, compact prompt context, low effort, provider adapters and separate commit-to-final/final-to-playback instrumentation.

## ADR-002. Использовать Codex subscription auth на trusted VPS

**Статус:** accepted с риском.

### Плюсы

- использует уже оплаченную подписку/credits;
- Luna доступна через Codex;
- быстрый старт без отдельного API-billing path.

### Минусы

- OpenAI рекомендует API keys для большинства generic automation сценариев;
- auth cache — чувствительный секрет;
- rolling limits не являются гарантированной production capacity;
- одна копия auth — одна машина/сериализованный поток;
- re-auth и изменения продукта могут потребовать участия владельца.

### Guardrails

- single VPS / single app replica;
- persistent encrypted/permissioned `CODEX_HOME`;
- startup preflight и admin alert;
- `BrainPort` позволяет добавить API-key adapter;
- приложение не покупает credits автоматически.

## ADR-003. Не использовать универсальный AI SDK в primary realtime runtime

**Статус:** accepted.

### Рассмотрено

| Вариант | Результат |
|---|---|
| Direct Codex app-server JSON-RPC | выбран для P0: полный доступ к threads, streamed deltas, `turn/interrupt`, `instructionSources` и experimental tools |
| `@openai/codex-sdk` | официальный и удобный для обычных streamed runs, но публичный TS surface не гарантирует обязательный low-level app-server control; официально требует Node 18+, а runtime — Bun |
| Vercel AI SDK | полезен для normalized text/structured output и future API-key adapters; Codex app-server bridge — community provider, а binary voice path всё равно custom |
| LangChain/LangGraph/Mastra | не выбран: deterministic state machine уже решает orchestration, дополнительный graph layer не даёт выигрыша |
| OpenAI Responses API | хороший production fallback, но usage-based и не использует subscription allowance |
| End-to-end speech-to-speech provider | не выбран: текстовый brain и domain/tool policy должны оставаться Codex/Luna и backend-owned |

### Реализация

`BrainPort` изолирует transport. P0 — тонкий typed client к pinned `codex app-server`; protocol schemas проверяются contract tests. Zod используется для собственных domain/API contracts. `@openai/codex-sdk` разрешён только для spike/offline evals или будущей замены adapter после прохождения тех же interrupt/tool/isolation tests.

Подробная матрица — в [`10-ai-library-evaluation.md`](10-ai-library-evaluation.md).

## ADR-004. Dynamic tools — только за feature flag

**Статус:** accepted.

Dynamic tool API Codex app-server экспериментальный. Default может быть `dynamic` после contract test, но `envelope` fallback обязателен. Release не должен зависеть от незамеченного protocol drift.

## ADR-005. Backend-owned state machine

**Статус:** accepted.

Prompt-only state считается недостаточным. LLM может предложить action, но transition и side effects разрешает deterministic policy. Это особенно важно для порядка booking → qualification.

## ADR-006. Prompts в Markdown, без онлайн-редактора

**Статус:** accepted.

Плюсы: Git history, diff, review, простая параллельная работа. Минусы: нет non-technical editor и мгновенной публикации. Для MVP это правильный обмен.

## ADR-007. SQLite + WAL

**Статус:** accepted для single VPS.

Плюсы: минимум ops, транзакции, backup, один volume. Минусы: один writer/host, нет горизонтального scale. Текущий deployment всё равно single-replica из-за subscription auth.

## ADR-008. Один Compose project, modular monolith

**Статус:** accepted.

Приложение логически модульное, но не дробится на services. Caddy может быть вторым контейнером в том же Compose.

## ADR-009. Бронь — внутренняя сущность, не календарь

**Статус:** accepted.

Это сокращает scope и позволяет проверить conversation/tool design. UI и voice copy обязаны не создавать ложного ожидания calendar event.

## ADR-010. Qualification только после booking

**Статус:** accepted, non-negotiable.

Плюсы: меньше потерянных лидов и ясная транзакционная граница. Минусы: booking может быть менее подробно квалифицирована. Этот минус ожидаем и допустим.

## ADR-011. PCM speech output path

**Статус:** rejected for P0 / superseded by ADR-015.

Raw PCM applies only to browser microphone input. P0 speech output uses complete `audio/mpeg` phrase segments; arbitrary network response chunks are not treated as playable files.

## ADR-012. TTS profile and paid usage are configuration facts

**Статус:** superseded by ADR-015.

No free usage allowance is assumed. Model, lowercase voice ID, format and optional speed remain environment configuration. Character telemetry, hard budgets, circuit breaker and text-only degradation protect the demo from uncontrolled paid usage.

## ADR-013. Codex subscription/Luna — MVP optimization, не production entitlement

**Статус:** accepted с release guard.

Используем подписку владельца и `gpt-5.6-luna`, потому что это быстро и снижает прямой variable cost прототипа. При этом Codex account auth предназначен для trusted private automation, а public conversational workload не должен рассматриваться как гарантированный production API/SLA.

Guardrails:

- browser никогда не взаимодействует с Codex напрямую;
- rate limit, bounded queue, session limit и sandbox обязательны;
- до публичного коммерческого запуска проводится plan/terms/capacity review;
- `BrainPort` допускает отдельный API-key adapter;
- exhaustion subscription quota переводит сервис в controlled degraded mode, не повреждая booking data.

## ADR-015 — OpenRouter is the P0 TTS gateway

**Status:** accepted.

Use a TypeScript/Bun adapter with native `fetch` against `POST https://openrouter.ai/api/v1/audio/speech`. Default profile: `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`. Do not use a second TTS gateway, Python sidecar or provider SDK in P0. Keep `TtsPort` provider-neutral and retain text-only degradation.

Consequences and guardrails:

- OpenRouter and its upstream are external paid dependencies; no free tier is assumed.
- One request produces one buffered, validated, complete `audio/mpeg` phrase segment.
- Only server-side native Bun `fetch` is used; no provider SDK is required for P0.
- Model/voice availability and price are runtime facts recorded in release evidence, not permanent documentation constants.
- `401`, `402`, `404`, bounded `429`/retryable `5xx`, circuit breaker, character budgets and text-only behavior follow the contracts in docs 03/05/06.
- Retry repeats only pure synthesis and never repeats Luna or business side effects.

## ADR-016 — OpenRouter is the only P0 voice gateway

**Status:** accepted; Correction 004 authority.

Use one backend-only `OPENROUTER_API_KEY` for both voice paths. After `audio.commit`, the gateway/utterance assembler encodes bounded mono PCM16 into one validated WAV and passes it through atomic provider-neutral `SttPort`. The adapter validates/bounds the already-WAV request, base64-encodes unchanged bytes, and uses native Bun `fetch` to `/api/v1/chat/completions`; the configurable default model is `openai/gpt-audio-mini`. Return one final transcript.

Official evidence documents chat-completions audio input, base64, model-dependent formats and audio-input model filtering. It does not currently document a dedicated realtime STT WebSocket. Therefore browser PCM16 may remain chunked to the backend, while the active provider boundary is one atomic WAV request and one final transcript.

Consequences and guardrails:

- accept extra post-commit upload/inference latency and measure `audio.commit → final transcript` separately;
- bound utterance duration/bytes, WAV/base64 memory, timeouts and retry count;
- abort and suppress stale turns before they can invoke Luna/tools;
- map `400/401/402/404/413/429/5xx` to typed safe errors without key/audio/PII logs;
- default tests use a fake endpoint; paid Russian smoke is opt-in and must be reported only when observed;
- no second voice provider, credential, task path, diagram or source requirement is active.

## Metered voice cost inputs

![OpenRouter STT + OpenRouter TTS metered usage](../charts/02-openrouter-stt-tts-cost.png)

The chart deliberately contains no numeric currency estimate. Variable usage depends on measured OpenRouter STT audio usage and OpenRouter TTS input characters multiplied by the current account/model rates and units verified at deployment. The release owner records current pricing evidence and measured volumes; VPS, bandwidth and Codex subscription/credits are accounted separately.

## Capacity envelope Codex subscription

Для планирования:

```text
примерные sessions per rolling window
= available Luna local messages / average brain turns per session
```

При 8 brain turns на conversation даже широкий published range даёт сильно разную capacity. Поэтому:

- не обещать throughput до preflight/load test на конкретном аккаунте;
- записывать turns/session;
- иметь concurrency queue;
- в случае роста трафика включить API-key BrainPort или отдельный production billing path.

## Risk register

| ID | Риск | Вероятность | Влияние | Митигация |
|---|---|---:|---:|---|
| R-01 | subscription quota исчерпана | medium | high | capacity limit, metrics, API fallback interface |
| R-02 | auth refresh/re-login | medium | high | persistent CODEX_HOME, readiness, runbook |
| R-03 | app-server experimental tool drift | medium | high | pin version, generated schemas, envelope fallback |
| R-04 | phrase-level voice latency выше SLO | medium | high | bounded utterances, separate timing, low effort, shorter TTS phrases |
| R-05 | STT неверно распознаёт контакт | medium | high | targeted confirmation, validation |
| R-06 | LLM нарушает booking order | low/medium | high | backend state policy, tests |
| R-07 | duplicate booking on reconnect | medium without guard | high | unique constraint + idempotency |
| R-08 | marketing hallucination | medium | medium/high | allowed claims, evals, source attribution |
| R-09 | PII leak in logs | medium | high | redaction and log tests |
| R-10 | cheap VPS resource pressure | medium | medium | guardrails, metrics, bounded buffers |
| R-11 | OpenRouter STT/TTS model, voice, price or upstream availability changes | medium | medium/high | env profiles, opt-in external smokes, usage telemetry, bounds/circuit, safe degraded modes |
| R-12 | user thinks calendar event exists | medium | medium | explicit copy and payload semantics |

## Revisit triggers

Пересмотреть архитектуру, если:

- одновременно нужно больше одной VPS/реплики;
- Luna subscription становится bottleneck;
- median conversations требуют >12 brain turns;
- OpenRouter model/voice availability or paid rate changes materially;
- p95 latency стабильно >3 s;
- dynamic tools ломаются после upgrade;
- появляется реальная CRM/calendar integration;
- нужен multi-tenant data isolation.
