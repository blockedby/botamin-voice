# 03. Системная архитектура

## 1. Решение верхнего уровня

![Системный контекст](../diagrams/01-system-context.svg)

Архитектура намеренно разделяет голос и интеллект:

- **OpenRouter phrase-level STT** — один audio-input chat completion для bounded WAV после конца реплики;
- **Codex app-server + GPT-5.6 Luna** — текстовый reasoning, dialogue policy и tool decisions;
- **OpenRouter TTS** — backend-only paid synthesis через native Bun `fetch`;
- **Bun gateway/utterance assembler** — единственный владелец utterance buffers, PCM16 bounds и PCM16-to-WAV encoding;
- **Bun backend** — владелец state, tools, credentials, voice budgets и persistence.

До этого pipeline существует отдельный pre-consent path: page entry делает одну `HTMLAudio` playback attempt committed same-origin `/assets/botamin-proactive-greeting.mp3`. Он не создаёт conversation, REST/WS, microphone, provider call или session; blocked/error переводит UI к `Включить приветствие`, а session start останавливает/release-ит audio.

Действующий post-consent pipeline: **browser PCM16 chunks → gateway/utterance assembler emits one validated STT WAV → atomic `audio/wav` SttPort → OpenRouter final transcript → Codex/Luna → two-request ordered TTS prefetch → complete provider-neutral MP3 or canonical WAV segments → gapless scheduled playback**. Один OpenRouter key остаётся только на backend и авторизует оба voice endpoint. The static proactive greeting MP3 and Sulafat canonical-WAV reactions не входят в provider runtime pipeline.

Это отличается от end-to-end speech-to-speech: добавляется один orchestration layer, зато используется уже оплаченная Codex subscription и мозг можно заменить без переделки audio UI.

## 2. Контейнеры и компоненты

### React client

Ответственность:

- ровно одна immediate entry attempt fixed same-origin proactive MP3 без session/network capabilities кроме same-origin asset fetch;
- truthful `Включить приветствие` fallback после autoplay block/media error и release greeting при session start;
- mic permission только после обоих consents;
- synchronous creation/resume output `AudioContext` in the consent gesture before mic/network awaits;
- AudioWorklet capture;
- resample browser audio до mono PCM16 16 kHz;
- отправка бинарных PCM16 чанков около 100 ms;
- явный end-of-turn `audio.commit`, 60-second ceiling и server-advertised PCM byte cap, производный от 2,000,000-byte WAV cap;
- circular countdown по принятым samples, а не wall clock, с effective duration по stricter duration/byte ceiling;
- secure `visitor.text.submit` for bounded final typed turns plus structured revisioned booking form commands only in server-owned `COLLECT_BOOKING`;
- UI states `listening → processing → transcript.final`;
- provider-neutral validation/rendering of complete MP3 or canonical 24 kHz mono PCM16 WAV segments;
- gapless Web Audio scheduling with current + prefetched decoded slots;
- explicitly negotiated v2 four-segment/20 MB/5 MB-per-segment credit window, at most two decoded/source slots, and release acknowledgment;
- negotiated allowlist over a 16-clip committed same-origin corpus; at most one eligible non-claiming decoration after 350 ms, cancelled by dynamic audio, mute, barge-in, or staleness. Claim-bearing progress clips remain unreachable without a future explicit trusted operation signal;
- mixed-version safety: a legacy-shaped JSON hello plus trusted same-origin `?voiceProtocol=2` offer/accept negotiation lets the new browser fall back against exact `origin/main`; an old browser is rejected by the new server before readiness or turn consumption rather than entering ACK-dependent flow;
- barge-in: немедленно stop local playback и clear queue;
- rendering transcript/state/errors;
- reconnect с тем же `conversationId`, если сессия ещё жива.

Клиент не знает OpenRouter или Codex credentials и не вызывает providers напрямую. До consent он также не вызывает conversation REST/WS и не запрашивает microphone; static asset delivery не является provider/session traffic.

### Bun API / WebSocket gateway

Ответственность:

- выдача conversation ID;
- аутентификация/лимиты публичной сессии;
- multiplex JSON events и binary audio;
- bounded utterance assembly до `audio.commit`, duration/byte guards и encoding bounded mono PCM16 into exactly one validated WAV;
- atomic provider request lifecycle, abort и stale-turn suppression;
- playback credit backpressure negotiated at four segments / 20 MB and replenished only by exact `playback.segment.released` acknowledgment;
- local-reaction capability negotiation and conservative stage/privacy selection with no provider call or business effect;
- orchestration turns;
- speech sanitizer + sentence chunker;
- запись событий и latency;
- cleanup при stop/disconnect.

### ConversationOrchestrator

Источник истины для:

- current stage and accepted visitor-turn origin (`voice_transcript` or `typed_message`);
- durable RC4 draft lifecycle in one `conversation_contexts` JSON row: revision, fact registry/provenance/conflicts, exactly two candidate identities, selection, readiness, confirmation/commit state and booking ID;
- server-owned Moscow date/day and bounded typed/spoken time-band, rejection, and concrete date/time interpretation;
- expected-revision CAS, idempotent form/conflict/confirmation commands, explicit conflict resolution, and candidate refresh/reselection;
- automatic internal booking commit only from a ready, exactly confirmed draft;
- direct missing-only qualification after durable booking confirmation;
- prompt context, retry/cancellation, and publication of browser-safe projections.

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

- server-side native Bun `fetch` к `POST https://openrouter.ai/api/v1/audio/speech`; default remains exact `xai_mp3` / `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`;
- opt-in Preview profile requires exact `gemini_3_1_pcm` / `google/gemini-3.1-flash-tts-preview` / one case-sensitive release-snapshot voice / `pcm`, with no speed, automatic choice, or xAI fallback;
- Gemini public catalog is dynamic; the exact 30-voice snapshot verified 2026-08-03 is recorded in [`../CURRENT_DECISIONS.md`](../CURRENT_DECISIONS.md) and configuration fails closed outside it;
- OpenRouter PCM is validated as complete PCM16LE and wrapped server-side into canonical complete mono 24 kHz PCM16LE `audio/wav`; browser never receives raw PCM;
- `TtsPort` carries plain sanitized text plus trusted low-cardinality delivery style `neutral|curious|serious|excited`. Gemini mapping is fixed server-side (`neutral` no tag, otherwise `[curious]`, `[serious]`, `[excited]`); bracket controls from text fail closed;
- contacts, exact meeting/date/time, booking/qualification, server-authority/fallback, and interrupted-turn content always use neutral. Style is presentation-only: visible transcript stays plain and durable state/provider selection do not change;
- one HTTP request synthesizes one short phrase; at most current + one prefetch are in flight, then complete segments publish strictly in source order;
- `Authorization` and attribution stay server-side; `X-OpenRouter-Cache: false`, bounds, abort/stale suppression, one pure-synthesis retry maximum, circuit breaker, budgets, and text-only degradation remain mandatory;
- telemetry contains safe aggregates only, never spoken text, style tags, PII, key, raw PCM/WAV/MP3, or provider body.

### BookingService

- generates exactly two deterministic internal 20-minute candidates with concrete Moscow dates/times after current Moscow date, weekdays only, on the 09:00–17:00 20-minute grid;
- without preference chooses one morning and one evening alternative;
- handles selected time bands/rejection and supported concrete date+time requests; concrete requests return exact permitted + alternative or the nearest two internal starts, while missing/ambiguous/out-of-policy requests fail closed;
- исключает уже committed internal start times без external calendar/availability API и никогда не представляет tuple как exhaustive/global availability;
- валидирует name, company, working email, phone or Telegram, consent и structured `Europe/Moscow` slot;
- повторно проверяет slot по текущему server clock и отклоняет stale/non-bookable или internally occupied start до side effect; active-candidate membership до вызова сервиса проверяет orchestrator/tool policy;
- создаёт/находит booking в одной `BEGIN IMMEDIATE` transaction;
- updates qualification patch only after durable meeting confirmation; missing-field selection and refusal gating belong to orchestrator policy;
- computes qualification truth from saved fields: zero+refusal=`skipped`, one=`partial`, both=`complete`; only a missing field is asked and booking remains `booked`;
- пишет event outbox;
- никогда не удаляет booking из-за incomplete qualification.

### ConversationContext / BookingDraftStore

Migration `0004_conversation_contexts.sql` adds exactly one compact table, not separate fact/evidence/meeting tables. Its PK/FK is `conversation_id` with cascade deletion; SQLite checks require a nonnegative row revision, valid object JSON, and matching draft/fact-registry revisions and `updatedAt`. Store mutations run in `BEGIN IMMEDIATE`, compare the expected revision in the update predicate, and use scoped idempotency keys for form, conflict-resolution, and confirmation commands. Provenance/evidence remains internal; browser events expose only required/status/value/conflict-option projections.

A confirmed current revision is the authorization boundary for automatic internal meeting commit. The durable booking remains the only meeting entity; `InternalVirtualMeetingProjection` is derived from it for `session.ready` / `internal.meeting.updated` and explicitly carries both external flags as false.

### Notifier

Интерфейс:

```ts
export interface LeadNotifier {
  publish(event: BookingCreatedEvent | BookingUpdatedEvent): Promise<void>;
}
```

P0 adapter — fixed-schema non-PII console acknowledgment. P1 — signed HTTP webhook с полным lead payload и retry/outbox.

## 3. Критический путь turn

![Turn sequence](../diagrams/02-turn-sequence.svg)

### Pre-session entry

1. Browser монтирует greeting controller и немедленно ровно один раз вызывает playback фиксированного same-origin MP3.
2. Autoplay block или media error не запускает alternate network/provider path: UI показывает `Включить приветствие`, и повтор возможен только по user action.
3. До обоих consents не создаются conversation/WS/microphone/provider/session. При старте настоящей session greeting немедленно pause/reset/release.

Assets создаются отдельно от visitor runtime. Admin explicitly opts in to the paid proactive-greeting or local-reaction generator; the 16 Sulafat canonical mono PCM16LE 24 kHz reaction WAVs and proactive greeting MP3 are already committed static same-origin assets. Reaction regeneration additionally requires the exact Gemini PCM/Sulafat production profile. They contain no visitor data, and ordinary entry/turn handling never synthesizes them.

### Post-consent turn order

1. Browser отправляет примерно 100 ms PCM16 chunks; gateway/utterance assembler собирает их в bounded utterance.
2. End-of-turn / `audio.commit` закрывает реплику. Gateway/utterance assembler проверяет duration/bytes, создаёт и валидирует ровно один mono PCM16 WAV.
3. Gateway передаёт WAV атомарному `SttPort`; OpenRouter STT adapter повторно валидирует/bounds already-WAV request, base64-кодирует его и отправляет один `input_audio` chat completion.
4. Only a valid current final transcript becomes a user turn. Monotonic `visitor.text.submit` creates the same accepted final-turn path without STT.
5. Orchestrator parses typed/spoken input identically, extracts quoted fact proposals, and merges them into the revisioned durable draft; conflicting values become bounded explicit options rather than overwrite.
6. Structured form commands patch the same draft at `baseRevision`; exact-revision confirmation automatically commits the booking through `uncommitted → committing → committed`.
7. Before readiness and then periodically, a bounded DB-only sweeper recovers orphaned `committing` drafts idempotently without Luna/STT/TTS or an in-memory session; confirmation and qualification remain pending for the visitor reconnect.
8. Text deltas pass the sanitizer. Contacts are redacted unless they exactly match server-approved contacts and contact-processing consent is active.
9. Complete bounded phrases enter a two-request TTS window; settlement is reordered to source order before provider-neutral complete MP3/WAV WS segments.
10. Browser uses a four-segment/20 MB credit window, decodes at most two segments, schedules the next at the preceding end time, and returns credit only after release.
11. If negotiated and policy-safe, server may request one allowlisted same-origin reaction after 350 ms. It is cancelled by dynamic audio/staleness and has no transcript, state, provider, tool, or booking effect.
12. Only a durable booking publishes `internal.meeting.updated`; the final widget cannot be synthesized from transcript/stage alone.
13. After truthful meeting confirmation, server qualification asks only missing facts. Provider retries never repeat Luna, notifier, draft mutation, or booking effects.

## 4. Latency design

### Целевой budget

- end-of-turn decision and `audio.commit`: browser/backend measurement point;
- gateway WAV encoding/validation и adapter base64/application overhead измеряются отдельно и имеют независимые bounds;
- OpenRouter phrase-level STT request to final transcript: measured release-profile input, no provider latency guarantee;
- Luna first delta after final transcript: target ≤ 900 ms;
- first phrase buffer: default target 100 chars, idle flush 350 ms;
- OpenRouter request + complete MP3 or canonical WAV response: измеряется отдельно для release profile, без provider latency guarantee;
- total target is re-baselined from measured `audio.commit → final transcript → playback`; phrase-level STT necessarily adds post-commit upload/inference latency.

### Приёмы снижения задержки

- показывать client listening/processing state и только atomic `transcript.final`;
- Luna effort `low`/минимально доступный после model capability check;
- короткий state context вместо полного event log;
- требовать concise natural spoken form (обычно ≤2 коротких предложений, одна мысль, ≤1 вопрос);
- запускать current + one ordered prefetched synthesis до завершения полного Luna ответа;
- первая фраза 60–120 chars, normal soft target 120–180, hard limit 240;
- schedule decoded current/prefetch by Web Audio end times; retain at most four/20 MB with at most two decoded;
- исключить RAG/network tools из критического пути;
- не делать второй classifier call на каждый turn.

## 5. BrainPort

```ts
export type BrainToolMode = "dynamic" | "envelope";

export interface BrainTurnInput {
  conversationId: string;
  threadId?: string;
  turnId: string;
  generationId: string;
  userText: string;
  stage: ConversationStage;
  knownFacts: KnownFacts;
  booking: BookingSnapshot | null;
  schedulingContext: {
    currentInstant: string;
    moscowLocalDate: string;
    moscowWeekday: string;
    timeOfDayPreference: "none" | "morning" | "daytime" | "second_half" | "evening";
    rejectedTimeOfDayPreferences: Array<"morning" | "daytime" | "second_half" | "evening">; // max 1
    candidateMeetingSlots: [
      { meetingSlot: MeetingSlot; displayLabel: string },
      { meetingSlot: MeetingSlot; displayLabel: string }
    ];
  };
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
  deliveryStyle?: "neutral" | "curious" | "serious" | "excited";
  signal: AbortSignal;
};

export type TtsAudioSegment = {
  generationId: string;
  segmentId: string;
  providerGenerationId?: string;
  contentType: "audio/mpeg" | "audio/wav";
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

LLM cannot directly write state or durable facts. It may propose quoted current-turn facts; the server validates origin, quote, schema, expected revision, conflicts, and transitions. Typed composer/form visibility comes only from server stage. Browser draft projection strips provenance/evidence, and the final meeting widget comes only from a server-derived durable booking projection.

## 10. Barge-in

При детекции начала пользовательской речи во время `speaking`:

1. client немедленно очищает audio queue;
2. client посылает `playback.interrupted`;
3. backend помечает текущий response generation как superseded;
4. abort-ит in-flight OpenRouter requests этой generation;
5. вызывает `turn/interrupt`, если Codex turn ещё активен;
6. gateway продолжает принимать новые browser PCM16 chunks в новый bounded utterance;
7. поздние STT results, text, complete MP3/WAV segments и reactions старого turn/generation игнорируются.

Ключевой контракт: **устаревший complete MP3/WAV segment или reaction никогда не проигрывается после нового user turn**. OpenRouter-specific cancellation contract не предполагается; cancellation локальна.

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
AUTO_MIGRATE=true
DATABASE_URL=file:./data/app.db
LOG_LEVEL=info
MAX_ACTIVE_CONVERSATIONS=3
MAX_ACTIVE_CONVERSATIONS_PER_SOURCE=2
MAX_CONCURRENT_BRAIN_TURNS=3
MAX_PENDING_BRAIN_TURNS=6
BRAIN_QUEUE_TIMEOUT_MS=45000
SESSION_MAX_MINUTES=20
SESSION_STOP_DRAIN_MS=5000
TURN_TIMEOUT_MS=45000
TRUSTED_PROXY_HOPS=0
ADMISSION_WINDOW_MS=60000
MAX_CONVERSATION_CREATES_PER_SOURCE=5
MAX_SESSION_CONNECTIONS_PER_SOURCE=20
CLIENT_HELLO_TIMEOUT_MS=2000
ABANDONED_SESSION_TIMEOUT_MS=10000

# Codex subscription brain
# Authentication is performed separately with `codex login --device-auth`.
# Keep CODEX_HOME outside this source repository and use an absolute path.
BRAIN_PROVIDER=codex-subscription
CODEX_MODEL=gpt-5.6-luna
# Missing defaults to low; any non-low value fails before Codex starts.
CODEX_EFFORT=low
# Empty is portable standard service; exact priority opts into Fast routing.
CODEX_SERVICE_TIER=
CODEX_HOME=/home/your-user/.local/share/botamin-voice/codex-home
# Production runtime is fixed to the server-validated envelope mode.
CODEX_TOOL_MODE=envelope
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
STT_MAX_UTTERANCE_MS=60000
STT_MAX_AUDIO_BYTES=2000000
STT_TEXT_ONLY_INPUT_FALLBACK=false

# OpenRouter paid usage; this one key authorizes STT and TTS and never reaches the browser
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# TTS — exact xAI complete MP3 profile by default
TTS_PROVIDER=openrouter
OPENROUTER_TTS_PROFILE=xai_mp3
OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
# Optional for xAI; omit from request if empty
OPENROUTER_TTS_SPEED=

# Paid opt-in Gemini Preview: change all four values together; speed must be empty.
# Voice is case-sensitive and must be in the 30-voice release snapshot.
# OPENROUTER_TTS_PROFILE=gemini_3_1_pcm
# OPENROUTER_TTS_MODEL=google/gemini-3.1-flash-tts-preview
# OPENROUTER_TTS_VOICE=Kore
# OPENROUTER_TTS_RESPONSE_FORMAT=pcm

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
ORPHAN_RECOVERY_BATCH_SIZE=25
ORPHAN_RECOVERY_MAX_PER_SWEEP=100
ORPHAN_RECOVERY_INTERVAL_MS=60000

# Notifications: console safely acknowledges and discards the lead payload
NOTIFIER=console
WEBHOOK_URL=
WEBHOOK_SIGNING_SECRET=
WEBHOOK_TIMEOUT_MS=5000

# Privacy and retention
TRANSCRIPT_RETENTION_DAYS=30
STORE_RAW_AUDIO=false
```

Значение concurrency — initial guardrail, а не окончательная capacity claim; оно настраивается после load test и проверки лимитов конкретной подписки. `MAX_PENDING_BRAIN_TURNS` ограничивает сохранённые в памяти committed WAV; booked sessions имеют отдельную приоритетную FIFO-очередь, а внутри каждой очереди сохраняется порядок поступления. `TRUSTED_PROXY_HOPS=0` безопасно игнорирует forwarding headers для прямого Bun-запуска; Compose явно задаёт `1`, потому что app доступен только через Caddy. Production-профиль фиксирует `CODEX_MODEL=gpt-5.6-luna` и минимально поддерживаемый Luna effort `low`: доступные effort — `low|medium|high|xhigh|max`, поэтому reasoning нельзя выключить через `off`/`minimal`. Опциональный `CODEX_SERVICE_TIER=priority` включает advertised Fast tier (1.5x speed) ценой повышенного subscription usage; пустое значение оставляет portable standard service. Это не latency SLA. Любое изменение release-профиля требует полного conversation eval gate.
