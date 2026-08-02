# 05. API, события и модель данных

## 1. Общие правила контрактов

- Все JSON payloads валидируются Zod на границе.
- Все timestamps — RFC 3339 UTC.
- Все IDs — UUIDv7 или ULID; внешний формат не должен содержать PII.
- Все события содержат `conversationId`, а booking events также `bookingId`.
- Версия контракта передаётся как `v: 1`.
- Ошибки providers не пробрасываются клиенту напрямую.
- Binary WebSocket frames несут client PCM16 input или один полный server MP3 phrase payload; arbitrary provider network chunks никогда не публикуются как playable audio.
- Tool handlers не доступны как публичные HTTP endpoints.
- Proactive greeting не является API/session contract: page entry делает один same-origin GET/playback static MP3, без conversation REST/WS/mic/provider/session до обоих consents. Blocked/error fallback — `Включить приветствие`; session start прекращает static playback.
- Committed proactive MP3 содержит только fixed product copy без visitor data. Его может заменить только explicit admin opt-in OpenRouter generation script; visitor runtime его не синтезирует.

## 2. REST endpoints

### `POST /api/v1/conversations`

Создать сессию. Browser не вызывает endpoint, пока `voiceProcessing` и `contactProcessing` не подтверждены; proactive static greeting не создаёт conversation.

Request:

```json
{
  "source": "landing",
  "locale": "ru-RU",
  "qualificationEnabled": true,
  "consent": {
    "voiceProcessing": true,
    "contactProcessing": true
  }
}
```

Response `201`:

```json
{
  "conversationId": "01J...",
  "wsUrl": "/ws/v1/conversations/01J...",
  "clientToken": "opaque-one-use-client-token-32-bytes",
  "expiresAt": "2026-07-30T21:30:00Z",
  "clientConfig": {
    "inputSampleRate": 16000,
    "inputEncoding": "pcm16le",
    "chunkMs": 100,
    "maxUtteranceMs": 60000,
    "maxPcmBytes": 1920000,
    "outputContentType": "audio/mpeg",
    "outputMode": "complete-phrase-segments"
  }
}
```

Errors: `CONSENT_REQUIRED`, `CAPACITY_EXCEEDED`, `BRAIN_NOT_READY`. Application JSON over 8192 bytes returns the same structured error envelope with HTTP `413`; Bun's transport hard cap is deliberately higher so this contract is not replaced by an unstructured runtime response. Per-source create admission returns structured HTTP `429`.

### `POST /api/v1/conversations/:id/stop`

Идемпотентно завершает сессию. Основной stop идёт по WS; endpoint нужен для unload/fallback.

### `GET /health/live`

Процесс жив. Не проверяет providers.

### `GET /health/ready`

Проверяет:

- DB write/read;
- Codex app-server handshake;
- наличие auth и модели Luna в `model/list`;
- ровно один `OPENROUTER_API_KEY` для обоих voice paths;
- при `STT_PROVIDER=openrouter`: schema-valid audio-input model/`wav`/language, utterance byte/time limits и request timeout/retry limits; readiness не утверждает наличие provider streaming session;
- при `TTS_PROVIDER=openrouter`: schema-valid model/voice/`mp3`, доступность queue/circuit state и разрешённый text-only output startup policy;
- prompt bundle checksum;
- запущенный persisted notification-outbox worker (provider delivery failure itself remains retryable and does not make booking uncommitted);
- возможность принять новую conversation по active/queued concurrency guards.

### Dev-only

`GET /api/dev/conversations/:id` — transcript/events для локальной отладки. Endpoint отсутствует в production build или защищён отдельным token.

## 3. WebSocket protocol

### Handshake

Клиент подключается к `/ws/v1/conversations/:conversationId` и первым JSON frame отправляет:

```json
{
  "v": 1,
  "type": "client.hello",
  "payload": {
    "resumeToken": "opaque-one-use-client-token-32-bytes",
    "audio": {
      "encoding": "pcm16le",
      "sampleRate": 16000,
      "channels": 1,
      "chunkMs": 100
    }
  }
}
```

Server:

```json
{
  "v": 1,
  "type": "session.ready",
  "conversationId": "01J...",
  "seq": 1,
  "at": "2026-07-30T20:17:00.000Z",
  "payload": {
    "state": "GREETING",
    "resumeToken": "opaque-short-lived-token",
    "clientConfig": {
      "inputSampleRate": 16000,
      "inputEncoding": "pcm16le",
      "chunkMs": 100,
      "maxUtteranceMs": 60000,
      "maxPcmBytes": 1920000,
      "outputContentType": "audio/mpeg",
      "outputMode": "complete-phrase-segments"
    }
  }
}
```

### Client → server JSON events

| Event | Payload | Назначение |
|---|---|---|
| `client.hello` | audio config, resume token | handshake |
| `audio.commit` | `{}` | закрыть bounded utterance и создать ровно один atomic final-transcription request |
| `visitor.text.submit` | `{ sequence, text }` | отправить одну final typed turn до 2,000 chars без provider/tool fields |
| `playback.started` | `generationId` | метрика |
| `playback.interrupted` | `generationId`, reason | barge-in |
| `session.stop` | reason | корректное завершение |
| `client.ping` | timestamp | keepalive |

Первый `client.hello` обязан предъявить одноразовый `clientToken` из REST response; `session.ready` сразу заменяет его новым resume token. На session допускается один pending hello-кандидат с коротким deadline и один bound socket. Reconnect заменяет bound socket только после полной проверки hello/token; неподтверждённый кандидат его не вытесняет.

После handshake PCM16 audio идёт binary frames без base64. Gateway/utterance assembler ограничивает accumulated input максимумом 60,000 ms и так, чтобы atomic WAV не превысил 2,000,000 bytes; при 16 kHz mono PCM16 default duration ceiling строже и даёт `maxPcmBytes=1,920,000`. После `audio.commit` gateway кодирует ровно один validated WAV и передаёт его atomic `SttPort`; только OpenRouter adapter выполняет base64 encoding уже готовых WAV bytes. Browser chunks не означают streaming transport до provider.

`visitor.text.submit` — secure provider-neutral alternative input, а не tool endpoint. Payload strict: trimmed non-empty `text` до 2,000 символов и monotonic nonnegative `sequence`. Typed submit supersedes/clears uncommitted microphone bytes, запрещён при pending/active turn или terminal stage, и считается принятым только когда server эмитит соответствующий `transcript.final`. Duplicate/stale sequence получает idempotency conflict; gap — invalid event; recoverable rejection позволяет повторить тот же sequence. После acceptance typed и spoken text проходят идентичные Luna context, stage policy, domain tools, persistence, assistant text и optional TTS.

### Server → client events

| Event | Payload |
|---|---|
| `session.ready` | state/config |
| `state.changed` | from/to/reason; voice UI uses listening/processing states |
| `transcript.final` | turnId/text; единственное STT text event после atomic provider result |
| `assistant.text.delta` | generationId/text |
| `assistant.text.done` | generationId/fullText |
| `audio.segment` | generationId, segmentId, sequence, `contentType=audio/mpeg`, byteLength, `final=true`; immediately followed by one complete binary MP3 payload |
| `assistant.audio.done` | generationId |
| `assistant.interrupted` | generationId |
| `booking.created` | safe booking summary |
| `booking.updated` | qualification status |
| `session.capacity_warning` | optional |
| `error` | safe error object |
| `server.pong` | timestamp |

### Binary framing

Client microphone frames remain PCM16LE and are accumulated only within configured utterance duration/byte bounds until `audio.commit`. UI duration/countdown is sample-derived: `durationMs = acceptedPcmBytes / (16000 × 2) × 1000`, а effective ceiling — минимум `maxUtteranceMs` и duration, выведенной из `maxPcmBytes`; circular timer не зависит от wall-clock ticks. Server audio is an atomic phrase-level MP3 payload associated with the preceding `audio.segment` metadata event:

```text
byte 0:     kind (0x01 client PCM16LE, 0x02 server MP3 segment)
bytes 1-8: unsigned sequence, big-endian/network byte order
bytes 9+:  payload (raw PCM16LE or one complete MP3 file)
```

Sequence is a nonnegative JavaScript safe integer (`0..Number.MAX_SAFE_INTEGER`). For `audio.segment`, metadata `byteLength` counts only the MP3 payload at bytes 9+, excluding the 9-byte frame header. The server metadata sequence and raw frame sequence must match, and kind must be `0x02`.

The implementation may use a referenced binary payload instead of adjacency if it preserves the same identity, ordering, canonical frame layout and payload-size contract. It must never expose partial `response.body` chunks as independent MP3 files.

### Ordering

- `seq` монотонно растёт для JSON events в одной conversation.
- один accepted `audio.commit` создаёт не более одного active STT request и одного `transcript.final`; duplicate commits и stale results подавляются.
- audio segments имеют `generationId`, unique `segmentId` и monotonic `sequence`.
- client decodes/plays complete segments in order and ignores segments from an interrupted or obsolete generation.
- одновременно допустимы максимум один playing и один prefetched segment.
- booking events записываются в DB до отправки клиенту.

## 4. Provider-neutral voice contracts

### Atomic SttPort

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

`SttPort` exposes only atomic `transcribe` and `health` operations with provider-neutral request/result types. The gateway/utterance assembler owns chunked PCM16 transport, duration/byte bounds and creation of exactly one validated WAV. The adapter accepts only already-WAV `audio/wav` bytes, independently validates their format and request bounds, rejects raw PCM, base64-encodes the unchanged WAV, and posts one `input_audio` to `/api/v1/chat/completions`. Only a non-empty validated, current final transcript can reach Luna.

### Atomic TtsPort

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

The adapter validates `2xx`, compatible `audio/mpeg`, non-empty bounded bytes and current `generationId` before returning. OpenRouter types and response objects do not cross `TtsPort`.

### OpenRouter STT failure mapping

| HTTP | Mapping | Retry/behavior |
|---:|---|---|
| 400 | invalid audio/request | no retry; safe input error |
| 401 | missing/invalid shared key | no retry; readiness/config error |
| 402 | insufficient credits | no retry; voice input unavailable |
| 404 | model unavailable/config error | no retry; readiness/config error |
| 413 | utterance/request too large | no retry; enforce local bounds |
| 429 | rate limited | at most one retry; bounded `Retry-After` |
| 500/502/503/524/529 | gateway/upstream | at most one bounded retry |

STT retry repeats only the same transcription request. Abort/stale turn returns no transcript; no STT retry invokes Luna, `create_booking`, `append_booking_qualification` or notifier. Error parsing and telemetry never log Authorization, WAV/base64 bytes, transcript text or PII.

### OpenRouter TTS failure mapping

| HTTP | Mapping | Retry/degradation |
|---:|---|---|
| 400 | invalid request/profile | no retry |
| 401 | key/config error | no retry; open circuit, readiness/config signal |
| 402 | insufficient credits | no retry; open circuit, text-only |
| 403 | policy restriction | no retry by default |
| 404 | model unavailable/config error | no retry; open circuit |
| 413 | chunker/request defect | no retry |
| 429 | rate limited | at most one retry; honor bounded `Retry-After` |
| 500/502/503/524/529 | gateway/upstream | at most one bounded retry |

Non-2xx body is parsed as bounded JSON/text and never forwarded as audio. No retry occurs after abort or after a segment was accepted for playback. Retry repeats only synthesis, not Luna, `create_booking`, `append_booking_qualification` or notifier.

## 5. Tool contracts

### `create_booking`

```ts
const ContactSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("phone"), value: z.string().min(5).max(64) }),
  z.object({ channel: z.literal("email"), value: z.string().email() }),
  z.object({ channel: z.literal("telegram"), value: z.string().min(2).max(128) }),
]);

const BookingContactsSchema = z.array(ContactSchema)
  .min(2).max(3)
  .superRefine((contacts, ctx) => {
    const channels = contacts.map((contact) => contact.channel);
    if (!channels.includes("email")) ctx.addIssue({ code: "custom", message: "A working email is required" });
    if (!channels.some((channel) => channel === "phone" || channel === "telegram")) {
      ctx.addIssue({ code: "custom", message: "A phone or Telegram contact is required" });
    }
    if (new Set(channels).size !== channels.length) ctx.addIssue({ code: "custom", message: "Contact channels must be unique" });
  });

const MeetingSlotSchema = z.object({
  startAt: CanonicalRfc3339UtcSchema,
  endAt: CanonicalRfc3339UtcSchema,
  timeZone: z.literal("Europe/Moscow"),
  durationMinutes: z.literal(20),
}).strict(); // also validates weekday and 20-minute grid, 09:00..17:00 Moscow starts

const CreateBookingInputSchema = z.object({
  conversationId: EntityIdSchema,
  idempotencyKey: z.string().min(10).max(128),
  name: z.string().trim().min(1).max(120),
  contacts: BookingContactsSchema,
  company: z.string().trim().min(1).max(200),
  meetingSlot: MeetingSlotSchema,
  consentConfirmed: z.literal(true),
}).strict();
```

Result:

```ts
type CreateBookingResult = {
  ok: true;
  created: boolean; // false на idempotent replay
  bookingId: string;
  status: "booked";
  createdAt: string;
};
```

### `append_booking_qualification`

```ts
// Active write contract is exactly the two optional RC3 fields.
const QualificationPatchSchema = z.object({
  monthlyLeadVolume: z.string().trim().min(1).max(100).optional(),
  salesManagerCount: z.number().int().min(0).max(10000).optional(),
}).strict();

const AppendQualificationInputSchema = z.object({
  bookingId: z.string().min(10),
  idempotencyKey: z.string().min(10).max(128),
  patch: QualificationPatchSchema,
  completion: z.enum(["partial", "complete", "skipped"]).default("partial"),
});
```

Result:

```ts
type AppendQualificationResult = {
  ok: true;
  bookingId: string;
  qualificationStatus: "partial" | "complete" | "skipped";
  updatedFields: Array<"monthlyLeadVolume" | "salesManagerCount">;
  updatedAt: string;
};
```

Server выводит status из persisted truth: оба поля → `complete`, одно → `partial`, zero-field explicit refusal → `skipped`. Model-provided `completion` не может объявить complete без обоих полей. Оба ответа могут прийти одним turn/patch. Legacy rows могут физически содержать старые qualification keys; read-normalization отбрасывает их, а active write schema выше их не принимает.

## 6. Domain policy до tool execution

```ts
switch (tool.name) {
  case "create_booking":
    assert(state === "COLLECT_BOOKING");
    assert(serverContactConsentConfirmed === true);
    assert(currentBooking === null || currentBooking.conversationId === conversationId);
    assert(candidateMeetingSlots.length === 2);
    assert(candidateMeetingSlots.some((slot) => deepEqual(slot, args.meetingSlot)));
    break;
  case "append_booking_qualification":
    assert(["BOOKED", "POST_BOOKING_QUALIFICATION"].includes(state));
    assert(currentBooking?.id === args.bookingId);
    assert(bookingConfirmationDelivered === true);
    assert(qualificationConsent === "granted");
    break;
}
```

LLM-provided `conversationId`, `bookingId`, slot и consent сверяются с server-side session; нельзя доверять им как единственному источнику. После booking commit и delivered confirmation server задаёт точный consent-вопрос `Можно задать два коротких вопроса?`; grant возможен только из последующей explicit user turn. Затем server задаёт monthly leads первым и manager count вторым, по одному; отказ завершает как `skipped` или сохраняет `partial`, не меняя `booking.status=booked`.

Server перед каждым Luna turn строит `schedulingContext` из собственного clock: canonical `currentInstant`, `moscowLocalDate`, `moscowWeekday`, `timeOfDayPreference`, максимум один `rejectedTimeOfDayPreferences` и tuple ровно из двух `{ meetingSlot, displayLabel }`. Bounded Russian parser одинаково применяет typed/spoken morning/day/second-half/evening wording. Default tuple — morning + evening; selected preference даёт два in-band starts примерно через час и переносит пару на следующий weekday, если текущий band occupied; rejection исключает band. Каждый slot — 20 минут, weekday, не сегодня, start на 20-minute grid 09:00–17:00 MSK. Tuple — текущие internal alternatives, не all/global availability. Tool execution повторно отвергает slot вне tuple; BookingService повторно отвергает now-non-bookable или internally occupied start.

## 7. SQLite model

### `conversations`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | ULID/UUIDv7 |
| `status` | text | active/completed/failed/disconnected |
| `stage` | text | state machine stage |
| `codex_thread_id` | text nullable | internal |
| `prompt_version` | text | SHA-256 |
| `source` | text | landing |
| `locale` | text | ru-RU |
| `qualification_enabled` | integer | bool |
| `consent_at` | text | timestamp |
| `started_at` | text | timestamp |
| `ended_at` | text nullable | timestamp |
| `last_error_code` | text nullable | safe code |

### `turns`

- `id` PK;
- `conversation_id` FK;
- `user_text`;
- `assistant_text`;
- `state_before`, `state_after`;
- `speech_final_at` nullable — момент принятого final spoken или typed user turn;
- `brain_started_at`;
- `first_text_delta_at`;
- `first_audio_at`;
- `completed_at`;
- `interrupted`;
- `brain_model`;
- `usage_json` nullable.

### `bookings`

| Column | Constraint |
|---|---|
| `id` | PK |
| `conversation_id` | UNIQUE NOT NULL |
| `status` | CHECK = `booked` in MVP |
| `name` | NOT NULL |
| `contacts_json` | NOT NULL |
| `company` | nullable физически только для сохранённых legacy rows; required/non-empty для всех новых bookings |
| `preferred_time_text` | deprecated nullable legacy column; не входит в active API/tool/event contracts и не записывается новым flow |
| `meeting_start_at` | nullable для legacy rows; canonical UTC, required для новых bookings, UNIQUE when non-null |
| `meeting_end_at` | nullable для legacy rows; ровно +20 минут, required для новых bookings |
| `meeting_timezone` | nullable для legacy rows; `Europe/Moscow`, required для новых bookings |
| `qualification_json` | default `{}`; active flow writes only monthly inbound `monthlyLeadVolume` and integer `salesManagerCount`; legacy keys normalize away on read |
| `qualification_status` | none/partial/complete/skipped; complete iff both active fields, partial iff one, skipped on zero-answer refusal |
| `created_at`, `updated_at` | timestamps |

Migration `0003_internal_meeting_slots.sql` добавляет три meeting columns, partial unique index на non-null start и insert/update triggers для company, canonical timestamps, exact 20-minute duration, Moscow weekday и 09:00–17:00/20-minute-grid rules. Existing legacy rows намеренно сохраняются с `NULL` meeting fields и прежним deprecated text column: migration не придумывает им slots и не удаляет их. Domain snapshot/service fail closed при попытке использовать такую legacy row как complete modern booking; все новые inserts и relevant updates обязаны удовлетворять triggers.

### `idempotency_keys`

- `scope`;
- `key`;
- `request_hash`;
- `result_json`;
- `created_at`;
- unique `(scope, key)`.

Если тот же key приходит с другим request hash — `IDEMPOTENCY_CONFLICT`.

### `domain_events`

Append-only audit:

- `id`, `conversation_id`, `booking_id` nullable;
- `type`;
- `payload_json` с редактированными PII;
- `created_at`.

### `notification_outbox`

- event reference;
- notifier kind;
- status pending/sent/failed;
- attempt count;
- next attempt;
- last error.

## 8. Транзакция booking create

```text
BEGIN IMMEDIATE
  lookup idempotency key
  if found: return stored result
  lookup booking by conversation_id
  if found: validate complete modern snapshot, persist replay key and return same booking
  validate server clock and selected candidate
  reject occupied meeting_start_at
  insert booking
  insert domain_event booking.created
  insert notification_outbox
  persist idempotency result
COMMIT
```

После commit:

1. отправить WS `booking.created`;
2. notifier worker публикует payload;
3. assistant получает safe tool result;
4. server-authored confirmation сообщает, что calendar event не создан, и точно спрашивает `Можно задать два коротких вопроса?`;
5. только subsequent explicit consent открывает qualification и первый deterministic leads question; booking остаётся committed при skip/partial/failure.

## 9. Notification payloads

### Created

```json
{
  "v": 1,
  "type": "booking.created",
  "eventId": "evt_...",
  "occurredAt": "2026-07-30T20:22:00Z",
  "data": {
    "bookingId": "bkg_...",
    "conversationId": "conv_...",
    "name": "Александр",
    "contacts": [
      { "channel": "email", "value": "alex@example.com" },
      { "channel": "telegram", "value": "@alex" }
    ],
    "company": "Example LLC",
    "meetingSlot": {
      "startAt": "2026-08-03T06:00:00.000Z",
      "endAt": "2026-08-03T06:20:00.000Z",
      "timeZone": "Europe/Moscow",
      "durationMinutes": 20
    },
    "status": "booked",
    "qualificationStatus": "none"
  }
}
```

### Updated

```json
{
  "v": 1,
  "type": "booking.updated",
  "eventId": "evt_...",
  "occurredAt": "2026-07-30T20:24:00Z",
  "data": {
    "bookingId": "bkg_...",
    "qualificationStatus": "partial",
    "qualification": {
      "monthlyLeadVolume": "около 2000 входящих лидов в месяц",
      "salesManagerCount": 8
    }
  }
}
```

Webhook P1 подписывается `HMAC-SHA256(timestamp + '.' + rawBody)` и содержит event ID для deduplication.

## 10. Safe error taxonomy

| Code | Retry | User-facing behavior |
|---|---|---|
| `MIC_PERMISSION_DENIED` | no | инструкция открыть доступ |
| `SESSION_EXPIRED` | new session | перезапуск |
| `CAPACITY_EXCEEDED` | later | сервис временно занят |
| `STT_UNAVAILABLE` | yes | retry/connect message |
| `BRAIN_AUTH_REQUIRED` | admin | user-safe unavailable state |
| `BRAIN_RATE_LIMITED` | later | graceful stop; keep booking |
| `BRAIN_PROTOCOL_ERROR` | yes/fallback | switch envelope or stop |
| `TTS_UNAVAILABLE` | text fallback | показать текст |
| `BOOKING_VALIDATION_FAILED` | user correction | спросить конкретное поле |
| `IDEMPOTENCY_CONFLICT` | admin review | не повторять effect |
| `DB_UNAVAILABLE` | no create | не подтверждать booking |
| `NOTIFIER_FAILED` | async retry | booking всё равно создан |

## 11. Retention

- raw audio: не хранить;
- transcript: `TRANSCRIPT_RETENTION_DAYS`, default 30 дней; startup и hourly runner удаляют bounded batches из `turns` по durable timestamp, не удаляя conversation/booking;
- bookings: до ручного удаления/экспорта и никогда не каскадно из transcript purge;
- events: минимум срок отладки и аудита, configurable;
- Codex thread state: stop/expiry прерывает turn, вызывает `thread/delete`, очищает process-local maps; TTS session budgets также reset;
- backups наследуют срок хранения и шифруются.
