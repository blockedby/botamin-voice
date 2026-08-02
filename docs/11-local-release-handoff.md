# 11. Local release candidate and handoff

**Release label:** `0.5.0-local-rc.3`

**Recommended Git tag after owner acceptance:** `v0.5.0-local-rc.3`

**Tag state:** recommendation only until the validated candidate is merged.

**Scope:** local hosting on one trusted machine. This is not a target-VPS or public TLS release.

## RC3 scope

- committed product-owned same-origin proactive MP3 attempts playback once immediately on entry, with no conversation REST/WS/mic/provider/session before consent; blocked/error fallback is `Включить приветствие`, and real session start stops it;
- explicit admin-only opt-in OpenRouter script generates the fixed no-visitor-data asset before commit; visitor runtime never synthesizes it;
- server always offers exactly two current internal Moscow candidates: default morning+evening, contextual typed/spoken Russian preference/rejection refresh, selected in-band roughly hour-apart pair with weekday rollover, and no exhaustive global-availability claim;
- after committed booking and confirmation, exact consent question `Можно задать два коротких вопроса?` gates deterministic monthly-leads-then-manager-count collection; both-at-once, skipped, and partial outcomes preserve booking.

## Local P0 candidate checklist

RC3 acceptance has not been run by this documentation-only change. Do not copy RC2 test/assertion/checksum counts or present historical browser/deploy/provider evidence as RC3 evidence.

- [ ] Run fresh credential-free tests and record actual counts/results.
- [ ] Run typecheck, lint/format checks, build, `scripts/build-spec.sh`, `scripts/validate-spec.py`, stale searches, and `git diff --check`; record exact results.
- [ ] Run local Chrome acceptance for greeting autoplay success and blocked/error fallback, zero pre-consent REST/WS/mic/provider/session, greeting stop at session start, typed/spoken contextual slots, and skipped/partial/complete qualification.
- [ ] Run `scripts/deploy-local.sh` from the final RC3 tree and record migration, app/Caddy health/readiness, limits, and file-secret evidence.
- [ ] Run any OpenRouter STT/TTS/Codex smoke only with explicit paid-use approval; record actual safe evidence or leave not run.
- [ ] Verify backup/restore/rollback readiness and preserve the immutable RC2 image shown below.
- [ ] Parent records final SHA, counts, browser/deploy/provider observations, and release result in [`../VALIDATION.md`](../VALIDATION.md), then updates `MANIFEST.txt` and `CHECKSUMS.sha256` separately.
- [ ] WebKit playback and complete journey acceptance — later gate unless explicitly run and recorded.
- [ ] Target VPS deploy, DNS, TLS/WSS, and target-host paid smokes — later gate.

The committed [T30 owner-observed artifact](../evidence/T30-observed-local-voice-smoke-2026-07-31.md) remains historical evidence only; it does not close RC3 acceptance.

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

Deployment, tests, health checks, and this release procedure do not call paid providers. The proactive asset is regenerated only by an administrator's explicit paid opt-in; this command overwrites the tracked static MP3 from fixed product copy, never visitor data, so inspect the result before committing:

```bash
BOTAMIN_GENERATE_PROACTIVE_GREETING=1 \
  bun run scripts/generate-proactive-greeting.ts
```

This is not a deploy/startup/visitor command. Against an already-ready local server, an owner may deliberately run the integrated smoke; it spends OpenRouter STT/TTS and Codex subscription usage:

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

# Keep RC2 as the existing/pullable immutable rollback image for RC3.
# Use the exact immutable registry reference/digest retained by the owner if available.
PREVIOUS_IMAGE=botamin-voice:0.5.0-local-rc.2
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
- The proactive greeting is a committed static product MP3. Browser autoplay remains policy-dependent; failure must leave the explicit `Включить приветствие` control. Regeneration is paid/admin-only and not a visitor-runtime action.
- The booking is an internal SQLite record plus notifier outbox event. The scheduler always returns two current alternatives, not all global availability; it excludes committed starts, but no real calendar event, external availability check, CRM record, or meeting invitation is created.
- Optional qualification is complete only with both monthly inbound leads and integer sales-manager count. Skip/partial/failure never removes the booking.
- OpenRouter model/voice availability, paid rates, Codex subscription limits, and plan suitability are runtime/owner checks, not release guarantees.
