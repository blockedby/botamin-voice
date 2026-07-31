# 05. API, события и модель данных

## 1. Общие правила контрактов

- Все JSON payloads валидируются Zod на границе.
- Все timestamps — RFC 3339 UTC.
- Все IDs — UUIDv7 или ULID; внешний формат не должен содержать PII.
- Все события содержат `conversationId`, а booking events также `bookingId`.
- Версия контракта передаётся как `v: 1`.
- Ошибки providers не пробрасываются клиенту напрямую.
- Binary WebSocket frames используются только для PCM audio.
- Tool handlers не доступны как публичные HTTP endpoints.

## 2. REST endpoints

### `POST /api/v1/conversations`

Создать сессию.

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
  "expiresAt": "2026-07-30T21:30:00Z",
  "clientConfig": {
    "inputSampleRate": 16000,
    "inputEncoding": "pcm16le",
    "chunkMs": 100,
    "outputSampleRate": 24000
  }
}
```

Errors: `CONSENT_REQUIRED`, `CAPACITY_EXCEEDED`, `BRAIN_NOT_READY`.

### `POST /api/v1/conversations/:id/stop`

Идемпотентно завершает сессию. Основной stop идёт по WS; endpoint нужен для unload/fallback.

### `GET /health/live`

Процесс жив. Не проверяет providers.

### `GET /health/ready`

Проверяет:

- DB write/read;
- Codex app-server handshake;
- наличие auth и модели Luna в `model/list`;
- конфигурацию xAI key;
- prompt bundle checksum;
- возможность принять новую conversation по concurrency guard.

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
    "resumeToken": null,
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
    "resumeToken": "opaque-short-lived-token"
  }
}
```

### Client → server JSON events

| Event | Payload | Назначение |
|---|---|---|
| `client.hello` | audio config, resume token | handshake |
| `audio.commit` | `{}` | принудительно завершить текущую реплику |
| `playback.started` | `generationId` | метрика |
| `playback.interrupted` | `generationId`, reason | barge-in |
| `session.stop` | reason | корректное завершение |
| `client.ping` | timestamp | keepalive |

После handshake PCM16 audio идёт binary frames без base64.

### Server → client events

| Event | Payload |
|---|---|
| `session.ready` | state/config |
| `state.changed` | from/to/reason |
| `transcript.partial` | text/confidence-ish metadata |
| `transcript.final` | turnId/text |
| `assistant.text.delta` | generationId/text |
| `assistant.text.done` | generationId/fullText |
| `assistant.audio.chunk` | **binary frame preceded by metadata event or multiplex header** |
| `assistant.audio.done` | generationId |
| `assistant.interrupted` | generationId |
| `booking.created` | safe booking summary |
| `booking.updated` | qualification status |
| `session.capacity_warning` | optional |
| `error` | safe error object |
| `server.pong` | timestamp |

### Binary framing

Рекомендуемый простой формат одного WSS:

```text
byte 0      message kind: 0x01 = client PCM, 0x02 = server PCM
bytes 1–8   uint64 generation/stream sequence
bytes 9…    raw PCM16LE payload
```

Альтернатива — два WebSocket канала; для MVP один multiplexed socket проще в эксплуатации.

### Ordering

- `seq` монотонно растёт для JSON events в одной conversation.
- audio chunks имеют `generationId` и `audioSeq`.
- client игнорирует chunks с generationId, который уже interrupted.
- booking events записываются в DB до отправки клиенту.

## 4. Tool contracts

### `create_booking`

```ts
const ContactSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("phone"), value: z.string().min(5).max(64) }),
  z.object({ channel: z.literal("email"), value: z.string().email() }),
  z.object({ channel: z.literal("telegram"), value: z.string().min(2).max(128) }),
]);

const CreateBookingInputSchema = z.object({
  conversationId: z.string().min(10),
  idempotencyKey: z.string().min(10).max(128),
  name: z.string().min(1).max(120),
  contacts: z.array(ContactSchema).min(1).max(3),
  company: z.string().max(200).optional(),
  preferredTimeText: z.string().max(500).optional(),
  consentConfirmed: z.literal(true),
});
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
const QualificationPatchSchema = z.object({
  role: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
  companySize: z.string().max(100).optional(),
  monthlyLeadVolume: z.string().max(100).optional(),
  currentChannels: z.array(z.string().max(80)).max(10).optional(),
  crm: z.string().max(120).optional(),
  currentProcess: z.string().max(1000).optional(),
  pains: z.array(z.string().max(300)).max(10).optional(),
  desiredUseCase: z.string().max(500).optional(),
  timeline: z.string().max(200).optional(),
  notes: z.string().max(1500).optional(),
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
  updatedFields: string[];
  updatedAt: string;
};
```

## 5. Domain policy до tool execution

```ts
switch (tool.name) {
  case "create_booking":
    assert(state === "COLLECT_BOOKING");
    assert(currentBooking === null || currentBooking.conversationId === conversationId);
    break;
  case "append_booking_qualification":
    assert(["BOOKED", "POST_BOOKING_QUALIFICATION"].includes(state));
    assert(currentBooking?.id === args.bookingId);
    break;
}
```

LLM-provided `conversationId`, `bookingId` и consent сверяются с server-side session; нельзя доверять им как единственному источнику.

## 6. SQLite model

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
- `speech_final_at`;
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
| `company` | nullable |
| `preferred_time_text` | nullable |
| `qualification_json` | default `{}` |
| `qualification_status` | none/partial/complete/skipped |
| `created_at`, `updated_at` | timestamps |

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

## 7. Транзакция booking create

```text
BEGIN IMMEDIATE
  lookup idempotency key
  if found: return stored result
  lookup booking by conversation_id
  if found: persist replay key and return same booking
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
4. только потом orchestrator разрешает qualification stage.

## 8. Notification payloads

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
    "contacts": [{ "channel": "telegram", "value": "@alex" }],
    "company": "Example LLC",
    "preferredTimeText": "завтра после 15:00",
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
      "role": "Head of Sales",
      "monthlyLeadVolume": "около 2000",
      "crm": "amoCRM",
      "pains": ["лиды ждут ночью"]
    }
  }
}
```

Webhook P1 подписывается `HMAC-SHA256(timestamp + '.' + rawBody)` и содержит event ID для deduplication.

## 9. Safe error taxonomy

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

## 10. Retention

- raw audio: не хранить;
- transcript: configurable retention, default 30 дней для MVP;
- bookings: до ручного удаления/экспорта;
- events: минимум срок отладки и аудита, configurable;
- Codex thread logs: lifecycle и deletion должны быть согласованы с transcript retention;
- backups наследуют срок хранения и шифруются.
