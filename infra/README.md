# Local-first Docker and operations runbook

This is the single production-shaped Compose path for spec `0.5-demo`: one Bun
`app`, one pinned Caddy proxy, SQLite data, and persistent Codex auth. OpenRouter
is the only voice gateway: one runtime-only `OPENROUTER_API_KEY` authorizes both
phrase-level STT and complete-segment TTS. There is no second voice provider,
Python runtime, voice sidecar, or provider key in the image.

## Pinned runtime

- Bun image: `oven/bun:1.3.14-alpine` pinned to the digest in `Dockerfile`.
- Codex CLI: `@openai/codex@0.146.0` (the build verifies `codex-cli 0.146.0`).
- Caddy: `2.10.2-alpine` pinned to the digest in `docker-compose.yml`.

The app runs as uid/gid `1000:1000`, with a read-only root filesystem and only
`/data`, `/codex-home`, `/tmp`, and the ephemeral prompt runtime writable.
Every start compiles the allowlisted Markdown into `/app/runtime/brain/AGENTS.md`
before migration or liveness. That brain directory contains only `AGENTS.md`.

## First local start (HTTP, no domain)

The deployment wrappers require a nonblank OpenRouter key. Raw unconfigured
`docker compose config` remains valid because every secret source defaults to
`/dev/null`; a raw start is intentionally degraded and `/health/ready` stays
unready rather than receiving a hidden credential. `CODEX_TOOL_MODE=envelope`
is the safe default because environment-only app wiring cannot inject the
awaited backend executor required by A3 dynamic mode.

```bash
cp .env.example .env
chmod 600 .env
# Fill OPENROUTER_API_KEY without sourcing .env.
./scripts/deploy-local.sh
curl -fsS http://localhost:5173/health/live
```

Equivalent explicit commands are:

```bash
bun scripts/materialize-compose-secrets.ts
secret_dir="$(pwd -P)/.runtime/secrets"
export OPENROUTER_API_KEY_FILE="$secret_dir/openrouter_api_key"
export WEBHOOK_URL_FILE="$secret_dir/webhook_url"
export WEBHOOK_SIGNING_SECRET_FILE="$secret_dir/webhook_signing_secret"
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
preflight, or the A2-owned `scripts/openrouter-stt-smoke.ts` and
`scripts/openrouter-tts-smoke.ts`. The Docker build copies repository scripts
and conditionally bundles either provider smoke entrypoint when its source is
present. `scripts/assert-image-content.sh` proves required runtime files are in
the image and compares provider-smoke presence with the checkout. Until A2
lands, `/app/scripts/run-openrouter-smoke.sh stt|tts` fails explicitly with a
missing-integration error; it cannot return false success or raw `ENOENT`.
Production readiness and paid smokes must fail rather than be simulated until
their integration routes/scripts land.

## Secrets and Codex device auth

`scripts/materialize-compose-secrets.ts` parses `.env` as dotenv data (never as
shell), requires a nonblank OpenRouter key by default, rejects linked/unsafe
paths, and atomically writes the three persistent sources under
`.runtime/secrets` with directory mode `0700` and file mode `0600`. Compose
mounts those files under `/run/secrets`; the non-root entrypoint exports values
only into the app process. Values are not build arguments, image layers,
rendered service environment, or script output. Deployment wrappers export all
three `*_FILE` paths for every Compose command and do not delete these files.
For later manual Compose commands, export the same paths shown in the explicit
local commands above; never `source .env` (dotenv values may contain spaces).

```bash
# Interactive and persisted in the fixed codex-home volume; provider key may be blank:
./scripts/device-auth.sh

# Non-interactive status check after exporting the three *_FILE paths:
docker compose run --rm -e AUTO_MIGRATE=false app codex login status
```

`codex-home` uses the fixed Docker volume name `botamin-codex-home`, so auth
survives app replacement and Compose project renaming. Treat `auth.json` as a password. Do
not include it in ordinary backups. A production host should also encrypt the
underlying disk/snapshot and restrict Docker access.

The focused Bun tests prove dotenv parsing, permissions, symlink and blank-key
policy, output redaction, and rendered file sources. The engine smoke proves
secret creation succeeds with `read_only: true` after the app image is built:

```bash
bun test tests/contracts/materialize-compose-secrets.test.ts
./scripts/test-compose-file-secrets.sh
```

## Production HTTPS/WSS (later VPS phase)

Host assumptions: Linux x86_64, Docker Engine with Compose v2, DNS A/AAAA pointed
to the VPS, outbound HTTPS, and inbound TCP 80/443 plus UDP 443. In `.env`,
change the existing application values:

```dotenv
APP_ORIGIN=https://voice.example.com
OPENROUTER_HTTP_REFERER=https://voice.example.com
```

Fill the one backend-only `OPENROUTER_API_KEY` in mode-`0600` `.env`, then
export operational Compose controls (they are intentionally not application
env) and deploy. The deployment script materializes and exports file sources:

```bash
export SITE_ADDRESS=voice.example.com
export HTTP_PORT=80 HTTPS_PORT=443
export APP_IMAGE=botamin-voice:0.5-demo-<git-sha>
./scripts/device-auth.sh
./scripts/deploy-production.sh
```

Caddy obtains TLS automatically for `SITE_ADDRESS`; its `reverse_proxy` supports
HTTPS and WSS on the same origin. Production deployment checks
`/health/ready`, so it intentionally cannot pass while that application route
or Codex preflight is missing. Public DNS/TLS, persisted device auth, provider
credits, and paid probes remain target-VPS follow-up evidence (REV-005); local
checks do not claim them.

The external Russian STT and MP3 TTS smokes are separately paid and
separately opt-in on the target VPS:

```bash
RUN_OPENROUTER_STT_SMOKE=true ./scripts/deploy-production.sh
RUN_OPENROUTER_TTS_SMOKE=true ./scripts/deploy-production.sh
# Run both only after both paid probes are explicitly approved:
RUN_OPENROUTER_STT_SMOKE=true RUN_OPENROUTER_TTS_SMOKE=true \
  ./scripts/deploy-production.sh

# direct image forms after A2 integration:
docker compose run --rm -e AUTO_MIGRATE=false app \
  /app/scripts/run-openrouter-smoke.sh stt
docker compose run --rm -e AUTO_MIGRATE=false app \
  /app/scripts/run-openrouter-smoke.sh tts
```

The guarded image commands execute `/app/scripts/openrouter-stt-smoke.ts` and
`/app/scripts/openrouter-tts-smoke.ts`, respectively. Never run either paid
probe in local startup, image build, healthchecks, or default CI. No script
prints the key. `401` and `404` mean key/model/profile configuration failure;
`402` means exhausted credits. None should be retried by deployment loops.
With `TTS_TEXT_ONLY_FALLBACK=true`, the application reports degraded TTS while
text and booking continue; `false` makes missing shared voice configuration
fail closed. `STT_TEXT_ONLY_INPUT_FALLBACK=false` always prevents silent typed
input substitution after transcription failure.

## Migration, backup, restore, and rollback

Migrations run idempotently before normal startup when `AUTO_MIGRATE=true` and
are also available explicitly:

```bash
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
```

Backups use SQLite `VACUUM INTO`, not a raw copy of a live DB/WAL, and write a
mode-`0600` `<backup>.sha256` sidecar bound to the backup basename. Backup,
restore, and rollback require the persistent `.runtime/secrets` files created
by a successful deployment; their wrappers validate and export those sources:

```bash
./scripts/backup.sh
# or choose an in-volume destination:
./scripts/backup.sh /data/backups/before-release.db
```

Keep each `.db` and `.db.sha256` together. Restore verifies sidecar permissions,
SHA-256, and `PRAGMA integrity_check` before stopping the app, verifies again
after stop, migrates a temporary copy, atomically swaps it, and retains a
protected pre-restore rollback backup. It reports success only after the app
passes bounded `/health/ready` checks:

```bash
./scripts/restore.sh /data/backups/before-release.db
```

Rollback to an already built/pulled immutable app image, optionally with a DB
backup:

```bash
./scripts/rollback.sh botamin-voice:0.5-demo-<previous-sha>
./scripts/rollback.sh botamin-voice:0.5-demo-<previous-sha> \
  /data/backups/before-release.db
```

Restore and rollback reject live-but-unready responses and use bounded request,
retry, and interval settings. After a successful rollback, keep that `APP_IMAGE`
exported in the host's deployment wrapper. SQLite migrations are forward-only;
use the matching pre-release backup when the old image cannot read the new
schema.

## Safe diagnostics

```bash
docker compose run --rm -e AUTO_MIGRATE=false app codex --version
docker compose run --rm -e AUTO_MIGRATE=false app id
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js permissions
docker compose exec -T app bun /app/ops/db.js integrity
# Loopback-only safe aggregate snapshot; public/Caddy requests are denied.
docker compose exec -T app bun -e \
  "const r=await fetch('http://127.0.0.1:3000/metrics');if(!r.ok)process.exit(1);console.log(await r.text())"
scripts/assert-image-content.sh "${APP_IMAGE:-botamin-voice:local}"
docker compose logs --tail=100 app caddy
```

Logs and diagnostics must never print provider keys, Codex auth, spoken text,
raw audio, or booking contact payloads.
