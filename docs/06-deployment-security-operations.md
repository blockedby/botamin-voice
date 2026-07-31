# 06. Deployment, security и operations

## 1. Deployment topology

![Deployment](../diagrams/05-deployment.svg)

Один `docker-compose.yml`, ровно два application-path сервиса рекомендуются:

1. `app` — Bun server, React static, Codex app-server child process, SQLite access и native HTTPS `fetch` к OpenRouter.
2. `caddy` — TLS termination и WebSocket reverse proxy.

Отдельного voice runtime/container нет. OpenRouter вызывается напрямую из `app` по HTTPS для atomic STT chat completions и complete-segment TTS; один runtime-only key авторизует оба.

Persistent volumes:

- `app-data:/data` — SQLite и backups;
- `codex-home:/codex-home` — `auth.json`, Codex thread/session metadata.

## 2. Compose requirements

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - app-data:/data
      - codex-home:/codex-home
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health/live"]
      interval: 15s
      timeout: 3s
      retries: 5
    expose: ["3000"]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./infra/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    depends_on:
      app:
        condition: service_healthy
```

Это ориентир; финальный compose должен pin-ить image/tool versions.

## 3. Docker image

Multi-stage:

1. build frontend;
2. install server production deps;
3. install pinned Codex CLI binary/version;
4. generate Codex TS/JSON schemas при build или CI;
5. compile prompt bundle в isolated `/app/runtime-brain/AGENTS.md`;
6. runtime image содержит только production assets, migrations, source Markdown prompts и compiled safe runtime bundle.

Не использовать floating `latest` для Codex в production. Версия CLI фиксируется, потому что app-server schemas version-specific. `OPENROUTER_API_KEY` inject-ится только runtime secret/env и отсутствует в build args, layers, image history и rendered Compose evidence.

## 4. Codex subscription auth на VPS

### Bootstrap

После первого deploy:

```bash
docker compose run --rm app codex login --device-auth
docker compose run --rm app codex login status
```

`CODEX_HOME=/codex-home` должен указывать на persistent volume.

### Preflight

Deployment script делает:

1. `codex login status`;
2. старт app-server и handshake;
3. `model/list`, проверка `gpt-5.6-luna`;
4. `thread/start` в `CODEX_CWD` и проверка `instructionSources` на compiled `AGENTS.md`;
5. короткий synthetic turn;
6. проверка `turn/interrupt`;
7. запись/чтение SQLite;
8. проверка prompt bundle checksum.

Если preflight не прошёл, `/health/ready` возвращает 503 и новые voice sessions не создаются.

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
- contact values доступны только booking payload и защищённому storage;
- `.env`, единственный OpenRouter key, webhook secret, Codex auth, WAV/base64 audio и transcript PII не попадают в logs;
- browser bundle и events не содержат OpenRouter key или direct provider URL;
- DB volume и backup с ограниченными permissions;
- privacy/consent copy перед микрофоном;
- deletion runbook по `conversationId`/`bookingId`;
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

P0 держит bounded process-local aggregates и отдаёт safe JSON через `GET /metrics` только прямому loopback peer; отсутствие peer evidence закрывает доступ, а Caddy/public/forwarded requests получают отказ. Snapshot не содержит IDs, model/voice names, text, contact, audio/base64, auth или provider error bodies. Точные milestone, p50/p95 и missing-sample semantics зафиксированы в `apps/server/src/observability/README.md`. Сохранённый operator snapshot можно проверить и агрегированно вывести через `bun run scripts/observability-report.ts SAFE_SNAPSHOT.json`; скрипт не читает production memory.

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

## 9. Backup and restore

- SQLite online backup или `VACUUM INTO`, не простой copy активного WAL-файла;
- ежедневный encrypted snapshot;
- retention configurable;
- регулярный restore test в временный файл;
- `codex-home` backup отдельно и только если необходим; auth backup шифруется;
- prompts восстанавливаются из Git/image;
- runbook фиксирует RPO/RTO после выбора хостинга.

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

### Deploy

```bash
git pull
docker compose build --pull
docker compose run --rm app bun run db:migrate
docker compose up -d
docker compose ps
curl -fsS https://HOST/health/ready
```

### Re-authenticate Codex

```bash
docker compose stop app
docker compose run --rm app codex login --device-auth
docker compose run --rm app codex login status
docker compose up -d app
```

### OpenRouter deploy smoke

After runtime secrets are installed on the target VPS:

```bash
docker compose run --rm app bun run scripts/openrouter-stt-smoke.ts
docker compose run --rm app bun run scripts/openrouter-tts-smoke.ts
```

Both external paid smokes are deploy/manual-only and excluded from default CI. STT uses a bounded Russian WAV fixture, requires one non-empty final transcript and prints only status/latency/byte counts/safe IDs—not audio or text. TTS writes MP3 outside the repository or to an ignored artifact path and requires `2xx`, `audio/mpeg` and non-empty bytes. Both fail safely for missing key and typed provider/config errors. Neither smoke is claimed by this documentation migration.

### Inspect last booking events

```bash
docker compose logs app --since 30m | grep 'booking\.'
```

### Restore

1. stop app;
2. verify backup checksum;
3. restore into a new DB path;
4. run integrity check and migrations;
5. point `DATABASE_URL` to restored file;
6. start and validate `/health/ready`;
7. retain old file until manual confirmation.
