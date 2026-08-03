# 06. Deployment, security и operations

## 1. Deployment topology

![Deployment](../diagrams/05-deployment.svg)

Candidate `0.5.0-local-rc.4` is recommended but untagged for one trusted local machine at `http://localhost:5173`. RC3 evidence is preserved separately and is not RC4 proof. A target VPS, DNS, public TLS/WSS, target-host provider live booking, and WebKit full journey are external gates and are not implied by local readiness.

Один `docker-compose.yml`, ровно два application-path сервиса рекомендуются:

1. `app` — Bun server, React static, Codex app-server child process, SQLite access и native HTTPS `fetch` к OpenRouter.
2. `caddy` — TLS termination и WebSocket reverse proxy.

Отдельного voice runtime/container нет. OpenRouter вызывается напрямую из `app` по HTTPS для atomic STT chat completions и complete-segment TTS; один runtime-only key авторизует оба.

Persistent volumes:

- `app-data:/data` — SQLite и backups;
- `codex-home:/codex-home` — `auth.json`, Codex thread/session metadata.

## 2. Compose requirements

The tracked [`../docker-compose.yml`](../docker-compose.yml) is the exact runtime contract. It pins app/Caddy inputs, runs the app as non-root with a read-only filesystem, persists SQLite and Codex auth in named volumes, and receives OpenRouter/webhook values only through read-only files under `/run/secrets`.

Do not use `env_file: .env`, source `.env`, or invoke raw `docker compose up` as the documented bootstrap. `scripts/deploy-local.sh` parses dotenv data, materializes mode-`0600` secret files, renders/scans Compose config, and builds first. If the app is live it takes a protected online backup and then uses Compose's 30-second graceful stop before any schema mutation; if the app is stopped but `/data/app.db` exists it takes a protected no-migration backup. A fresh volume needs no backup. The replacement app is started with `AUTO_MIGRATE=true`, so migration runs through the normal entrypoint before the server; bounded `/health/ready` and then `db.js verify-rc4` must pass. The script never runs a one-off migration against a live app.

## 3. Docker image

Multi-stage:

1. build frontend;
2. install server production deps;
3. install pinned Codex CLI binary/version;
4. generate Codex TS/JSON schemas при build или CI;
5. compile prompt bundle в isolated `/app/runtime-brain/AGENTS.md`;
6. runtime image содержит только production assets, migrations, source Markdown prompts и compiled safe runtime bundle.

Не использовать floating `latest` для Codex в production. Версия CLI фиксируется, потому что app-server schemas version-specific. `OPENROUTER_API_KEY` inject-ится только runtime secret/env и отсутствует в build args, layers, image history и rendered Compose evidence.

## 4. Codex subscription auth on the trusted host

### Bootstrap

Authenticate before the first local deploy through the supported wrapper:

```bash
./scripts/device-auth.sh
```

The wrapper builds the app image, runs interactive device auth, checks login status, and stores the result in the fixed persistent `botamin-codex-home` volume mounted at `/codex-home`. The host-side `CODEX_HOME` value in `.env` applies only to direct Bun operation.

### Readiness and optional deeper preflight

`scripts/deploy-local.sh` waits for `/health/ready`. Before readiness, a bounded DB-only recovery scan processes orphaned `committing` drafts without Luna/STT/TTS or an in-memory session; safe aggregate failures keep orphan-recovery health degraded and rows eligible for a later bounded sweep. The automatic readiness path also verifies the isolated Codex runtime configuration and app-server handshake, ChatGPT account/auth state, requested model/effort availability, the compiled prompt file, SQLite read/write, queue capacity, notifier state, and local STT/TTS configuration and circuit health. It does **not** run `thread/start`, inspect `instructionSources` from a created thread, execute a synthetic turn, wait for a streamed delta, or send `turn/interrupt`. Failed required checks make `/health/ready` return `503` and prevent new voice sessions.

The standalone `scripts/codex-preflight.ts` is a separate, deeper owner-authorized check that has already been observed historically; it is not called by deployment or readiness. After compiling `AGENTS.md` into an isolated runtime directory, an owner may explicitly run:

```bash
CODEX_HOME=/absolute/protected/codex-home \
CODEX_CWD=/absolute/isolated/runtime-brain \
bun scripts/codex-preflight.ts
```

That optional command performs `thread/start`, verifies `instructionSources`, runs a short synthetic Codex turn, observes a streamed delta, and checks `turn/interrupt`; it consumes authorized Codex subscription usage. No deploy, health, or readiness command automatically runs this check, a paid OpenRouter request, or a Codex generation turn.

### Ограничения subscription mode

- `auth.json` — парольоподобный секрет;
- хранить только на trusted private VPS;
- не коммитить, не включать в image/backup без шифрования;
- одна копия auth должна использоваться одной машиной или сериализованным job stream;
- горизонтальное масштабирование с общей personal auth не планируется;
- лимиты подписки и credits могут быть исчерпаны;
- API-key auth остаётся архитектурным fallback, но не включён по умолчанию.
- личная subscription auth считается MVP-оптимизацией, а не production SLA; до публичного коммерческого запуска требуется review применимости плана, capacity и текущих правил провайдера;
- public browser не получает generic Codex execution: backend принимает только ограниченный conversation protocol, применяет rate limits/state policy и запускает brain в изолированном read-only runtime.

## 5. Codex process supervision

- один long-running `codex app-server` child process;
- Bun supervisor перезапускает его с exponential backoff;
- при падении активные turns получают `BRAIN_PROCESS_RESTARTED`;
- thread IDs сохраняются, но resume после restart проверяется contract test;
- stdout — только protocol JSONL, stderr отправляется в structured logs с redaction;
- pending RPC map имеет timeout и cleanup;
- входящие events маршрутизируются по `threadId`/`turnId`;
- при graceful shutdown новые turns не принимаются, текущим даётся короткое drain window.

## 6. Security model

### Browser boundary

- same-origin API/WSS;
- TLS обязателен;
- origin validation;
- short-lived resume token;
- IP/session rate limit;
- ограничение размера JSON и audio frames;
- no provider secrets;
- CSP и secure headers;
- mic permission только после user gesture.

### Codex boundary

- `approvalPolicy: never`;
- максимально ограниченный sandbox/permission profile;
- `cwd` — отдельная runtime directory, не source repository;
- read roots — только isolated `/app/runtime-brain` с compiled `AGENTS.md` и allowlisted knowledge;
- network/command tools блокируются acceptance test;
- разрешены только зарегистрированные booking tools;
- tool args всегда повторно валидируются;
- unexpected tool request отклоняется и логируется.

### Data protection

- raw audio не сохраняется;
- PII redaction в общих логах;
- contact values are stored in the durable draft/booking and exposed to the browser only in stage-gated projections; TTS receives only an exact server-approved contact when contact-processing consent is active, otherwise it is redacted;
- `.env`, единственный OpenRouter key, webhook secret, Codex auth, WAV/base64 audio и transcript PII не попадают в logs;
- browser bundle и events не содержат OpenRouter key или direct provider URL;
- DB volume и backup с ограниченными permissions;
- privacy/consent copy перед микрофоном;
- implemented conversation deletion transaction removes booking, context, turns, idempotency, related outbox entries, and conversation; existing redacted append-only domain events remain and a count-only `privacy.deleted` event is appended;
- transcript retention also purges expired `conversation_contexts` in bounded batches while preserving conversations and bookings;
- финальная юридическая формулировка требует отдельной проверки владельцем продукта.

## 7. Observability

### Structured log fields

```json
{
  "level": "info",
  "event": "brain.turn.completed",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "stage": "VALUE",
  "durationMs": 823,
  "firstDeltaMs": 611,
  "model": "gpt-5.6-luna",
  "promptVersion": "sha256:..."
}
```

PII не включается в generic logs.

### Metrics

- active conversations;
- WS reconnect/disconnect;
- audio input bytes/duration;
- `audio.commit` → OpenRouter final transcript latency, WAV duration/bytes, status/retry/stale-turn counts;
- brain queue time, first delta, completion;
- OpenRouter TTS request/completion latency, status, bounded bytes and character usage;
- final transcript → playback первой complete MP3 phrase;
- interrupted/stale segment count, circuit state, budget rejection и text-only degradation;
- booking create/update success/error;
- notifier outbox lag;
- provider error/rate-limit counts;
- Codex auth age/status;
- SQLite file/WAL size.

P0 держит bounded process-local aggregates и отдаёт safe JSON через `GET /metrics` только прямому loopback peer; отсутствие peer evidence закрывает доступ, а Caddy/public/forwarded requests получают отказ. Snapshot не содержит IDs, model/voice names, text, contact, audio/base64, auth или provider error bodies. Latency, queue wait, provider duration и circuit cooldown используют monotonic clock (`Bun.nanoseconds()`/`performance.now()`), а отдельный wall clock формирует только ISO `generatedAt`; перевод системных часов не меняет samples. Circuit остаётся `open` после idle cooldown до acquisition, которое синхронно публикует `half-open`, затем `closed` или повторный `open`. Точные milestone, p50/p95, TTS settlement-before-yield и missing-sample semantics зафиксированы в `apps/server/src/observability/README.md`. Сохранённый operator snapshot можно проверить и агрегированно вывести через `bun run scripts/observability-report.ts SAFE_SNAPSHOT.json`; скрипт не читает production memory и до любого stdout требует полный fixed nested schema, включая exact-key fixed-cardinality maps.

## 8. Health model

| Check | Live | Ready |
|---|---:|---:|
| Bun event loop/process | yes | yes |
| DB | no | read+write |
| prompts | no | checksum/parse |
| Codex process | no | handshake/model/auth |
| OpenRouter STT | no | shared key, model/format/language and utterance/request bounds; no provider-session claim or paid call on every check |
| OpenRouter TTS | no | same shared key, model/voice/format schema, queue/circuit state; no paid call on every check |
| capacity | no | STT request, brain and TTS queues below thresholds |
| notifier | no | outbox worker running; external outage не блокирует booking |

Notifier failure не должен делать app unready, если outbox сохраняет событие. TTS config failure may allow startup only when `TTS_TEXT_ONLY_FALLBACK=true`; readiness must expose degraded state rather than pretending OpenRouter is ready. Healthchecks never spend OpenRouter usage.

## 9. Migration, backup, restore, and rollback boundaries

- RC4 migration `0004` only adds `conversation_contexts`; it does not backfill existing RC3 conversations and creates no duplicate fact/evidence/meeting table. Existing RC3 bookings remain unchanged.
- Local cutover takes `VACUUM INTO` backup plus mode-`0600` SHA-256 sidecar before stopping/migrating an existing DB. The server is gracefully stopped before normal startup applies schema changes.
- Post-start acceptance requires `/health/ready`, `PRAGMA integrity_check`, exact context columns/FK/check constraints, persisted JSON revision/timestamp consistency, `foreign_key_check`, and absence of duplicate RC4 tables.
- Migrations are forward-only. Code/image rollback without a DB restore is allowed only if the older image is proven compatible with the forward schema. Otherwise stop the app and use the matching pre-cutover backup; never try to reverse `0004` in place.
- Restore verifies sidecar permissions/digest/integrity before stop, verifies again, migrates a temporary copy, atomically swaps it, retains a protected pre-restore backup, and requires readiness.
- Repository backups are protected/checksummed but not encrypted and have no automatic retention policy. Host-owner encrypted snapshots, retention, RPO/RTO and restore drills remain operations responsibilities. `codex-home` auth is separate and excluded from ordinary DB backups.

## 10. Capacity guard

Первый релиз должен ограничивать concurrency, потому что:

- Codex subscription имеет rolling usage limits;
- одна auth identity — single-host constraint;
- cheap VPS имеет ограниченные CPU/RAM;
- voice providers имеют rate limits.

Механизм:

```text
MAX_ACTIVE_CONVERSATIONS
MAX_ACTIVE_CONVERSATIONS_PER_SOURCE
MAX_CONCURRENT_BRAIN_TURNS
MAX_PENDING_BRAIN_TURNS
BRAIN_QUEUE_TIMEOUT_MS
MAX_CONVERSATION_CREATES_PER_SOURCE
MAX_SESSION_CONNECTIONS_PER_SOURCE
CLIENT_HELLO_TIMEOUT_MS
ABANDONED_SESSION_TIMEOUT_MS
STT_MAX_UTTERANCE_MS
STT_MAX_AUDIO_BYTES
STT_TOTAL_TIMEOUT_MS
TTS_MAX_CONCURRENCY
TTS_PREFETCH_SEGMENTS
TTS_MAX_CHARS_PER_TURN
TTS_MAX_CHARS_PER_SESSION
SESSION_MAX_MINUTES
TURN_TIMEOUT_MS
```

При переполнении новая сессия/turn получает structured `CAPACITY_EXCEEDED`. Committed WAV остаётся bounded in-memory до admission или timeout. Очередь разделена на booked и standard FIFO lanes: booked lane выбирается первой, порядок внутри lane не меняется. Stop/expiry отменяет queued work и является bounded cancellation barrier для STT/brain/TTS/tool events.

Source key берётся из direct peer address. Forwarded IP игнорируется при безопасном default `TRUSTED_PROXY_HOPS=0`; Compose задаёт ровно один trusted Caddy hop. Malformed forwarding chains fail closed. Create/WS attempt windows и active sessions per source дополняют global limits; Origin остаётся дополнительной, но не единственной защитой. REST выдаёт одноразовый first-hello token, pending socket ограничен одним и abandoned REST-created session освобождается раньше общего TTL.

## 11. Failure and degraded modes

| Failure | Поведение |
|---|---|
| Codex auth expired | readiness 503, admin alert; существующая booking не теряется |
| Luna quota/rate limit | очередь с коротким timeout; затем graceful user message |
| OpenRouter STT timeout/down | no transcript, no Luna/tools; discard bounded utterance and show safe retry state |
| OpenRouter STT `400/401/402/404/413` | typed non-retryable input/config/credit error; never fabricate text |
| OpenRouter STT `429`/retryable `5xx` | at most one pure transcription retry; abort/stale result cannot invoke brain/tools |
| OpenRouter TTS `401/402/404` | no retry; safe text-only output mode/circuit, keep text and booking |
| OpenRouter TTS `429`/retryable `5xx` | at most one synthesis-only retry, then text-only/circuit policy |
| TTS timeout, budget or invalid audio | drop audio segment, keep visible text and tool effects; never repeat Luna/tools |
| DB locked/error | не подтверждать booking до commit |
| notifier down | outbox retry; booking считается созданной |
| client disconnect before booking | conversation `disconnected` |
| client disconnect after booking | booking stays; qualification partial/skipped |
| app restart | restore DB; unfinished conversation marked interrupted/expired |

## 12. Basic runbook

### Local deploy

```bash
cp .env.example .env
chmod 600 .env
# Fill the backend-only OPENROUTER_API_KEY without sourcing .env.
./scripts/device-auth.sh
./scripts/deploy-local.sh
curl -fsS http://localhost:5173/health/ready
# deploy-local already runs this after readiness; manual recheck:
docker compose exec -T app bun /app/ops/db.js verify-rc4
```

The wrapper does not run paid provider smokes. Recovery and observability commands are maintained in [`../infra/README.md`](../infra/README.md) and the release checklist in [`11-local-release-handoff.md`](11-local-release-handoff.md).

### Re-authenticate Codex

```bash
docker compose stop app
./scripts/device-auth.sh
./scripts/deploy-local.sh
```

### OpenRouter deploy smoke

Paid external smokes are manual-only, explicit opt-in, and excluded from default CI. Local owner commands and the target-VPS forms are documented separately in [`11-local-release-handoff.md`](11-local-release-handoff.md) and [`../infra/README.md`](../infra/README.md). STT requires one non-empty final transcript from bounded WAV input and emits only safe aggregate evidence; TTS requires `2xx`, compatible `audio/mpeg`, and non-empty bytes. Neither is called by health checks or ordinary deployment.

### Inspect last booking events

```bash
docker compose logs app --since 30m | grep 'booking\.'
```

### Restore

Use `./scripts/restore.sh /data/backups/NAME.db`. The wrapper verifies the protected backup before stopping, verifies again after stop, migrates a temporary copy, atomically swaps it, restarts the app, requires `/health/ready`, and retains a protected pre-restore backup. For image rollback, use `scripts/rollback.sh` with an owner-retained immutable image reference; no RC4 predecessor image/tag is invented by this handoff.
