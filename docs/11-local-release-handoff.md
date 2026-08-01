# 11. Local release candidate and handoff

**Release label:** `0.5.0-local-rc.1`

**Recommended Git tag after owner acceptance:** `v0.5.0-local-rc.1`

**Tag state:** recommendation only; no tag is created or pushed by T40.

**Scope:** local hosting on one trusted machine. This is not a target-VPS or public TLS release.

## Local P0 checklist

- [x] Integrated implementation baseline is current through PRs #6–#21.
- [x] Fresh deterministic release-commit suite passed 433 tests across 54 files with 0 failures and 3,788 assertions before and after `bun run build`.
- [x] Typecheck, lint/format, build, deterministic spec generation, validator, and the current 317-file checksum set passed.
- [x] The committed [T30 owner-observed artifact](../evidence/T30-observed-local-voice-smoke-2026-07-31.md) records a real local OpenRouter/Luna one-turn path and a five-turn path with exactly one booked row and one sent outbox event.
- [x] `scripts/deploy-local.sh` was observed succeeding with mode-`0600` materialized files mounted read-only; app and Caddy were healthy and dependency readiness reported all checks ready.
- [x] Chrome desktop/mobile acceptance was observed for landing, consent, microphone-permission denial, safe denied state, no fetch/WebSocket before microphone permission, and no horizontal overflow.
- [x] The local URL, file-backed secret workflow, device auth, readiness, metrics, recovery, and paid opt-in boundaries are documented below.
- [ ] WebKit playback and complete journey acceptance — later gate, unobserved.
- [ ] Target VPS deploy, DNS, TLS/WSS, and target-host paid smokes — later gate, unobserved.

The checked runtime/browser lines are observed handoff evidence, not claims that this T40 documentation pass repeated provider spending or cross-browser testing. Fresh credential-free checks for the release commit are recorded in [`VALIDATION.md`](../VALIDATION.md).

## Prerequisites and secure bootstrap

- Bun `1.3.14` for repository checks and host smoke tooling.
- Docker Engine and Docker Compose v2 for the supported local runtime.
- `ffmpeg` on `PATH` only for `scripts/local-voice-e2e-smoke.ts`; ordinary deployment does not need host decoding.
- A paid OpenRouter account/key and an authorized Codex subscription for real voice use.

```bash
cp .env.example .env
chmod 600 .env
# Put the one backend-only OPENROUTER_API_KEY in .env; never source this file.

./scripts/device-auth.sh
./scripts/deploy-local.sh
curl -fsS http://localhost:5173/health/ready
```

Open <http://localhost:5173>. Device auth is interactive and persists in the fixed `botamin-codex-home` Docker volume. Protect Docker access and the underlying disk; do not include Codex `auth.json` in ordinary backups. The `CODEX_HOME` value in `.env` is for direct host Bun operation; Compose uses `/codex-home` backed by that named volume.

`deploy-local.sh` parses `.env` without shell evaluation, atomically materializes `.runtime/secrets` as directory mode `0700` and files mode `0600`, exports only the `*_FILE` paths, builds, migrates, force-recreates the app, starts Caddy, and waits for readiness. The files are mounted under `/run/secrets`; key values are not build args or browser configuration.

## Health, readiness, and metrics

```bash
docker compose ps
curl -fsS http://localhost:5173/health/live
curl -fsS http://localhost:5173/health/ready

# Safe aggregate metrics are intentionally direct-loopback only.
docker compose exec -T app bun -e \
  "const r=await fetch('http://127.0.0.1:3000/metrics');if(!r.ok)process.exit(1);console.log(await r.text())"
```

Caddy/public access to `/metrics` is denied. Readiness is dependency-aware and may return `503` for Codex auth/model, DB, prompt, voice configuration, capacity, or worker failures; health checks never spend OpenRouter usage.

## Paid smokes: explicit opt-in only

Deployment, tests, health checks, and this release procedure do not call paid providers. Against an already-ready local server, an owner may deliberately run the integrated smoke; it spends OpenRouter STT/TTS and Codex subscription usage:

```bash
BOTAMIN_EXTERNAL_VOICE_E2E=1 bun run scripts/local-voice-e2e-smoke.ts \
  --server-url http://localhost:5173 \
  --origin http://localhost:5173 \
  --fixture-turns 1
```

`ffmpeg` is mandatory for this non-browser decoder check. Use real bounded PCM files rather than `--fixture-turns` when synthetic input is not appropriate. Isolated STT/TTS image probes are also paid; export the deployed file paths first and run them only with explicit approval:

```bash
compose_secret_operation=paid-smoke
. ./scripts/compose-secret-files.sh
docker compose run --rm -e AUTO_MIGRATE=false app /app/scripts/run-openrouter-smoke.sh stt
docker compose run --rm -e AUTO_MIGRATE=false app /app/scripts/run-openrouter-smoke.sh tts
```

## Backup, restore, rotation, stop, and rollback

```bash
# Online SQLite VACUUM INTO backup plus protected checksum sidecar
./scripts/backup.sh
./scripts/backup.sh /data/backups/before-release.db

# Restore verifies permissions, checksum, integrity, migration, and readiness
./scripts/restore.sh /data/backups/before-release.db

# Stop while retaining named volumes
docker compose stop
# Remove containers/network while retaining named volumes
docker compose down

# Roll back to an existing/pullable immutable image, optionally with its DB backup
PREVIOUS_IMAGE=botamin-voice:0.5.0-local-rc.1-previoussha
./scripts/rollback.sh "$PREVIOUS_IMAGE"
./scripts/rollback.sh "$PREVIOUS_IMAGE" /data/backups/before-release.db
```

Never use `docker compose down -v`. SQLite migrations are forward-only; use the matching pre-release backup if an older image cannot read the current schema.

For OpenRouter/webhook key rotation: revoke or schedule revocation at the provider, replace the value in mode-`0600` `.env`, then rerun `./scripts/deploy-local.sh`. Its forced app recreation remounts the new secret inode. For Codex auth refresh, stop the app, rerun `./scripts/device-auth.sh`, then rerun `./scripts/deploy-local.sh`. Never print old/new values or copy auth into the repository.

## Known limitations and next gates

- STT is phrase-level and nonstreaming at the provider boundary: transcription starts after `audio.commit` and one complete bounded WAV.
- T30 local synthetic timings prove functional sequencing only; they are not a benchmark or target-host SLO.
- WebKit complete-MP3 playback and journey acceptance remain unobserved.
- Target VPS resource behavior, DNS, public TLS/WSS, and target-host provider smokes remain unobserved.
- The booking is an internal SQLite record plus notifier outbox event. No real calendar event, availability check, CRM record, or meeting invitation is created.
- OpenRouter model/voice availability, paid rates, Codex subscription limits, and plan suitability are runtime/owner checks, not release guarantees.
