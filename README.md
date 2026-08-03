# Botamin Voice Sales Agent

> **Correction 004 (authoritative, read first):** [`corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md`](corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md)
>
> Then read [`CURRENT_DECISIONS.md`](CURRENT_DECISIONS.md).

**Spec version:** `0.5-demo`

**Local release candidate:** `0.5.0-local-rc.4` (recommended; tag pending)

**Current release scope:** local hosting first; target VPS, public TLS/WSS, and WebKit acceptance are later gates.

## What this repository runs

Botamin is a full-stack landing page with a browser voice AI seller. On page entry it immediately makes one playback attempt for the committed, product-owned same-origin `/assets/botamin-proactive-greeting.mp3`. This static greeting path creates no conversation, REST call, WebSocket, microphone request, provider call, or session before both consents. If autoplay is blocked or media loading fails, the UI shows `Включить приветствие`; starting a real session stops and releases the greeting.

After consent, the browser sends bounded PCM16 chunks to the backend; after `audio.commit`, the gateway creates one validated WAV for an atomic OpenRouter STT request. A secure provider-neutral `visitor.text.submit` path accepts a final typed turn through the same transcript, Luna, policy, tool, and persistence flow. One final transcript goes to Codex app-server with `gpt-5.6-luna`; OpenRouter TTS returns complete provider-neutral phrase segments. Each utterance is capped at 60 seconds and the atomic STT WAV at 2,000,000 bytes. The circular countdown is derived from accepted 16 kHz PCM16 samples and the stricter server-advertised duration/byte ceiling, not wall time.

Luna remains fixed at reasoning effort `low`, its lowest supported setting; reasoning cannot be disabled. A missing `CODEX_EFFORT` defaults to `low`, while any non-`low` value fails before the Codex process starts for both standard and priority service. `CODEX_SERVICE_TIER` defaults to empty standard service for portability. A local subscription owner may set exact `priority` for the Codex-advertised Fast tier (1.5x speed with increased subscription usage), but this provides no latency SLA. Readiness accepts Luna only when both advertised `id` and `model` equal the configured model; missing or contradictory identity fields fail closed, as does a missing requested tier.

The backend always supplies exactly two structured internal 20-minute `Europe/Moscow` candidates with a concrete date and time. With no preference the pair defaults to one morning and one evening option. A bounded Russian parser applies typed or spoken morning/day/second-half/evening preferences, rejections, and supported concrete Moscow date/time requests; the server returns either the exact permitted start plus one alternative or the nearest two internal starts. Every option is a non-today weekday start on the 20-minute grid from 09:00 through 17:00 Moscow time. These are two current internal alternatives—not all global availability—and already committed internal starts are excluded without querying or creating a real calendar/CRM event or invitation.

RC4 persists one versioned `conversation_contexts.draft_json` object per conversation. It contains the fact registry, provenance, bounded conflicts, exactly two candidate identities, selection, readiness, exact-revision confirmation, commit state, and booking identity. Spoken turns, typed turns, and the structured in-chat form update the same server-owned draft; stale revisions and conflicting facts fail closed until explicitly resolved. When name, company, working email, phone or Telegram, and one current candidate are accepted, the visitor confirms the exact revision and the server automatically commits one internal virtual meeting. Only the resulting durable booking can publish the final server-projected meeting widget.

After truthful confirmation of that internal meeting, optional qualification starts directly—there is no separate permission question. The server asks only the first missing field: monthly lead/contact volume first when both are absent, otherwise only the missing `salesManagerCount` or volume field, and nothing when both are already known. Both answers in one turn complete it; refusal with no answer is `skipped`, refusal after one answer remains `partial`, and the meeting remains scheduled. TTS redacts contacts by default; the only exception is an exact server-approved contact from accepted durable draft facts or the committed booking when contact-processing consent is active.

## Natural voice and TTS profiles

The default remains OpenRouter `x-ai/grok-voice-tts-1.0` / `eve` / complete MP3 (`OPENROUTER_TTS_PROFILE=xai_mp3`) unless the environment profile is deliberately changed. Natural delivery improvements shared by both profiles are concise conversational speech prompts, two ordered in-flight synthesis requests (current + one prefetch), provider-neutral MP3/WAV rendering, gapless Web Audio scheduling, and a four-segment/20 MB credit window with at most two decoded segments. The output `AudioContext` is created/resumed in the consent gesture.

A sixteen-clip same-origin Sulafat corpus is committed as canonical mono PCM16LE 24 kHz WAV. Runtime may play at most one fail-closed policy-eligible clip after a 350 ms delay, only after capability negotiation; the current policy exposes only the non-claiming `neutral-moment` clip. Claim-bearing progress, validation, scheduling, booking, and acceptance clips remain runtime-unreachable until a future explicit trusted server operation signal exists. Reactions do not alter transcript, state, provider selection, or business effects and make zero runtime provider calls. Regenerating this committed corpus requires the exact Gemini PCM/Sulafat production profile plus an explicit paid administrator opt-in. This does not change the separately allowed static same-origin proactive greeting, and no conversation/provider behavior occurs before both consents.

Gemini is an explicit Preview profile, not a default or fallback:

```dotenv
OPENROUTER_TTS_PROFILE=gemini_3_1_pcm
OPENROUTER_TTS_MODEL=google/gemini-3.1-flash-tts-preview
OPENROUTER_TTS_VOICE=Kore
OPENROUTER_TTS_RESPONSE_FORMAT=pcm
```

All four values must change together; voice names are case-sensitive. OpenRouter PCM is validated and wrapped server-side as one canonical complete `audio/wav` segment, so the browser never receives raw PCM. Server-owned delivery styles are the fixed `neutral`, `curious`, `serious`, and `excited` enum; sensitive or authoritative facts always use neutral, and the visible transcript remains plain text without style tags. The Gemini catalog is dynamic, there is no automatic model/voice selection or xAI fallback, and rollback is the four-value xAI profile in `.env.example`.

## Local-first start

Prerequisites: Bun `1.3.14`, Docker Engine with Compose v2, and browser microphone support. `ffmpeg` is required only for the opt-in owner-operated voice smoke.

```bash
cp .env.example .env
chmod 600 .env
# Set OPENROUTER_API_KEY in .env. Do not source .env.

# Interactive Codex device login into the persistent botamin-codex-home volume:
./scripts/device-auth.sh

# Materializes mode-0600 file secrets, builds, protects any existing DB,
# drains/stops the app, migrates through normal startup, verifies RC4 invariants,
# and waits for dependency-aware readiness. It does not run paid smokes.
./scripts/deploy-local.sh

curl -fsS http://localhost:5173/health/ready
```

Open <http://localhost:5173>. The single `OPENROUTER_API_KEY` is backend-only and authorizes STT and TTS. `scripts/deploy-local.sh` parses `.env` as dotenv data, writes read-only Compose secret mounts from `.runtime/secrets`, and force-recreates the app so rotated files are remounted. Do not pass the key through build arguments, render it into Compose environment output, or commit `.env`/`.runtime`.

For direct Bun development outside Compose, the absolute `CODEX_HOME` in `.env` applies. Compose intentionally uses the persistent `botamin-codex-home` volume instead. Treat its `auth.json` as a password and restrict Docker access.

Run the canonical credential-free test suite with `bun run test`; it excludes ignored generated `dist` output.

## Local operations

### Owner dialogue export

```bash
bun run dialogues:export
# Optional, mutually exclusive selectors:
bun run dialogues:export --conversation <ULID-or-UUIDv7>
bun run dialogues:export --limit 10
bun run dialogues:export --all
```

This explicit manual command reads a consistent, read-only SQLite snapshot from the running Compose app (or a direct local `DATABASE_URL`) and atomically writes protected Markdown under `.runtime/dialogues/`. The default is the latest completed/started conversation; `--limit` is `1..100`, while `--all` fails above 100. Only aggregate status/count/path reaches the terminal—never transcript text. Exports can contain visitor PII, are owner-managed separately from the DB's 30-day transcript retention, and must be deleted separately. See [`docs/12-dialogue-export.md`](docs/12-dialogue-export.md) for exclusions and safeguards.

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

1. `booking.created` and committed draft state happen before optional post-booking qualification or final-widget publication.
2. Refusal, disconnect, or qualification failure after booking does not remove the internal virtual meeting.
3. Retried draft confirmation/booking commit returns the same booking rather than a duplicate.
4. OpenRouter and Codex credentials never reach the browser.
5. Raw audio is not retained by default.
6. The UI and agent distinguish the scheduled internal virtual meeting from an external calendar event or invitation.
7. OpenRouter is the only STT/TTS gateway; Codex subscription + GPT-5.6 Luna is the brain.
8. Phrase-level STT adds accepted end-of-turn latency; local synthetic timings and the isolated Gemini smoke are not quality or hosting benchmarks.
9. Typed and spoken final turns have the same semantic authority; neither exposes provider or tool controls.
10. A booking uses exactly one of the two current server-supplied, concretely dated internal Moscow slots; stale revisions and non-candidate slots are rejected.
11. The pre-consent proactive greeting is one static same-origin MP3 attempt and cannot create a session or invoke microphone/provider capabilities.
12. The two candidates are current internal alternatives, never a claim of exhaustive global availability; the meeting remains committed across skipped or partial optional qualification.
13. Browser draft projections exclude provenance/evidence; arbitrary contacts remain redacted from TTS.

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
| `docs/12-dialogue-export.md` | manual protected owner transcript export |
| `evidence/T30-observed-local-voice-smoke-2026-07-31.md` | historical redacted owner-observed local provider path |
| `FULL_SPEC.md` / `technical-spec.html` | generated specification; not updated by this docs-only change |

The unavailable Notion source remains a known research limitation; see the detailed scope and research documents before changing product claims.
