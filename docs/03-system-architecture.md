# 03. Системная архитектура

## 1. Решение верхнего уровня

![Системный контекст](../diagrams/01-system-context.svg)

Архитектура намеренно разделяет голос и интеллект:

- **xAI Streaming STT** — потоковая транскрибация;
- **Codex app-server + GPT-5.6 Luna** — текстовый reasoning, dialogue policy и tool decisions;
- **OpenRouter TTS** — backend-only paid synthesis через native Bun `fetch`;
- **Bun backend** — единственный владелец state, tools, credentials, TTS budgets и persistence.

Действующий pipeline: **xAI STT → Codex/Luna → speech sanitizer + phrase chunker → OpenRouter TTS → complete `audio/mpeg` phrase segments**. OpenRouter key никогда не передаётся browser-у.

Это отличается от end-to-end speech-to-speech: добавляется один orchestration layer, зато используется уже оплаченная Codex subscription и мозг можно заменить без переделки audio UI.

## 2. Контейнеры и компоненты

### React client

Ответственность:

- mic permission;
- AudioWorklet capture;
- resample browser audio до mono PCM16 16 kHz;
- отправка бинарных чанков около 100 ms;
- ordered playback queue для полных MP3 phrase segments;
- decode через Web Audio или `HTMLAudio`;
- barge-in: немедленно stop local playback и clear queue;
- rendering transcript/state/errors;
- reconnect с тем же `conversationId`, если сессия ещё жива.

Клиент не знает xAI, OpenRouter или Codex credentials и не вызывает providers напрямую.

### Bun API / WebSocket gateway

Ответственность:

- выдача conversation ID;
- аутентификация/лимиты публичной сессии;
- multiplex JSON events и binary audio;
- provider connection lifecycle;
- backpressure;
- orchestration turns;
- speech sanitizer + sentence chunker;
- запись событий и latency;
- cleanup при stop/disconnect.

### ConversationOrchestrator

Источник истины для:

- текущего stage;
- собранных slots;
- разрешённых actions;
- booking lifecycle;
- prompt context;
- retry/cancellation;
- post-booking qualification policy.

LLM предлагает действие, но backend валидирует, разрешено ли оно в текущем состоянии.

### CodexAppServerBrain

P0 transport — direct typed JSON-RPC к app-server. Универсальный AI SDK не используется в критическом пути; подробное сравнение находится в [`10-ai-library-evaluation.md`](10-ai-library-evaluation.md).

- запускает один долгоживущий `codex app-server` процесс;
- transport — JSONL over stdio через внутренний `BrainPort`;
- делает `initialize`/`initialized` один раз;
- создаёт отдельный `thread/start` на conversation;
- модель — `gpt-5.6-luna`;
- читает `item/agentMessage/delta`;
- обрабатывает `item/tool/call`, если включён experimental mode;
- отменяет turn через `turn/interrupt` при barge-in;
- генерирует/версионирует TS schema из установленной версии Codex;
- запускает thread с `cwd=/app/runtime-brain`, где prompt compiler создаёт только `AGENTS.md` и безопасные read-only knowledge-файлы;
- проверяет `instructionSources` из `thread/start`: ожидаемый `AGENTS.md` обязан быть загружен;
- не даёт модели доступ к рабочему репозиторию, `.env`, SQLite или общему filesystem.

### XaiSttAdapter

- server-side WSS к `wss://api.x.ai/v1/stt`;
- `sample_rate=16000`, `encoding=pcm`, `interim_results=true`, `language=ru`;
- Smart Turn начально `0.7`, timeout `3000 ms`, затем tuning по записям метрик;
- отправляет raw binary frames;
- эмитит partial, chunk-final и speech-final.

### OpenRouterTtsAdapter

- server-side native Bun `fetch` к `POST https://openrouter.ai/api/v1/audio/speech`;
- default profile: `x-ai/grok-voice-tts-1.0`, voice `eve`, `response_format=mp3`;
- model, voice, speed и format задаются env; `speed` не отправляется, если empty;
- `Authorization` и optional attribution headers остаются server-side; `X-OpenRouter-Cache: false` обязателен для user-specific speech;
- один HTTP request синтезирует одну короткую фразу; весь response буферизуется, проверяется как непустой bounded `audio/mpeg`, затем эмитится одним atomic segment;
- raw network chunks не считаются самостоятельно playable MP3;
- `AbortSignal` отменяет fetch, а generation filtering отбрасывает late result;
- `429` и retryable `5xx` получают не более одного bounded retry; `400/401/402/403/404/413` не ретраятся по умолчанию;
- `401`, `402` и `404` открывают safe degraded mode; text answer, booking и qualification продолжают работать;
- circuit breaker открывается после трёх consecutive retryable failures и half-opens после cooldown;
- per-segment/turn/session character budgets, concurrency и maximum response bytes ограничены;
- telemetry содержит model/voice/format/chars/status/latency/bytes и safe IDs, но не spoken text, PII, key или audio.

### BookingService

- валидирует contact minimum;
- создаёт/находит booking в одной транзакции;
- обновляет qualification patch;
- пишет event outbox;
- никогда не удаляет booking из-за incomplete qualification.

### Notifier

Интерфейс:

```ts
export interface LeadNotifier {
  publish(event: BookingCreatedEvent | BookingUpdatedEvent): Promise<void>;
}
```

P0 adapter — structured console JSON. P1 — signed HTTP webhook с retry/outbox.

## 3. Критический путь turn

![Turn sequence](../diagrams/02-turn-sequence.svg)

### Порядок

1. Browser отправляет 100 ms PCM chunks.
2. Backend relays в xAI STT.
3. На `speech_final=true` transcript становится user turn.
4. Orchestrator добавляет stage, known slots, booking status и краткий dialogue context.
5. Codex thread получает `turn/start`.
6. Text deltas проходят PII-safe sanitizer и bounded phrase chunker.
7. Законченная короткая фраза отправляется в OpenRouter; один request соответствует одному segment.
8. После проверки один полный `audio/mpeg` segment идёт в browser ordered playback queue.
9. Tool call исполняется транзакционно и результат возвращается brain независимо от audio path.
10. TTS retry повторяет только pure synthesis request и никогда не повторяет Luna turn, notifier или business tools.

## 4. Latency design

### Целевой budget

- end-of-turn decision: 300–700 ms;
- application overhead: < 50 ms p50;
- Luna first delta: target ≤ 900 ms;
- first phrase buffer: default target 100 chars, idle flush 350 ms;
- OpenRouter request + complete MP3 response: измеряется отдельно для release profile, без provider latency guarantee;
- total target: p50 ≤ 1.6 s, p95 ≤ 3.0 s, подтверждается target-VPS evidence.

### Приёмы снижения задержки

- не отправлять interim transcript в отдельный LLM turn;
- Luna effort `low`/минимально доступный после model capability check;
- короткий state context вместо полного event log;
- запускать phrase-level synthesis до завершения полного Luna ответа;
- первая фраза 60–120 chars, normal soft target 120–180, hard limit 240;
- держать не более одного playing и одного prefetched segment;
- исключить RAG/network tools из критического пути;
- не делать второй classifier call на каждый turn.

## 5. BrainPort

```ts
export type BrainToolMode = "dynamic" | "envelope";

export interface BrainTurnInput {
  conversationId: string;
  threadId?: string;
  userText: string;
  stage: ConversationStage;
  knownFacts: KnownFacts;
  booking: BookingSnapshot | null;
  allowedActions: BrainActionName[];
  promptVersion: string;
}

export interface BrainDelta {
  type: "speech.delta" | "tool.request" | "turn.completed" | "error";
  text?: string;
  tool?: { name: BrainActionName; callId: string; args: unknown };
  error?: { code: string; retryable: boolean; message: string };
}

export interface BrainPort {
  createThread(conversationId: string): Promise<string>;
  runTurn(input: BrainTurnInput, signal: AbortSignal): AsyncIterable<BrainDelta>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
```

## 6. Dynamic tools и fallback

### Mode A — `dynamic`

Codex app-server регистрирует динамические tools. Плюс — обычный streamed natural-language ответ и низкая задержка. Минус — API помечен experimental.

Server-side guard:

```ts
if (!policy.isAllowed(state, tool.name)) {
  return toolError("ACTION_NOT_ALLOWED_IN_STATE");
}
const args = ToolSchemas[tool.name].parse(tool.args);
return toolHandlers[tool.name](args);
```

### Mode B — `envelope`

Стабильный fallback с `outputSchema`:

```ts
type BrainEnvelope = {
  speech: string;
  nextStage: ConversationStage;
  action:
    | { type: "none" }
    | { type: "create_booking"; payload: CreateBookingInput }
    | { type: "append_booking_qualification"; payload: QualificationPatchInput };
};
```

В этом режиме TTS обычно стартует после получения валидного envelope, поэтому задержка выше. Feature flag позволяет не блокировать релиз, если dynamic tools изменятся.

## 7. Provider-neutral TtsPort

```ts
export type TtsSynthesisRequest = {
  conversationId: string;
  turnId: string;
  generationId: string;
  segmentId: string;
  text: string;
  signal: AbortSignal;
};

export type TtsAudioSegment = {
  generationId: string;
  segmentId: string;
  providerGenerationId?: string;
  contentType: "audio/mpeg";
  bytes: Uint8Array;
  final: true;
};

export interface TtsPort {
  synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment>;
  health(): Promise<"ready" | "degraded" | "unavailable">;
}
```

Shared packages не импортируют provider SDK types. Cancellation выполняется request `AbortSignal` плюс `generationId`; provider adapter не меняет public contract.

## 8. State machine

![Conversation state](../diagrams/03-conversation-state.svg)

Backend transition function должна быть чистой и покрытой table-driven tests:

```ts
transition(currentState, domainEvent) => nextState | TransitionError
```

LLM не может напрямую записать произвольный next state. Он предлагает intent/action, orchestrator применяет допустимый transition.

## 9. Barge-in

При детекции начала пользовательской речи во время `speaking`:

1. client немедленно очищает audio queue;
2. client посылает `playback.interrupted`;
3. backend помечает текущий response generation как superseded;
4. abort-ит in-flight OpenRouter requests этой generation;
5. вызывает `turn/interrupt`, если Codex turn ещё активен;
6. STT продолжает принимать речь;
7. поздние text и complete MP3 segments старой generation игнорируются по `generationId`.

Ключевой контракт: **устаревший complete audio segment никогда не проигрывается после нового user turn**. OpenRouter-specific cancellation contract не предполагается; cancellation локальна.

## 10. Предлагаемый repository layout

```text
/
  apps/
    web/
      src/audio/
      src/components/
      src/state/
    server/
      src/http/
      src/ws/
      src/orchestrator/
      src/providers/xai/stt/
      src/providers/openrouter/tts/
      src/providers/codex/
      src/domain/booking/
      src/notifiers/
      src/db/
  packages/
    contracts/
    prompt-compiler/
    test-fixtures/
  prompts/
    system.md
    product.md
    conversation-policy.md
    objections.md
    booking.md
    qualification.md
  knowledge/
    botamin-overview.md
    cases.md
    faq.md
    allowed-claims.md
  drizzle/
  infra/
    Caddyfile
  docs/
  docker-compose.yml
  Dockerfile
  bun.lock
  package.json
```

## 11. Основные env variables

`.env.example` is the exact active matrix; local defaults are reproduced here without secrets:

```dotenv
APP_ORIGIN=http://localhost:5173
DATABASE_URL=file:./data/app.db
LOG_LEVEL=info

BRAIN_PROVIDER=codex-subscription
CODEX_MODEL=gpt-5.6-luna
CODEX_EFFORT=low
CODEX_HOME=/home/your-user/.local/share/botamin-voice/codex-home
CODEX_TOOL_MODE=dynamic
CODEX_CWD=.runtime/brain
CODEX_MAX_CONCURRENT_TURNS=3

XAI_API_KEY=
XAI_STT_LANGUAGE=ru
XAI_STT_SMART_TURN=0.7
XAI_STT_SMART_TURN_TIMEOUT_MS=3000

TTS_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
OPENROUTER_TTS_SPEED=
OPENROUTER_HTTP_REFERER=http://localhost:5173
OPENROUTER_APP_TITLE=Botamin Voice Demo

TTS_FIRST_SEGMENT_TARGET_CHARS=100
TTS_SOFT_SEGMENT_CHARS=160
TTS_MAX_SEGMENT_CHARS=240
TTS_IDLE_FLUSH_MS=350
TTS_PREFETCH_SEGMENTS=1
TTS_MAX_CONCURRENCY=2
TTS_CONNECT_TIMEOUT_MS=8000
TTS_TOTAL_TIMEOUT_MS=20000
TTS_MAX_RETRIES=1
TTS_RETRY_BASE_MS=400
TTS_CIRCUIT_BREAKER_FAILURES=3
TTS_CIRCUIT_BREAKER_COOLDOWN_MS=60000
TTS_TEXT_ONLY_FALLBACK=true
TTS_MAX_CHARS_PER_SEGMENT=240
TTS_MAX_CHARS_PER_TURN=1800
TTS_MAX_CHARS_PER_SESSION=8000

POST_BOOKING_QUALIFICATION_ENABLED=true
NOTIFIER=console
WEBHOOK_URL=
WEBHOOK_SIGNING_SECRET=
TRANSCRIPT_RETENTION_DAYS=30
STORE_RAW_AUDIO=false
```

Значение concurrency — initial guardrail, а не окончательная capacity claim; оно настраивается после load test и проверки лимитов конкретной подписки. `CODEX_MODEL` и `CODEX_EFFORT` конфигурируемы, но любое изменение release-профиля требует полного conversation eval gate.
