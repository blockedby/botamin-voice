# 03. Системная архитектура

## 1. Решение верхнего уровня

![Системный контекст](../diagrams/01-system-context.svg)

Архитектура намеренно разделяет голос и интеллект:

- **OpenRouter phrase-level STT** — один audio-input chat completion для bounded WAV после конца реплики;
- **Codex app-server + GPT-5.6 Luna** — текстовый reasoning, dialogue policy и tool decisions;
- **OpenRouter TTS** — backend-only paid synthesis через native Bun `fetch`;
- **Bun gateway/utterance assembler** — единственный владелец utterance buffers, PCM16 bounds и PCM16-to-WAV encoding;
- **Bun backend** — владелец state, tools, credentials, voice budgets и persistence.

Действующий pipeline: **browser PCM16 chunks → gateway/utterance assembler bounds mono PCM16 and emits one validated WAV → atomic `audio/wav` SttPort request → OpenRouter audio-input chat completion final transcript → Codex/Luna → OpenRouter TTS complete MP3 segment**. Один OpenRouter key остаётся только на backend и авторизует оба voice endpoint.

Это отличается от end-to-end speech-to-speech: добавляется один orchestration layer, зато используется уже оплаченная Codex subscription и мозг можно заменить без переделки audio UI.

## 2. Контейнеры и компоненты

### React client

Ответственность:

- mic permission;
- AudioWorklet capture;
- resample browser audio до mono PCM16 16 kHz;
- отправка бинарных PCM16 чанков около 100 ms;
- явный end-of-turn `audio.commit` и bounded local buffer;
- UI states `listening → processing → transcript.final`;
- ordered playback queue для полных MP3 phrase segments;
- decode через Web Audio или `HTMLAudio`;
- barge-in: немедленно stop local playback и clear queue;
- rendering transcript/state/errors;
- reconnect с тем же `conversationId`, если сессия ещё жива.

Клиент не знает OpenRouter или Codex credentials и не вызывает providers напрямую.

### Bun API / WebSocket gateway

Ответственность:

- выдача conversation ID;
- аутентификация/лимиты публичной сессии;
- multiplex JSON events и binary audio;
- bounded utterance assembly до `audio.commit`, duration/byte guards и encoding bounded mono PCM16 into exactly one validated WAV;
- atomic provider request lifecycle, abort и stale-turn suppression;
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

### OpenRouterSttAdapter

- server-side native Bun `fetch` к `POST https://openrouter.ai/api/v1/chat/completions`;
- принимает через atomic `SttPort` одну уже закодированную и проверенную gateway 16 kHz mono PCM16 WAV реплику с `contentType: "audio/wav"`;
- повторно валидирует WAV container/format и request duration/byte bounds, отклоняя raw PCM, malformed WAV и mismatched content type;
- base64-кодирует неизменённые WAV bytes и отправляет content part `{"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}`; adapter не добавляет WAV header и не конвертирует PCM;
- default model `openai/gpt-audio-mini`; model, `wav` format и `ru` language задаются env, а audio-input capability проверяется smoke/discovery evidence;
- возвращает один atomic final transcript;
- current official evidence documents chat completions audio input, not a dedicated realtime STT WebSocket; поэтому adapter нельзя называть provider-streaming STT;
- `AbortSignal` и turn identity подавляют aborted/stale result; `400/401/402/404/413` не ретраятся, `429`/retryable `5xx` получают не более одного bounded retry;
- STT retry повторяет только transcription fetch и никогда не запускает Luna, tools или notifier;
- telemetry содержит model/format/status/latency/duration/bytes/retry и safe IDs, но не key, WAV/base64, transcript text или PII.

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

1. Browser отправляет примерно 100 ms PCM16 chunks; gateway/utterance assembler собирает их в bounded utterance.
2. End-of-turn / `audio.commit` закрывает реплику. Gateway/utterance assembler проверяет duration/bytes, создаёт и валидирует ровно один mono PCM16 WAV.
3. Gateway передаёт WAV атомарному `SttPort`; OpenRouter STT adapter повторно валидирует/bounds already-WAV request, base64-кодирует его и отправляет один `input_audio` chat completion.
4. Только валидный неустаревший final transcript становится user turn и публикуется как `transcript.final`.
5. Orchestrator добавляет stage, known slots, booking status и краткий dialogue context; Codex thread получает `turn/start` ровно один раз.
6. Text deltas проходят PII-safe sanitizer и bounded phrase chunker.
7. Законченная короткая фраза отправляется в OpenRouter TTS; один request соответствует одному segment.
8. После проверки один полный `audio/mpeg` segment идёт в browser ordered playback queue.
9. Tool call исполняется транзакционно и результат возвращается brain независимо от audio path.
10. Voice retries повторяют только соответствующий pure provider request и никогда не повторяют Luna turn, notifier или business tools.

## 4. Latency design

### Целевой budget

- end-of-turn decision and `audio.commit`: browser/backend measurement point;
- gateway WAV encoding/validation и adapter base64/application overhead измеряются отдельно и имеют независимые bounds;
- OpenRouter phrase-level STT request to final transcript: measured release-profile input, no provider latency guarantee;
- Luna first delta after final transcript: target ≤ 900 ms;
- first phrase buffer: default target 100 chars, idle flush 350 ms;
- OpenRouter request + complete MP3 response: измеряется отдельно для release profile, без provider latency guarantee;
- total target is re-baselined from measured `audio.commit → final transcript → playback`; phrase-level STT necessarily adds post-commit upload/inference latency.

### Приёмы снижения задержки

- показывать client listening/processing state и только atomic `transcript.final`;
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

## 6. Provider-neutral SttPort

```ts
export type SttTranscriptionRequest = {
  conversationId: string;
  turnId: string;
  audio: Uint8Array;
  contentType: "audio/wav";
  language: string;
  signal: AbortSignal;
};

export type SttTranscriptionResult = {
  conversationId: string;
  turnId: string;
  text: string;
  final: true;
};

export interface SttPort {
  transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>;
  health(): Promise<"ready" | "degraded" | "unavailable">;
}
```

`SttPort` содержит только atomic `transcribe`/`health` operations и provider-neutral request/result types. Chunked PCM16 остаётся отдельным browser-to-backend WS transport; gateway/utterance assembler создаёт один validated WAV request только после `audio.commit`, а adapter принимает только already-WAV bytes.

## 7. Dynamic tools и fallback

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

## 8. Provider-neutral TtsPort

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

## 9. State machine

![Conversation state](../diagrams/03-conversation-state.svg)

Backend transition function должна быть чистой и покрытой table-driven tests:

```ts
transition(currentState, domainEvent) => nextState | TransitionError
```

LLM не может напрямую записать произвольный next state. Он предлагает intent/action, orchestrator применяет допустимый transition.

## 10. Barge-in

При детекции начала пользовательской речи во время `speaking`:

1. client немедленно очищает audio queue;
2. client посылает `playback.interrupted`;
3. backend помечает текущий response generation как superseded;
4. abort-ит in-flight OpenRouter requests этой generation;
5. вызывает `turn/interrupt`, если Codex turn ещё активен;
6. gateway продолжает принимать новые browser PCM16 chunks в новый bounded utterance;
7. поздние STT results, text и complete MP3 segments старого turn/generation игнорируются.

Ключевой контракт: **устаревший complete audio segment никогда не проигрывается после нового user turn**. OpenRouter-specific cancellation contract не предполагается; cancellation локальна.

## 11. Предлагаемый repository layout

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
      src/providers/openrouter/stt/
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

## 12. Основные env variables

`.env.example` is the exact active matrix; local defaults are reproduced here without secrets:

```dotenv
# Botamin local development environment
# Copy this file to .env and fill only the secret values marked REQUIRED.
# Never commit .env or Codex authentication files.

# Local application
APP_ORIGIN=http://localhost:5173
DATABASE_URL=file:./data/app.db
LOG_LEVEL=info

# Codex subscription brain
# Authentication is performed separately with `codex login --device-auth`.
# Keep CODEX_HOME outside this source repository and use an absolute path.
BRAIN_PROVIDER=codex-subscription
CODEX_MODEL=gpt-5.6-luna
CODEX_EFFORT=low
CODEX_HOME=/home/your-user/.local/share/botamin-voice/codex-home
CODEX_TOOL_MODE=dynamic
CODEX_CWD=.runtime/brain
CODEX_MAX_CONCURRENT_TURNS=3

# OpenRouter phrase-level STT — backend-only key authorizes STT and TTS
STT_PROVIDER=openrouter
OPENROUTER_STT_MODEL=openai/gpt-audio-mini
OPENROUTER_STT_AUDIO_FORMAT=wav
OPENROUTER_STT_LANGUAGE=ru
STT_CONNECT_TIMEOUT_MS=8000
STT_TOTAL_TIMEOUT_MS=30000
STT_MAX_RETRIES=1
STT_RETRY_BASE_MS=400
STT_MAX_UTTERANCE_MS=30000
STT_MAX_AUDIO_BYTES=1000000
STT_TEXT_ONLY_INPUT_FALLBACK=false

# OpenRouter paid usage; this one key authorizes STT and TTS and never reaches the browser
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# TTS — complete MP3 phrase segments
TTS_PROVIDER=openrouter

OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
# Optional; omit from request if empty
OPENROUTER_TTS_SPEED=

# Optional app attribution; localhost is safe for local development
OPENROUTER_HTTP_REFERER=http://localhost:5173
OPENROUTER_APP_TITLE=Botamin Voice Demo

# Segmentation and queueing
TTS_FIRST_SEGMENT_TARGET_CHARS=100
TTS_SOFT_SEGMENT_CHARS=160
TTS_MAX_SEGMENT_CHARS=240
TTS_IDLE_FLUSH_MS=350
TTS_PREFETCH_SEGMENTS=1
TTS_MAX_CONCURRENCY=2

# Network and degradation
TTS_CONNECT_TIMEOUT_MS=8000
TTS_TOTAL_TIMEOUT_MS=20000
TTS_MAX_RETRIES=1
TTS_RETRY_BASE_MS=400
TTS_CIRCUIT_BREAKER_FAILURES=3
TTS_CIRCUIT_BREAKER_COOLDOWN_MS=60000
TTS_TEXT_ONLY_FALLBACK=true

# Demo budget guards
TTS_MAX_CHARS_PER_SEGMENT=240
TTS_MAX_CHARS_PER_TURN=1800
TTS_MAX_CHARS_PER_SESSION=8000

# Booking and qualification
POST_BOOKING_QUALIFICATION_ENABLED=true

# Notifications: console is sufficient for local development
NOTIFIER=console
WEBHOOK_URL=
WEBHOOK_SIGNING_SECRET=

# Privacy and retention
TRANSCRIPT_RETENTION_DAYS=30
STORE_RAW_AUDIO=false
```

Значение concurrency — initial guardrail, а не окончательная capacity claim; оно настраивается после load test и проверки лимитов конкретной подписки. `CODEX_MODEL` и `CODEX_EFFORT` конфигурируемы, но любое изменение release-профиля требует полного conversation eval gate.
