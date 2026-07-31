# 03. Системная архитектура

## 1. Решение верхнего уровня

![Системный контекст](../diagrams/01-system-context.svg)

Архитектура намеренно разделяет голос и интеллект:

- **xAI STT** — потоковая транскрибация;
- **Codex app-server + GPT-5.6 Luna** — текстовый reasoning, dialogue policy и tool decisions;
- **xAI TTS** — потоковая озвучка;
- **Bun backend** — единственный владелец state, tools, credentials и persistence.

Это отличается от end-to-end speech-to-speech: добавляется один orchestration layer, зато используется уже оплаченная Codex subscription и мозг можно заменить без переделки audio UI.

## 2. Контейнеры и компоненты

### React client

Ответственность:

- mic permission;
- AudioWorklet capture;
- resample browser audio до mono PCM16 16 kHz;
- отправка бинарных чанков около 100 ms;
- playback queue для PCM TTS;
- barge-in: stop local playback сразу;
- rendering transcript/state/errors;
- reconnect с тем же `conversationId`, если сессия ещё жива.

Клиент не знает xAI/OpenAI ключи и не вызывает providers напрямую.

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

### XaiTtsAdapter

- server-side WSS к `wss://api.x.ai/v1/tts`;
- `language=ru`, configurable voice; initial candidates: `iris`, then `eve` fallback;
- `codec=pcm`, `sample_rate=24000`, streaming latency optimization;
- получает `text.delta`, возвращает base64 `audio.delta`;
- держит persistent connection на conversation или небольшой pool;
- умеет cancel/drop текущего utterance.

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
6. Text deltas проходят sanitizer и sentence chunker.
7. Законченная короткая фраза немедленно отправляется в xAI TTS.
8. PCM chunks идут в browser playback queue.
9. Tool call исполняется транзакционно и результат возвращается brain.

## 4. Latency design

### Целевой budget

- end-of-turn decision: 300–700 ms;
- application overhead: < 50 ms p50;
- Luna first delta: target ≤ 900 ms;
- sentence buffer: 100–250 ms;
- TTS first audio: target ≤ 300 ms;
- total target: p50 ≤ 1.6 s, p95 ≤ 3.0 s.

### Приёмы снижения задержки

- не отправлять interim transcript в отдельный LLM turn;
- Luna effort `low`/минимально доступный после model capability check;
- короткий state context вместо полного event log;
- stream TTS по завершённым фразам, а не ждать полного ответа;
- заранее синтезировать статическое первое приветствие опционально;
- переиспользовать xAI TTS WSS;
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

## 7. State machine

![Conversation state](../diagrams/03-conversation-state.svg)

Backend transition function должна быть чистой и покрытой table-driven tests:

```ts
transition(currentState, domainEvent) => nextState | TransitionError
```

LLM не может напрямую записать произвольный next state. Он предлагает intent/action, orchestrator применяет допустимый transition.

## 8. Barge-in

При детекции начала пользовательской речи во время `speaking`:

1. client немедленно очищает audio queue;
2. client посылает `playback.interrupted`;
3. backend помечает текущий response generation как superseded;
4. закрывает/сбрасывает текущий TTS utterance;
5. вызывает `turn/interrupt`, если Codex turn ещё активен;
6. STT продолжает принимать речь;
7. поздние deltas старого generation игнорируются по `generationId`.

Ключевой контракт: **устаревший audio chunk никогда не проигрывается после нового user turn**.

## 9. Предлагаемый repository layout

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
      src/providers/xai/
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

## 10. Основные env variables

```dotenv
APP_ORIGIN=https://example.com
DATABASE_URL=file:/data/app.db
LOG_LEVEL=info

BRAIN_PROVIDER=codex-subscription
CODEX_MODEL=gpt-5.6-luna
CODEX_EFFORT=low
CODEX_HOME=/codex-home
CODEX_TOOL_MODE=dynamic
CODEX_CWD=/app/runtime-brain
CODEX_MAX_CONCURRENT_TURNS=3

XAI_API_KEY=...
XAI_STT_LANGUAGE=ru
XAI_STT_SMART_TURN=0.7
XAI_STT_SMART_TURN_TIMEOUT_MS=3000
XAI_TTS_LANGUAGE=ru
XAI_TTS_VOICE=iris
XAI_TTS_SAMPLE_RATE=24000

POST_BOOKING_QUALIFICATION_ENABLED=true
NOTIFIER=console
WEBHOOK_URL=
WEBHOOK_SIGNING_SECRET=
TRANSCRIPT_RETENTION_DAYS=30
STORE_RAW_AUDIO=false
```

Значение concurrency — initial guardrail, а не окончательная capacity claim; оно настраивается после load test и проверки лимитов конкретной подписки. `CODEX_MODEL` и `CODEX_EFFORT` конфигурируемы, но любое изменение release-профиля требует полного conversation eval gate.
