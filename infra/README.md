# Local-first Docker and operations runbook

This is the single production-shaped Compose path for spec `0.4-demo`: one Bun
`app`, one pinned Caddy proxy, SQLite data, and persistent Codex auth. There is
no Python runtime, TTS sidecar, or provider key in the image.

## Pinned runtime

- Bun image: `oven/bun:1.3.14-alpine` pinned to the digest in `Dockerfile`.
- Codex CLI: `@openai/codex@0.146.0` (the build verifies `codex-cli 0.146.0`).
- Caddy: `2.10.2-alpine` pinned to the digest in `docker-compose.yml`.

The app runs as uid/gid `1000:1000`, with a read-only root filesystem and only
`/data`, `/codex-home`, `/tmp`, and the ephemeral prompt runtime writable.
Every start compiles the allowlisted Markdown into `/app/runtime/brain/AGENTS.md`
before migration or liveness. That brain directory contains only `AGENTS.md`.

## First local start (HTTP, no domain)

OpenRouter is intentionally blank locally, so startup logs a text-only fallback
warning and does not spend paid usage.

```bash
cp .env.example .env
chmod 600 .env
./scripts/deploy-local.sh
curl -fsS http://localhost:5173/health/live
```

Equivalent explicit commands are:

```bash
docker compose config >/tmp/botamin-compose-config.yml
docker compose build --pull
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
docker compose up -d
docker compose ps
curl -fsS http://localhost:5173/health/live
```

Caddy proxies WebSocket upgrades automatically. `docker compose down` preserves
all named volumes; never use `down -v` on a host containing real bookings or
Codex auth.

### Current integration boundary

At this branch point the server exposes `/health/live`, but does not yet expose
`/health/ready`, static frontend routes, the application WebSocket, Codex
preflight, or the A2-owned `scripts/openrouter-tts-smoke.ts`. The image,
migration, prompt, proxy, and liveness paths are directly testable. Production
readiness and the paid smoke must fail rather than be simulated until those
integration routes/scripts land.

## Secrets and Codex device auth

`.env` supplies secret values to Compose's runtime `secrets.environment`
mechanism. Compose mounts files under `/run/secrets`; the non-root entrypoint
exports them only into the app process. They are not Docker build arguments,
image layers, or rendered service environment values.

```bash
# Interactive and persisted in the fixed codex-home volume:
./scripts/device-auth.sh

# Non-interactive status check:
docker compose run --rm -e AUTO_MIGRATE=false app codex login status
```

`codex-home` uses the fixed Docker volume name `botamin-codex-home`, so auth
survives app replacement and Compose project renaming. Treat `auth.json` as a password. Do
not include it in ordinary backups. A production host should also encrypt the
underlying disk/snapshot and restrict Docker access.

To prove config rendering does not reveal a test token:

```bash
OPENROUTER_API_KEY=sentinel-openrouter-value \
  docker compose --env-file .env.example config >/tmp/compose.yml
! grep -F sentinel-openrouter-value /tmp/compose.yml
```

## Production HTTPS/WSS (later VPS phase)

Host assumptions: Linux x86_64, Docker Engine with Compose v2, DNS A/AAAA pointed
to the VPS, outbound HTTPS, and inbound TCP 80/443 plus UDP 443. In `.env`,
change the existing application values:

```dotenv
APP_ORIGIN=https://voice.example.com
OPENROUTER_HTTP_REFERER=https://voice.example.com
```

Fill backend-only `XAI_API_KEY` and `OPENROUTER_API_KEY`, then export operational
Compose controls (they are intentionally not application env) and deploy:

```bash
export SITE_ADDRESS=voice.example.com
export HTTP_PORT=80 HTTPS_PORT=443
export APP_IMAGE=botamin-voice:0.4-demo-<git-sha>
./scripts/device-auth.sh
./scripts/deploy-production.sh
```

Caddy obtains TLS automatically for `SITE_ADDRESS`; its `reverse_proxy` supports
HTTPS and WSS on the same origin. Production deployment checks
`/health/ready`, so it intentionally cannot pass while that application route
or Codex preflight is missing.

The external OpenRouter Russian MP3 smoke is paid and deploy/manual only:

```bash
RUN_OPENROUTER_SMOKE=true ./scripts/deploy-production.sh
# direct target-host form after A2 integration:
docker compose run --rm -e AUTO_MIGRATE=false app \
  bun run scripts/openrouter-tts-smoke.ts
```

Never run this in local startup, image build, healthchecks, or default CI.
`401` and `404` mean key/profile configuration failure; `402` means exhausted
credits. None should be retried by deployment loops. With
`TTS_TEXT_ONLY_FALLBACK=true`, the application reports degraded TTS while text
and booking continue; `false` makes missing TTS configuration fail closed.

## Migration, backup, restore, and rollback

Migrations run idempotently before normal startup when `AUTO_MIGRATE=true` and
are also available explicitly:

```bash
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
```

Backups use SQLite `VACUUM INTO`, not a raw copy of a live DB/WAL:

```bash
./scripts/backup.sh
# or choose an in-volume destination:
./scripts/backup.sh /data/backups/before-release.db
```

Restore stops the app, validates `PRAGMA integrity_check`, migrates a temporary
copy, atomically swaps it, and retains a consistent pre-restore rollback copy:

```bash
./scripts/restore.sh /data/backups/before-release.db
```

Rollback to an already built/pulled immutable app image, optionally with a DB
backup:

```bash
./scripts/rollback.sh botamin-voice:0.4-demo-<previous-sha>
./scripts/rollback.sh botamin-voice:0.4-demo-<previous-sha> \
  /data/backups/before-release.db
```

After a successful rollback, keep that `APP_IMAGE` exported in the host's
deployment wrapper. SQLite migrations are forward-only; use the matching
pre-release backup when the old image cannot read the new schema.

## Safe diagnostics

```bash
docker compose run --rm -e AUTO_MIGRATE=false app codex --version
docker compose run --rm -e AUTO_MIGRATE=false app id
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js permissions
docker compose exec -T app bun /app/ops/db.js integrity
docker compose logs --tail=100 app caddy
```

Logs and diagnostics must never print provider keys, Codex auth, spoken text,
raw audio, or booking contact payloads.
