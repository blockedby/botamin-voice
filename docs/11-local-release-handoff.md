# 11. RC4 local release handoff

**Release label:** `0.5.0-local-rc.4`

**Recommended Git tag after owner acceptance:** `v0.5.0-local-rc.4`

**Tag state:** pending/recommendation only. No tag, PR, registry digest, or predecessor image is asserted by this handoff.

**Implementation baseline:** integrated RC4 code through `58aa9ee`, followed by recorded review-closure, integration-harness, and release-handoff commits on the candidate branch.

**Scope:** local hosting on one trusted machine. This is not target-VPS or public TLS/WSS acceptance.

## RC4 behavior being handed off

- one durable `conversation_contexts` JSON projection per conversation stores nonnegative revision, fact registry/provenance/bounded conflicts, exactly two current candidate identities, selected candidate, readiness, exact-revision confirmation, commit state, booking ID and matching timestamps;
- spoken and typed final turns use the same fact/scheduling/draft path; the structured form patches the same authoritative draft with expected revision and idempotent request ID rather than pretending to be visitor text;
- every scheduling offer contains exactly two 20-minute internal Moscow candidates with concrete dates/times; supported concrete date/time requests return the exact permitted start plus an alternative or the nearest two internal starts;
- a ready draft must be confirmed at its exact current revision; server orchestration then automatically commits one booking and publishes one server-derived `internal_virtual`/`scheduled` meeting projection;
- the final widget appears only after durable commit and states that no external calendar event or invitation exists;
- optional qualification starts directly after truthful meeting confirmation and asks only missing facts: volume first when neither is known, only the other field when one is known, and nothing when both are known;
- TTS redacts contacts by default. The only exception is an exact server-approved contact from accepted durable draft facts or a committed booking while contact-processing consent is active.

No duplicate meeting table, external availability query, calendar event/invite, or CRM record is introduced.

## Evidence status

Fresh RC4 results are recorded in [`../VALIDATION.md`](../VALIDATION.md). The RC3 report is preserved separately as historical evidence; it does not close RC4 gates.

- Chromium desktop/mobile Playwright **landing smoke** passed through the shared harness. It covers responsive/pre-consent boundaries, not a full voice booking journey.
- Fixture-only eval baseline is 44/44 scenarios, 25/25 applicable booking-order checks, and 28/28 negative controls with zero provider calls; real Luna was not run.
- Migration/cutover wrappers and RC3→RC4 schema compatibility are covered by deterministic tests.
- The provider-independent repository suite is green: 687 tests across 67 files; exact evidence is in `VALIDATION.md`.
- WebKit full journey is not run. Its browser binary is present, but this host lacks `libicu74`, `libxml2`, and `libflite1`.
- Full voice booking, owner-configured live Compose cutover, target VPS, public TLS/WSS, and target-host provider live booking remain explicit gates.

The committed [T30 owner-observed artifact](../evidence/T30-observed-local-voice-smoke-2026-07-31.md) and the preserved RC3 report remain historical evidence only.

## Prerequisites and secure bootstrap

- Bun `1.3.14` for repository checks and host smoke tooling.
- Docker Engine and Docker Compose v2 for the supported local runtime.
- `ffmpeg` only for the explicit integrated voice smoke.
- Paid OpenRouter access and authorized Codex subscription for real voice use.

```bash
cp .env.example .env
chmod 600 .env
# Put the one backend-only OPENROUTER_API_KEY in .env; never source this file.

./scripts/device-auth.sh
./scripts/deploy-local.sh
curl -fsS http://localhost:5173/health/ready
```

Open <http://localhost:5173>. Device auth persists in the fixed `botamin-codex-home` volume. Protect Docker access and disk; ordinary DB backups do not include Codex auth.

`deploy-local.sh` does not change `.env`. It atomically materializes mode-`0600` file secrets, renders/scans Compose config, and builds the image. For an existing DB it creates a protected backup before schema mutation. A running app is then gracefully stopped with a 30-second timeout; a stopped existing DB is backed up through a no-migration one-off container. The replacement starts with `AUTO_MIGRATE=true`, so migrations run through the normal entrypoint before the server. Success requires bounded readiness followed by the PII-safe RC4 invariant check.

## Health and durable invariant checks

```bash
docker compose ps
curl -fsS http://localhost:5173/health/live
curl -fsS http://localhost:5173/health/ready
docker compose exec -T app bun /app/ops/db.js verify-rc4
```

`verify-rc4` checks SQLite integrity, exact `conversation_contexts` columns and cascade FK, migration check constraints, persisted JSON/revision/timestamp consistency, foreign keys, and absence of duplicate fact/evidence/virtual-meeting tables. It prints no row values.

Safe aggregate metrics remain loopback-only:

```bash
docker compose exec -T app bun -e \
  "const r=await fetch('http://127.0.0.1:3000/metrics');if(!r.ok)process.exit(1);console.log(await r.text())"
```

## Migration 0004 and rollback boundary

`0004_conversation_contexts.sql` adds one empty context table to an RC3 database. It does not rewrite existing conversations/bookings, invent fact history, or create a separate virtual-meeting table. New/resumed RC4 sessions initialize their own durable draft through normal server behavior.

Migrations are forward-only. Do not reverse `0004` in place. Image-only rollback is acceptable only after the owner proves the older image tolerates the forward schema. Otherwise stop the app and restore the matching protected pre-cutover backup. This handoff does not invent an immutable previous image name; supply an owner-retained image reference explicitly.

```bash
# Online backup while app is running
./scripts/backup.sh
./scripts/backup.sh /data/backups/before-rc4.db

# Verified atomic restore; requires readiness before success
./scripts/restore.sh /data/backups/before-rc4.db

# Owner supplies a real retained immutable image reference.
PREVIOUS_IMAGE=registry.example.invalid/botamin@sha256:OWNER_RETAINED_DIGEST
./scripts/rollback.sh "$PREVIOUS_IMAGE" /data/backups/before-rc4.db
```

The placeholder above is not a real image. Never use `docker compose down -v`. Keep each `.db` with its mode-`0600` `.sha256` sidecar. Repository wrappers checksum/protect backups but do not encrypt or automatically expire them; encrypted snapshots, retention, RPO/RTO, and restore drills are host-owner duties.

## Paid smokes: explicit opt-in only

Deployment, tests, readiness, and schema verification do not spend provider usage. Static greeting regeneration is administrator-only and overwrites a tracked asset, so inspect it before commit:

```bash
BOTAMIN_GENERATE_PROACTIVE_GREETING=1 \
  bun run scripts/generate-proactive-greeting.ts
```

Against an already-ready local server, an owner may deliberately run the integrated voice smoke:

```bash
BOTAMIN_EXTERNAL_VOICE_E2E=1 bun run scripts/local-voice-e2e-smoke.ts \
  --server-url http://localhost:5173 \
  --origin http://localhost:5173 \
  --fixture-turns 1
```

This is not a browser full journey and does not close WebKit or target-host gates. Isolated paid image probes likewise require explicit approval:

```bash
compose_secret_operation=paid-smoke
. ./scripts/compose-secret-files.sh
docker compose run --rm -e AUTO_MIGRATE=false app /app/scripts/run-openrouter-smoke.sh stt
docker compose run --rm -e AUTO_MIGRATE=false app /app/scripts/run-openrouter-smoke.sh tts
```

## Explicit remaining gates

- WebKit complete-MP3 and full voice booking journey after installing `libicu74`, `libxml2`, and `libflite1` on a compatible host.
- Full Chromium voice booking journey; desktop/mobile landing smoke is not sufficient.
- Owner-configured live local Compose cutover/restore drill with retained backup path.
- Clean target-VPS deploy and resource behavior.
- Public DNS, TLS, and WSS.
- Explicitly approved target-host OpenRouter STT/TTS + Codex Luna live booking through final widget.
- Target-host latency/load profile and owner review of provider rates, model availability, subscription capacity, privacy copy, backup encryption/retention, and commercial operation.
