# Botamin Voice Sales Agent

> **Correction 004 (authoritative, read first):** [`corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md`](corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md)
>
> Then read [`CURRENT_DECISIONS.md`](CURRENT_DECISIONS.md) and [`AGENT_START_HERE.md`](AGENT_START_HERE.md).

**Spec version:** `0.5-demo`

**Local release candidate:** `0.5.0-local-rc.1`

**Current release scope:** local hosting first; target VPS, public TLS/WSS, and WebKit acceptance are later gates.

## What this repository runs

Botamin is a full-stack landing page with a browser voice AI seller. The browser sends bounded PCM16 chunks to the backend; after `audio.commit`, the gateway creates one validated WAV for an atomic OpenRouter STT request. A secure provider-neutral `visitor.text.submit` path also accepts a final typed turn and sends it through the same transcript, Luna, policy, tool, and persistence flow as speech. One final transcript goes to Codex app-server with `gpt-5.6-luna`; OpenRouter TTS returns complete MP3 phrase segments.

Each voice utterance is capped at 60 seconds and the atomic WAV request at 2,000,000 bytes. The active circular countdown is derived from accepted 16 kHz PCM16 samples and the stricter server-advertised duration/byte ceiling, not a wall-clock timer.

The backend offers exactly two structured internal 20-minute `Europe/Moscow` candidates and creates a booking only after name, company, working email, phone or Telegram, one candidate, and consent are present. It excludes already committed internal starts, but does **not** query or create a real calendar/CRM event or invitation. Optional qualification starts only after committed booking, user-facing confirmation, and consent, and is limited conversationally to monthly inbound leads and integer `salesManagerCount`.

## Local-first start

Prerequisites: Bun `1.3.14`, Docker Engine with Compose v2, and browser microphone support. `ffmpeg` is required only for the opt-in owner-operated voice smoke.

```bash
cp .env.example .env
chmod 600 .env
# Set OPENROUTER_API_KEY in .env. Do not source .env.

# Interactive Codex device login into the persistent botamin-codex-home volume:
./scripts/device-auth.sh

# Materializes mode-0600 file secrets, builds, migrates, starts app+Caddy,
# and waits for dependency-aware readiness. It does not run paid smokes.
./scripts/deploy-local.sh

curl -fsS http://localhost:5173/health/ready
```

Open <http://localhost:5173>. The single `OPENROUTER_API_KEY` is backend-only and authorizes STT and TTS. `scripts/deploy-local.sh` parses `.env` as dotenv data, writes read-only Compose secret mounts from `.runtime/secrets`, and force-recreates the app so rotated files are remounted. Do not pass the key through build arguments, render it into Compose environment output, or commit `.env`/`.runtime`.

For direct Bun development outside Compose, the absolute `CODEX_HOME` in `.env` applies. Compose intentionally uses the persistent `botamin-codex-home` volume instead. Treat its `auth.json` as a password and restrict Docker access.

Run the canonical credential-free test suite with `bun run test`; it excludes ignored generated `dist` output.

## Local operations

```bash
# Service state
docker compose ps

# Safe loopback-only aggregate metrics; /metrics through Caddy is denied.
docker compose exec -T app bun -e \
  "const r=await fetch('http://127.0.0.1:3000/metrics');if(!r.ok)process.exit(1);console.log(await r.text())"

# Backup and stop without deleting named volumes
./scripts/backup.sh
docker compose stop
# Or remove containers/network while preserving named volumes:
docker compose down
```

Never use `docker compose down -v` on a host with bookings or Codex auth. Restore, rollback, key rotation, paid-smoke commands, and the exact local release checklist are in [`docs/11-local-release-handoff.md`](docs/11-local-release-handoff.md). Detailed file-secret behavior is in [`infra/README.md`](infra/README.md).

## Fixed invariants

1. `booking.created` happens before optional post-booking qualification.
2. Refusal, disconnect, or qualification failure after booking does not remove it.
3. Retried `create_booking` returns the same booking rather than a duplicate.
4. OpenRouter and Codex credentials never reach the browser.
5. Raw audio is not retained by default.
6. The agent never claims that a calendar event was created.
7. OpenRouter is the only STT/TTS gateway; Codex subscription + GPT-5.6 Luna is the brain.
8. Phrase-level STT adds accepted end-of-turn latency; local synthetic timings are not a hosting benchmark.
9. Typed and spoken final turns have the same semantic authority; neither exposes provider or tool controls.
10. A booking uses exactly one of the two current server-supplied internal Moscow slots; a non-candidate slot is rejected.

## Documentation map

| Path | Purpose |
|---|---|
| `CURRENT_DECISIONS.md` | authoritative active decisions |
| `docs/00-scope-and-assumptions.md` | scope and boundaries |
| `docs/03-system-architecture.md` | components and voice pipeline |
| `docs/05-api-events-data.md` | REST/WS, tools, and data contracts |
| `docs/06-deployment-security-operations.md` | deployment/security/operations design |
| `docs/08-testing-and-acceptance.md` | tests and local/later release gates |
| `docs/09-agent-task-plan.md` | task dependencies and T40 status |
| `docs/11-local-release-handoff.md` | local RC runbook, checklist, limitations, rollback |
| `evidence/T30-observed-local-voice-smoke-2026-07-31.md` | redacted owner-observed real local provider path |
| `VALIDATION.md` | current evidence and explicit unobserved boundaries |
| `FULL_SPEC.md` / `technical-spec.html` | deterministic generated specification |

The unavailable Notion source remains a known research limitation; see the detailed scope and research documents before changing product claims.
