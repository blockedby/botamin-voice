# Validation report — local release candidate

**Date:** 2 August 2026

**Spec version:** `0.5-demo`

**Release label:** `0.5.0-local-rc.2`

**Candidate branch:** `feat/sales-booking-ux`

**Base:** `faa2441922dea78a93e0b1424909f7ce68b15e53` (merged PR #24)

**Validated candidate:** `562d6b68266e37174f5be8608e71338d6c5b7459` plus this release-evidence update

**Result:** local release-candidate gates pass. This report does not claim a target-VPS, public TLS/WSS, WebKit, real calendar, or CRM release.

## Candidate scope

The candidate adds:

- a server-authoritative 60-second/2,000,000-byte utterance ceiling with sample-derived accessible circular countdown and single auto-commit;
- provider-neutral typed final turns and a server-stage-gated booking form;
- required name, company, work email, phone or Telegram, consent, and one of exactly two server-supplied 20-minute Moscow slots;
- backend candidate generation and validation for non-today weekdays with 09:00–17:00 starts;
- moderately proactive sales cadence, sourced 10–15 million ₽/month brief claim without guarantee, and deterministic explicit-refusal termination;
- post-booking qualification limited to monthly inbound lead volume and integer sales-manager count;
- migration and read compatibility for legacy bookings and legacy qualification JSON without inventing new values.

The booking remains an internal SQLite record plus notifier outbox event. No external calendar availability is checked and no calendar event, invitation, or CRM record is created.

## Fresh deterministic verification

```text
bun run lint:format: passed
bun run typecheck: passed across all workspaces
bun test --path-ignore-patterns '**/dist/**': 484 passed, 0 failed across 56 files (4,104 assertions)
bun run build: passed for contracts, prompt compiler, test fixtures, server, and production web
fixture eval: 35/35 scenarios passed; 16/16 booking-order cases passed; 19/19 negative controls passed; zero critical failures
bun evals/src/generate-baseline.ts --check: deterministic artifact current
scripts/build-spec.sh + scripts/validate-spec.py: ALL VALIDATIONS PASSED
git diff --check: passed
```

The full suite includes direct regressions for typed/spoken parity, sample-derived timer progress, byte-vs-duration effective limits, stale capture fencing, exact candidate-slot authorization, double-booking prevention, populated legacy migration, legacy qualification normalization, strict two-field qualification, and explicit typed/spoken refusals.

Separate initial and closure reviewers closed all reported impact-3 migration, slot-context, qualification, refusal, and compatibility findings. The final closure review reported no residual findings.

## Local deployment and runtime evidence

Before deployment, `scripts/backup.sh` created a protected SQLite backup with a SHA-256 sidecar. `scripts/deploy-local.sh` then completed from the candidate tree:

- file-backed secrets were materialized with directory mode `0700` and file mode `0600` and mounted read-only;
- the image content/history assertions and forward migration passed;
- app and Caddy containers became healthy;
- `/health/live` returned `ok`;
- `/health/ready` returned `ready` for database, brain, voice, prompts, notifier, and capacity;
- the running container exposed `STT_MAX_UTTERANCE_MS=60000` and `STT_MAX_AUDIO_BYTES=2000000`;
- the same-origin AudioWorklet returned JavaScript MIME under the unchanged strict CSP.

Local endpoint: <http://localhost:5173>.

## Browser evidence

A disposable headless Chrome session observed the production bundle and runtime path:

- no horizontal overflow at 780 px or 390 px;
- microphone denial produced the safe retry state;
- a controlled local silent MediaStream reached the real AudioWorklet/session path;
- the visible circular timer showed the 60-second budget and decremented from accepted PCM samples;
- the typed composer appeared during a visitor turn;
- typed `Нет, я не заинтересован` terminated the session with `DECLINED`, no booking claim, and no later selling;
- the only console/network error was the pre-existing missing `favicon.ico`; application scripts and worklet loaded with HTTP 200.

Firefox headless rendered the 390×844 production page without CSP, eval, worklet, or runtime errors. WebKit remains unverified.

## Fresh bounded provider smoke

One explicit paid local smoke was run after deployment:

```text
OpenRouter STT: openai/gpt-audio-mini
Brain: Codex subscription / gpt-5.6-luna
OpenRouter TTS: x-ai/grok-voice-tts-1.0, eve, MP3
Result: passed
Input: 1 bounded PCM fixture / 1 commit
Output: 1 transcript.final, 1 assistant.text.done, 2 complete MP3 segments
Decoder: 2/2 MP3 segments accepted
Booking: false
Total observed functional duration: about 14.1 seconds
```

This is functional sequencing evidence, not a latency benchmark or SLO. The earlier committed five-turn artifact remains the evidence for exactly one durable booking and one sent outbox event.

## Security and scope boundaries

- OpenRouter remains the only STT/TTS gateway; the backend-only key was not printed or exposed to the browser.
- Default tests/evals remain credential-free and provider-independent.
- Logs and committed artifacts contain no provider bodies, audio/base64, real transcripts, contacts, credentials, or Codex auth.
- Server policy owns stage transitions, candidates, consent, identities, idempotency, booking truth, and tool authorization.
- Booking commits before confirmation or optional qualification.
- A clear refusal ends selling; legacy stored qualification fields are normalized on read while new legacy writes remain rejected.

## Remaining external gates

- WebKit complete-MP3 playback and full journey acceptance.
- Target-VPS resource behavior, clean deployment, DNS, public TLS/WSS, and target-host provider smoke.
- Real calendar/CRM integration and external availability checks.
- Owner review of current provider rates, model availability, Codex plan capacity, privacy copy, and public commercial operation.

Recommended tag after merge and final checksum verification: `v0.5.0-local-rc.2`.
