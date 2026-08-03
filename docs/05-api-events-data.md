# 05. API, события и модель данных

## 1. Общие правила контрактов

- Все JSON payloads валидируются Zod на границе.
- Все timestamps — RFC 3339 UTC.
- Все IDs — UUIDv7 или ULID; внешний формат не должен содержать PII.
- Все события содержат `conversationId`, а booking events также `bookingId`.
- Версия контракта передаётся как `v: 1`.
- Ошибки providers не пробрасываются клиенту напрямую.
- Binary WebSocket frames несут client PCM16 input или один полный provider-neutral server MP3/canonical-WAV phrase payload; raw provider PCM/network chunks никогда не публикуются как playable audio.
- Tool handlers не доступны как публичные HTTP endpoints.
- Proactive greeting не является API/session contract: page entry делает один same-origin GET/playback static MP3, без conversation REST/WS/mic/provider/session до обоих consents. Blocked/error fallback — `Включить приветствие`; session start прекращает static playback.
- Committed proactive greeting и 16 reaction MP3s — same-origin static product assets without visitor data. Their generation is explicit paid admin opt-in; visitor runtime never synthesizes them, and reactions have no transcript/state/provider/business effect.

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
- наличие auth и exact Luna/`low` в `model/list`; если запрошен `CODEX_SERVICE_TIER=priority`, exact Luna entry обязан рекламировать service-tier id `priority`, иначе readiness возвращает `CODEX_MODEL_OR_TIER_UNAVAILABLE` (отсутствующее legacy-поле допустимо только для standard service);
- ровно один `OPENROUTER_API_KEY` для обоих voice paths;
- при `STT_PROVIDER=openrouter`: schema-valid audio-input model/`wav`/language, utterance byte/time limits и request timeout/retry limits; readiness не утверждает наличие provider streaming session;
- при `TTS_PROVIDER=openrouter`: one exact schema-valid profile (`xai_mp3` → xAI/eve/MP3 by default, or complete opt-in `gemini_3_1_pcm` → Preview model/case-sensitive snapshot voice/PCM), queue/circuit state and text-only startup policy; readiness makes no paid call and selects no fallback;
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
    },
    "capabilities": {
      "localReactions": {
        "version": 1,
        "clipIds": ["neutral-good", "neutral-accepted"]
      }
    },
    "playback": {
      "maxBufferedSegments": 4,
      "maxBufferedBytes": 20000000,
      "maxSegmentBytes": 5000000
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
| `client.hello` | legacy-shaped audio config + resume token only | strict first handshake, compatible with exact `origin/main` |
| `client.protocol.accept` | version 2, exact reaction capability or null, literal four-segment/20 MB playback window | accepts only a preceding trusted v2 server offer |
| `audio.commit` | `{}` | закрыть bounded utterance и создать ровно один atomic final-transcription request |
| `visitor.text.submit` | `{ sequence, text }` | one final typed turn; same durable fact path as spoken transcript |
| `booking.form.submit` | `{ requestId, baseRevision, details, selectedCandidateId? }` | structured patch/current candidate against exact draft revision |
| `booking.conflict.resolve` | `{ requestId, baseRevision, field, conflictOptionId }` | explicitly accept one current conflict option |
| `booking.draft.confirm` | `{ requestId, revision }` | confirm exact ready revision and trigger automatic internal meeting commit |
| `playback.started` | `generationId` | метрика |
| `playback.segment.released` | `{ generationId, segmentId, sequence, byteLength }` | exact release acknowledgment returns one segment/byte credit |
| `playback.interrupted` | `generationId`, reason | barge-in |
| `session.stop` | reason | корректное завершение |
| `client.ping` | timestamp | keepalive |

Первый `client.hello` обязан предъявить одноразовый `clientToken` из REST response and remains strict legacy-shaped: v2 capability fields are not injected into it. The same-origin REST URL contains only the low-cardinality `?voiceProtocol=2` signal. A new server then emits `session.protocol.offer`; only an exact `client.protocol.accept` enables reactions and ACK-dependent credits, after which `session.ready` replaces the token. Exact `origin/main` ignores the query and emits `session.ready` directly, so the new browser stays in legacy mode and sends no unknown v2 event. An old browser reaching the new server has no trusted v2 query and is rejected with a bounded legacy-valid error/policy close before readiness, token rotation, or turn consumption; a reload obtains the co-deployed browser while durable booking state remains intact. Unknown, duplicate, or additional query fields and mismatched accept values fail closed.

На session допускается один pending hello-кандидат с коротким deadline и один bound socket. Reconnect заменяет bound socket only after complete hello/token/protocol validation; an unconfirmed candidate does not displace it.

После handshake PCM16 audio идёт binary frames без base64. Gateway/utterance assembler ограничивает accumulated input максимумом 60,000 ms и так, чтобы atomic WAV не превысил 2,000,000 bytes; при 16 kHz mono PCM16 default duration ceiling строже и даёт `maxPcmBytes=1,920,000`. После `audio.commit` gateway кодирует ровно один validated WAV и передаёт его atomic `SttPort`; только OpenRouter adapter выполняет base64 encoding уже готовых WAV bytes. Browser chunks не означают streaming transport до provider.

`visitor.text.submit` is the provider-neutral alternative final input. After acceptance, typed and spoken turns use the same fact extractor, quoted Luna proposal boundary, durable draft merge, scheduling parser, state/persistence, assistant, and optional TTS path.

The booking form is not encoded as visitor text in RC4. It sends strict revisioned commands. `details` may patch accepted/missing values; `selectedCandidateId` must identify one of exactly two current candidates. Stale revision, unresolved conflict, candidate mismatch, not-ready, or already-committed state returns a closed `booking.form.rejected` code without echoing PII. Every material change clears prior confirmation. `booking.draft.confirm` confirms only the exact ready revision and automatically runs the idempotent internal booking commit.

### Server → client events

| Event | Payload |
|---|---|
| `session.protocol.offer` | `{ version: 2 }`; emitted only for a trusted exact v2 upgrade query after valid legacy-shaped hello |
| `session.ready` | state/config; means negotiation is complete (v2) or exact old-server legacy fallback selected |
| `state.changed` | from/to/reason; voice UI uses listening/processing states |
| `transcript.final` | turnId/text; единственное STT text event после atomic provider result |
| `assistant.reaction.request` | turnId, generationId, allowlisted clipId, `delayMs=350`; decoration only, no text/state/provider effect |
| `assistant.text.delta` | generationId/plain text |
| `assistant.text.done` | generationId/plain fullText; style tags never appear here |
| `audio.segment` | generationId, segmentId, sequence, `contentType=audio/mpeg|audio/wav`, byteLength, `final=true`; immediately followed by one complete matching binary payload |
| `assistant.audio.done` | generationId |
| `assistant.interrupted` | generationId |
| `booking.draft.updated` | request correlation + browser-safe revisioned projection without provenance/evidence |
| `booking.form.rejected` | closed safe error code/current revision; never reflects submitted PII |
| `booking.created` | safe booking summary after durable commit |
| `internal.meeting.updated` | server-derived scheduled internal-virtual meeting projection; external flags false |
| `booking.updated` | qualification status/fields after durable patch |
| `session.capacity_warning` | optional |
| `error` | safe error object |
| `server.pong` | timestamp |

### Binary framing

Client microphone frames remain PCM16LE and are accumulated only within configured utterance duration/byte bounds until `audio.commit`. UI duration/countdown is sample-derived: `durationMs = acceptedPcmBytes / (16000 × 2) × 1000`, а effective ceiling — минимум `maxUtteranceMs` и duration, выведенной из `maxPcmBytes`; circular timer не зависит от wall-clock ticks. Server audio is one complete phrase-level payload associated with the preceding `audio.segment` metadata event:

```text
byte 0:     kind (0x01 client PCM16LE, 0x02 server MP3, 0x03 server canonical WAV)
bytes 1-8: unsigned sequence, big-endian/network byte order
bytes 9+:  payload (raw mic PCM16LE, one complete MP3, or one complete canonical WAV)
```

Sequence is a nonnegative JavaScript safe integer (`0..Number.MAX_SAFE_INTEGER`). Metadata `byteLength` counts payload bytes only. Sequence, byte length, and kind must match adjacent metadata; `audio/mpeg` requires `0x02`, `audio/wav` requires `0x03`. Provider PCM is wrapped and validated server-side before this boundary.

The implementation may use a referenced binary payload instead of adjacency if identity, ordering, canonical frame layout, and payload-size contract are preserved. Partial provider `response.body` chunks and raw TTS PCM are never browser audio.

### Ordering

- `seq` монотонно растёт для JSON events в одной conversation.
- один accepted `audio.commit` создаёт не более одного active STT request и одного `transcript.final`; duplicate commits и stale results подавляются.
- audio segments имеют `generationId`, unique `segmentId` и monotonic `sequence`; server may synthesize current + one prefetch but publishes only in source order.
- client validates/decodes/plays complete MP3/WAV in order and ignores interrupted/obsolete generations.
- v2 credit flow is enabled only after exact offer/accept negotiation and is at most four segments / 20 MB / 5 MB each; browser has at most two decoding/decoded/scheduled slots plus at most two raw slots and returns credit only after exact release. Missing negotiation never receives silent default credits.
- gapless playback schedules prefetched audio at the current segment's end time rather than from an `ended` callback.
- one reaction per eligible turn is capability/stage/privacy gated, delayed 350 ms, same-origin only, and cancelled before dynamic audio or on mute/barge-in/staleness.
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

The adapter validates `2xx`, profile-compatible bytes and current `generationId`. The default xAI profile returns complete `audio/mpeg`; the opt-in Gemini Preview profile accepts raw provider PCM only server-side and wraps it as one canonical complete mono 24 kHz PCM16LE `audio/wav`. The exact four-env profile and case-sensitive 30-voice release snapshot are in [`../CURRENT_DECISIONS.md`](../CURRENT_DECISIONS.md). Profile mismatch fails closed: no automatic model/voice selection or xAI fallback.

`deliveryStyle` is trusted server metadata only. Fixed values are neutral/curious/serious/excited; sensitive facts always select neutral, Gemini tags are inserted only inside the adapter, and style never appears in the plain transcript or durable state. OpenRouter types, raw PCM, tags, and response objects do not cross `TtsPort`.

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
// Active write contract remains exactly the two optional qualification fields.
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

## 6. Domain policy before durable commit

`create_booking` is reached only through server-owned exact-revision confirmation, not directly from browser/model payload:

```text
assert stage == COLLECT_BOOKING and contact consent is confirmed
load draft at confirmation.revision
assert draft.readiness == ready and draft.confirmationStatus can be confirmed
assert all required facts are accepted and conflicts are resolved
assert selectedCandidate exactly matches one of two current candidates
mark draft committing
idempotently create booking from accepted facts + selected slot
verify persisted booking matches confirmed draft
mark draft committed with bookingId
publish booking.created and internal.meeting.updated
```

Any material fact/candidate change clears confirmation; stale revision and non-current candidate fail closed. The durable booking is the only meeting entity. Its browser projection says `kind=internal_virtual`, `status=scheduled`, `externalCalendarEventCreated=false`, and `externalInviteSent=false`.

After truthful meeting confirmation, optional qualification begins directly. There is no separate consent phrase/turn. Server asks only a missing authoritative field: volume first when both are missing, otherwise only the missing field, and none when both are known. Generic daily volume requires basis clarification before server normalization. Refusal yields skipped/partial without changing `booking.status=booked`.

Before each Luna turn the server builds scheduling context from its own clock and exactly two concrete Moscow candidates. Typed/spoken time-band, rejection, and supported concrete date/time expressions use the same parser. Exact permitted requests return exact+alternative; otherwise nearest internal candidates or clarification/unavailable status. Every proposed slot is a non-today weekday 20-minute start on the 09:00–17:00 Moscow grid and is only a current internal alternative.

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

### `conversation_contexts` (migration 0004)

| Column | Contract |
|---|---|
| `conversation_id` | PK/FK → `conversations.id`, `ON DELETE CASCADE` |
| `revision` | nonnegative integer used for expected-revision CAS |
| `draft_json` | valid JSON object; contains internal fact registry/provenance/conflicts, exactly two candidate IDs/slots, selected candidate, readiness, confirmation/commit status, booking ID and timestamps |
| `updated_at` | must equal `draft_json.updatedAt` |

SQLite checks require `draft_json.revision == revision`, `draft_json.factRegistry.revision == revision`, and matching timestamps. Store writes use `BEGIN IMMEDIATE`; form/conflict/confirm commands also use scoped idempotency keys. Browser projections strip `conversationId`, provenance, and evidence text. No separate facts, evidence, or virtual-meeting table is created.

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

After exact-revision commit:

1. mark draft `committed` with the same durable `bookingId`;
2. send `booking.created` and server-derived `internal.meeting.updated`;
3. notifier worker publishes the booking payload;
4. truthfully confirm the internal virtual meeting and that no external event/invite exists;
5. ask only the first missing qualification field, or nothing if both are known; booking remains committed under skip/partial/failure.

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
- transcript and active-draft PII: `TRANSCRIPT_RETENTION_DAYS`, default 30 days; startup/hourly bounded purge deletes expired `turns` and `conversation_contexts` but preserves conversations/bookings;
- bookings: retained until explicit deletion/export and never cascaded by transcript/context retention;
- explicit privacy deletion by conversation transactionally removes booking, draft context, turns, idempotency rows, related outbox entries, and the conversation; existing append-only domain events are already redacted and remain, and one additional count-only `privacy.deleted` audit event is appended;
- append-only redacted events remain for audit; their configurable expiry is not implemented by the transcript-retention worker;
- Codex thread state: stop/expiry прерывает turn, вызывает `thread/delete`, очищает process-local maps; TTS session budgets также reset;
- local protected backups are mode-0600 SQLite files with SHA-256 sidecars; encryption/retention is a host-owner requirement, not implemented by the repository wrapper.
