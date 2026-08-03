# Local-first Docker and operations runbook

This is the single production-shaped Compose path for spec `0.5-demo`: one Bun
`app`, one pinned Caddy proxy, SQLite data, and persistent Codex auth. OpenRouter
is the only voice gateway: one runtime-only `OPENROUTER_API_KEY` authorizes both
phrase-level STT and complete-segment TTS. Default output remains exact
xAI/eve/MP3; Gemini 3.1 Flash TTS Preview is an explicit four-env PCM profile,
not a second gateway or fallback. There is no second voice provider, Python
runtime, voice sidecar, or provider key in the image.

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
awaited backend executor required by A3 dynamic mode. Codex stays on
`gpt-5.6-luna` with exact reasoning effort `low`; missing defaults to `low`,
and every non-`low` value is rejected before the Codex process starts for
standard and priority. Luna does not support disabled reasoning. Leave
`CODEX_SERVICE_TIER=` empty for portable standard service, or let the local
subscription owner set exact `priority`. Pinned Codex CLI 0.146.0 advertises
priority as Fast/1.5x speed with increased subscription usage; it has no latency
SLA. Startup and readiness reject unsupported values or an exact Luna catalog
entry that does not advertise priority.

```bash
cp .env.example .env
chmod 600 .env
# Fill OPENROUTER_API_KEY without sourcing .env.
./scripts/deploy-local.sh
curl -fsS http://localhost:5173/health/ready
```

Do not replace the wrapper with an ad-hoc one-off migration. For an existing database it first takes a protected backup, gracefully stops the live app, then starts the replacement with `AUTO_MIGRATE=true` so the normal entrypoint applies migrations before the server. After dependency readiness it runs:

```bash
docker compose exec -T app bun /app/ops/db.js verify-rc4
```

That check is PII-safe and verifies SQLite integrity, exact RC4 context columns/FK/check constraints, persisted JSON revision/timestamp consistency, foreign keys, and absence of duplicate fact/evidence/virtual-meeting tables.

The default `.env.example` profile is `xai_mp3` / `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`. Browser dynamic playback is provider-neutral and bounded; output `AudioContext` is owned by the consent gesture. The 16 committed same-origin reaction assets are Sulafat canonical mono PCM16LE 24 kHz WAVs, make zero runtime provider calls, and should not be regenerated during deployment.

Caddy proxies WebSocket upgrades automatically. `docker compose down` preserves
all named volumes; never use `down -v` on a host containing real bookings or
Codex auth.

### Current integration boundary

The server exposes distinct `/health/live` and dependency-aware `/health/ready`
routes. The Docker build copies repository scripts and conditionally bundles
provider smoke entrypoints when their sources are present.
`scripts/assert-image-content.sh` proves required runtime files are in the image
and compares provider-smoke presence with the checkout. A missing paid-smoke
integration fails explicitly; it cannot return false success or raw `ENOENT`.

## Secrets and Codex device auth

`scripts/materialize-compose-secrets.ts` parses `.env` as dotenv data (never as
shell), requires a nonblank OpenRouter key by default, rejects linked/unsafe
paths, and atomically writes the three persistent sources under
`.runtime/secrets` with directory mode `0700` and file mode `0600`. Compose
mounts those files under `/run/secrets`; after every materialization the
deployment wrappers force-recreate only `app`, then start or update Caddy only
if needed and require readiness. The non-root entrypoint exports values only
into the app process. Values are not build arguments, image layers, rendered
service environment, or script output. Deployment wrappers export all three
`*_FILE` paths for every Compose command and do not delete these files.
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

The focused Bun tests prove Compose-compatible dotenv parsing, permissions,
symlink and blank-key policy, output redaction, wrapper ordering, and rendered
file sources. The engine smoke atomically rotates a source inode/value and
proves wrapper-style app recreation remounts it in a disposable `read_only`
service without logging either value:

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

The external Russian STT and TTS smokes are separately paid and separately
opt-in on the target VPS:

```bash
RUN_OPENROUTER_STT_SMOKE=true ./scripts/deploy-production.sh
RUN_OPENROUTER_TTS_SMOKE=true ./scripts/deploy-production.sh
# Run both only after both paid probes are explicitly approved:
RUN_OPENROUTER_STT_SMOKE=true RUN_OPENROUTER_TTS_SMOKE=true \
  ./scripts/deploy-production.sh

# direct image forms after A2 integration:
docker compose run --rm -e AUTO_MIGRATE=false -e OPENROUTER_EXTERNAL_SMOKE=1 app \
  /app/scripts/run-openrouter-smoke.sh stt
docker compose run --rm -e AUTO_MIGRATE=false -e OPENROUTER_EXTERNAL_SMOKE=1 app \
  /app/scripts/run-openrouter-smoke.sh tts
```

The guarded image commands execute `/app/scripts/openrouter-stt-smoke.ts` and
`/app/scripts/openrouter-tts-smoke.ts`, respectively. Never run either paid
probe in local startup, image build, healthchecks, or default CI. No script
prints the key. `401` and `404` mean key/model/profile configuration failure;
`402` means exhausted credits. None should be retried by deployment loops.

For the Gemini Preview profile, change all four application values together in
protected `.env`; voice is case-sensitive and `OPENROUTER_TTS_SPEED` must remain
empty/unset:

```dotenv
OPENROUTER_TTS_PROFILE=gemini_3_1_pcm
OPENROUTER_TTS_MODEL=google/gemini-3.1-flash-tts-preview
OPENROUTER_TTS_VOICE=Schedar
OPENROUTER_TTS_RESPONSE_FORMAT=pcm
```

The exact 30-voice release snapshot is in [`../CURRENT_DECISIONS.md`](../CURRENT_DECISIONS.md).
The public catalog is dynamic; profile mismatch fails closed and there is no
automatic model/voice selection or xAI fallback. OpenRouter PCM is wrapped
server-side as canonical complete mono 24 kHz PCM16 WAV; browser never receives
raw PCM. On this host on 2026-08-03, the Schedar neutral smoke succeeded through
OpenRouter: `audio/wav`, 188204 bytes, 3326ms. This is not a quality claim.
Restore the default profile to roll back:

```dotenv
OPENROUTER_TTS_PROFILE=xai_mp3
OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
```
With `TTS_TEXT_ONLY_FALLBACK=true`, the application reports degraded TTS while
text and booking continue; `false` makes missing shared voice configuration
fail closed. `STT_TEXT_ONLY_INPUT_FALLBACK=false` always prevents silent typed
input substitution after transcription failure.

## Migration, backup, restore, and rollback

Migrations run idempotently before normal startup when `AUTO_MIGRATE=true`. The supported local cutover never runs a schema migration while the old app can write: it backs up first, drains/stops the app, and lets normal replacement startup migrate. The explicit `db.js migrate` command is reserved for an already-stopped/offline database and must not be used against a live app.

RC4 migration `0004` adds only `conversation_contexts`; it does not backfill RC3 conversations, alter existing bookings, or create separate fact/evidence/meeting tables. `verify-rc4` must pass after startup.

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
exported in the host's deployment wrapper. SQLite migrations are forward-only. `0004` is additive, but no general downgrade compatibility is promised. Use the matching pre-cutover backup when an older image cannot read the forward schema; do not reverse the migration in place.

## Safe diagnostics

```bash
docker compose run --rm -e AUTO_MIGRATE=false app codex --version
docker compose run --rm -e AUTO_MIGRATE=false app id
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js permissions
docker compose exec -T app bun /app/ops/db.js integrity
docker compose exec -T app bun /app/ops/db.js verify-rc4
# Loopback-only safe aggregate snapshot; public/Caddy requests are denied.
docker compose exec -T app bun -e \
  "const r=await fetch('http://127.0.0.1:3000/metrics');if(!r.ok)process.exit(1);console.log(await r.text())"
scripts/assert-image-content.sh "${APP_IMAGE:-botamin-voice:local}"
docker compose logs --tail=100 app caddy
```

Logs and diagnostics must never print provider keys, Codex auth, spoken text,
delivery tags, raw PCM/audio, or booking contact payloads.
