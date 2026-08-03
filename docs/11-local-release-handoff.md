# 11. RC4 local release handoff

**Release label:** `0.5.0-local-rc.4`

**Recommended Git tag after owner acceptance:** `v0.5.0-local-rc.4`

**Tag state:** pending/recommendation only. No tag, PR, registry digest, or predecessor image is asserted by this handoff.

**Executable natural-voice implementation through:** `ac965d0`; the following documentation/evidence commit is intentionally separate. The PR merge commit/tag will be the final release identity.

**Scope:** local hosting on one trusted machine. This is not target-VPS or public TLS/WSS acceptance.

## RC4 behavior being handed off

- one durable `conversation_contexts` JSON projection per conversation stores nonnegative revision, fact registry/provenance/bounded conflicts, exactly two current candidate identities, selected candidate, readiness, exact-revision confirmation, commit state, booking ID and matching timestamps;
- spoken and typed final turns use the same fact/scheduling/draft path; the structured form patches the same authoritative draft with expected revision and idempotent request ID rather than pretending to be visitor text;
- every scheduling offer contains exactly two 20-minute internal Moscow candidates with concrete dates/times; supported concrete date/time requests return the exact permitted start plus an alternative or the nearest two internal starts;
- a ready draft must be confirmed at its exact current revision; server orchestration then automatically commits one booking and publishes one server-derived `internal_virtual`/`scheduled` meeting projection;
- the final widget appears only after durable commit and states that no external calendar event or invitation exists;
- optional qualification starts directly after truthful meeting confirmation and asks only missing facts: volume first when neither is known, only the other field when one is known, and nothing when both are known;
- TTS redacts contacts by default. The only exception is an exact server-approved contact from accepted durable draft facts or a committed booking while contact-processing consent is active;
- ordinary speech is concise/natural; current + one ordered TTS prefetch feeds provider-neutral complete MP3/WAV rendering, gapless scheduled playback, and a four-segment/20 MB credit window with at most two decoded;
- output `AudioContext` is created/resumed in the consent gesture before mic/network awaits;
- a 16-clip same-origin reaction corpus is capability/stage/privacy gated and delayed 350 ms. Current runtime exposes only the non-claiming neutral clip; claim-bearing progress clips require a future explicit trusted server operation signal. Runtime provider calls for reactions are zero, and they have no transcript/state/provider/business effect;
- default TTS remains exact xAI/eve/MP3. Gemini is an explicit four-env Preview profile; provider PCM is wrapped server-side as canonical complete WAV, and style is fixed server-owned neutral/curious/serious/excited with sensitive facts always neutral and visible transcript plain.

No duplicate meeting table, external availability query, calendar event/invite, or CRM record is introduced.

## Evidence status

Pre-closure implementation evidence after Gemini production wiring and v2 protocol compatibility closure (not final review closure and allowed to change after review):

- provider-independent suite: **815 passed, 0 failed across 72 files, 16,910 assertions**;
- Chromium desktop/mobile Playwright **landing smoke: 2/2 passed**. It covers responsive/pre-consent boundaries, not a full voice booking journey;
- fixture/eval paths are credential-free with zero provider calls; this docs handoff does not claim a fresh fixture recount or real-Luna run;
- deterministic coverage includes natural prompts, two-request ordered prefetch, provider-neutral MP3/WAV rendering, bounded gapless playback, reaction/style policy, exact TTS profiles, and migration/cutover behavior;
- WebKit full journey is not run. Its browser binary is present, but this host lacks `libicu74`, `libxml2`, and `libflite1`;
- full Chromium/WebKit voice booking, owner-configured live Compose cutover, target VPS, public TLS/WSS, target-host provider booking, and target-host latency/load remain explicit gates;
- no formal voice A/B matrix exists.

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

Deployment, tests, readiness, and schema verification do not spend provider usage. Static greeting/reaction regeneration is administrator-only, paid, explicit opt-in, and overwrites tracked assets; the assets are already committed, so do not regenerate them for ordinary setup:

```bash
BOTAMIN_GENERATE_PROACTIVE_GREETING=1 \
  bun run scripts/generate-proactive-greeting.ts

BOTAMIN_GENERATE_LOCAL_REACTION_CLIPS_PAID=1 \
  bun run generate:reaction-clips:paid-opt-in
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
docker compose run --rm -e AUTO_MIGRATE=false -e OPENROUTER_EXTERNAL_SMOKE=1 app /app/scripts/run-openrouter-smoke.sh stt
docker compose run --rm -e AUTO_MIGRATE=false -e OPENROUTER_EXTERNAL_SMOKE=1 app /app/scripts/run-openrouter-smoke.sh tts
```

The default remains xAI/eve/MP3. To deliberately smoke the opt-in Gemini profile from a checkout whose protected `.env` contains the key, set all four values and the paid gate together; do not print/source the key:

```bash
OPENROUTER_EXTERNAL_SMOKE=1 \
OPENROUTER_TTS_PROFILE=gemini_3_1_pcm \
OPENROUTER_TTS_MODEL=google/gemini-3.1-flash-tts-preview \
OPENROUTER_TTS_VOICE=Schedar \
OPENROUTER_TTS_RESPONSE_FORMAT=pcm \
bun run scripts/openrouter-tts-smoke.ts
```

Voice names are case-sensitive and must match the exact 30-name release snapshot in [`../CURRENT_DECISIONS.md`](../CURRENT_DECISIONS.md). Gemini is Preview/dynamic-catalog; there is no automatic fallback or model/voice selection. On this host on 2026-08-03, the Schedar neutral smoke succeeded through OpenRouter: `audio/wav`, 188204 bytes, 3326ms. This is not a quality claim.

Rollback is configuration-only and exact:

```dotenv
OPENROUTER_TTS_PROFILE=xai_mp3
OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
```

## Explicit remaining gates

- WebKit complete provider-neutral MP3/WAV and full voice booking journey after installing `libicu74`, `libxml2`, and `libflite1` on a compatible host.
- Full Chromium voice booking journey; desktop/mobile landing smoke is not sufficient.
- Owner listening review and a future formal voice A/B matrix if a quality comparison is required; the isolated smoke proves no quality preference.
- Owner-configured live local Compose cutover/restore drill with retained backup path.
- Clean target-VPS deploy and resource behavior.
- Public DNS, TLS, and WSS.
- Explicitly approved target-host OpenRouter STT/TTS + Codex Luna live booking through final widget.
- Target-host latency/load profile and owner review of provider rates, model availability, subscription capacity, privacy copy, backup encryption/retention, and commercial operation.
