# 06. Deployment, security и operations

## 1. Deployment topology

![Deployment](../diagrams/05-deployment.svg)

Один `docker-compose.yml`, два сервиса допустимы и рекомендуются:

1. `app` — Bun server, React static, Codex app-server child process, SQLite access.
2. `caddy` — TLS termination и WebSocket reverse proxy.

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

Не использовать floating `latest` для Codex в production. Версия CLI фиксируется, потому что app-server schemas version-specific.

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
- `.env`, xAI key, webhook secret, Codex auth не попадают в logs;
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
- STT speech-final latency;
- brain queue time, first delta, completion;
- TTS first audio and generated chars;
- speech-final → first playback;
- interrupted generation count;
- booking create/update success/error;
- notifier outbox lag;
- provider error/rate-limit counts;
- Codex auth age/status;
- SQLite file/WAL size.

Для дешёвой VPS P0 может писать metrics JSON в log. P1 — Prometheus endpoint или lightweight collector.

## 8. Health model

| Check | Live | Ready |
|---|---:|---:|
| Bun event loop/process | yes | yes |
| DB | no | read+write |
| prompts | no | checksum/parse |
| Codex process | no | handshake/model/auth |
| xAI | no | key/config; optional lightweight check |
| capacity | no | queue below threshold |
| notifier | no | outbox worker running; external outage не блокирует booking |

Notifier failure не должен делать app unready, если outbox сохраняет событие.

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
MAX_CONCURRENT_BRAIN_TURNS
MAX_PENDING_BRAIN_TURNS
SESSION_MAX_MINUTES
TURN_TIMEOUT_MS
```

При переполнении новая сессия получает `CAPACITY_EXCEEDED`; уже созданные booking updates имеют приоритет над новыми discovery turns.

## 11. Failure and degraded modes

| Failure | Поведение |
|---|---|
| Codex auth expired | readiness 503, admin alert; существующая booking не теряется |
| Luna quota/rate limit | очередь с коротким timeout; затем graceful user message |
| xAI STT down | остановить voice input, не придумывать transcript |
| xAI TTS down | показать text response; tool effects не повторять |
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
