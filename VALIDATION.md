# Validation report — local release candidate

**Date:** 2 August 2026

**Spec version:** `0.5-demo`

**Release label:** `0.5.0-local-rc.3`

**Candidate branch:** `feat/proactive-scheduling-qualification`

**Base:** `9b47be37e0e7fb1132e3052eb2f95519fcb371ca` (`v0.5.0-local-rc.2`, merged PR #25)

**Validated candidate:** current branch content through `aa3f120`, plus this final evidence/checksum update

**Result:** local RC3 gates pass. This report does not claim WebKit, target-VPS, public TLS/WSS, real calendar availability, calendar-event creation, or CRM integration.

## Candidate scope

RC3 adds:

- a product-owned, same-origin static MP3 greeting that attempts playback once when the page opens, exposes an accessible `Включить приветствие` fallback when playback is blocked or unavailable, and stops before the real conversation starts;
- zero conversation REST, WebSocket, microphone, STT, Luna, or runtime TTS calls before the existing consent/start path;
- contextual server-owned scheduling: without a preference, one morning and one evening candidate; with a typed or spoken morning/day/second-half/evening preference, two in-band candidates approximately one hour apart; rejected bands are excluded; occupied bands roll to a later weekday;
- exactly two active candidates per turn, still 20 minutes, weekdays, not Moscow-today, with 09:00–17:00 starts and stale/arbitrary model selections rejected;
- deterministic optional post-booking qualification: after committed booking and confirmation, ask `Можно задать два коротких вопроса?`, then monthly inbound leads and integer sales-manager count one at a time;
- server-derived qualification status: one field is `partial`, both fields are required for `complete`, both may arrive together, and refusal preserves the booking plus any partial answer.

The two displayed slots are current internal alternatives, not a claim about all calendar availability. No external calendar event or invitation is created.

## Fresh deterministic verification

```text
bun run lint:format: passed
bun run typecheck: passed across every workspace
bun test --path-ignore-patterns '**/dist/**': 510 passed, 0 failed across 58 files (4,265 assertions)
bun run build: passed for contracts, prompt compiler, fixtures, server, and production web
offline eval: 35/35 scenarios passed; 16/16 booking-order cases passed; 19/19 negative controls passed; zero critical failures
bun evals/src/generate-baseline.ts --check: deterministic artifact current
scripts/build-spec.sh + scripts/validate-spec.py: ALL VALIDATIONS PASSED
MANIFEST.txt / CHECKSUMS.sha256: regenerated twice byte-identically; 328 files verified
git diff --check: passed
```

Direct regressions cover default and contextual candidate pairs, occupied-band weekday rollover, the exact phrases `во второй половине дня`, `сегодня в одиннадцать часов вечера`, `Мне неудобно вечером`, `Вечером не могу`, and `Не вечером`, typed/spoken parity, stale candidate rejection, qualification consent, leads-first ordering, malicious complete-with-one-field, both-at-once, partial follow-up, refusal before/after one answer, booking survival, and replay idempotency.

Independent review found three backend blockers during the candidate cycle: contextual fallback after collisions, missed `Нет, на этом всё.` after a partial answer, and stale/negated time preference handling. All were fixed with retained regressions; closure review returned `READY` with no residual findings. A separate greeting review returned `READY` with no findings.

## Static greeting asset and generation

The fixed greeting was generated once through the existing backend OpenRouter TTS adapter using explicit opt-in:

```text
BOTAMIN_GENERATE_PROACTIVE_GREETING=1 bun scripts/generate-proactive-greeting.ts
status: generated
format: MP3
size: 200,064 bytes
observed duration: 12.504 seconds
```

The generator uses a bounded timeout/size, zero retries, complete-MP3 validation, atomic rename, and safe aggregate output. The committed product-owned file contains fixed Botamin copy and no visitor audio, transcript, contact, credential, or provider body. Runtime page entry fetches only `/assets/botamin-proactive-greeting.mp3`; it does not synthesize the greeting.

## Local deployment and readiness

A protected SQLite backup with checksum sidecar was created before deployment. `scripts/deploy-local.sh` then completed from the RC3 candidate tree:

- file-backed secrets were materialized with directory mode `0700`, file mode `0600`, and read-only mounts;
- Docker image build/content/history assertions passed;
- forward migration completed;
- app and Caddy became healthy;
- `/health/live` returned `ok`;
- `/health/ready` returned `ready` for database, brain, voice, prompts, notifier, and capacity;
- the running service retained `STT_MAX_UTTERANCE_MS=60000` and `STT_MAX_AUDIO_BYTES=2000000`;
- the static greeting returned HTTP 200 with `audio/mpeg` under the unchanged strict CSP.

Local endpoint: <http://localhost:5173>.

## Browser evidence

Disposable production-bundle Chrome sessions observed:

- one page-entry run completed the automatic static greeting attempt without starting a conversation;
- another isolated run exercised the unavailable/blocked fallback and keyboard-focus-preserving retry button;
- before consent/start, network traffic contained only page assets, the static greeting, and the pre-existing missing favicon—no conversation REST, WebSocket, microphone, OpenRouter, Luna, or runtime TTS request;
- starting a real session removed/stopped the proactive greeting before live agent audio;
- no horizontal overflow at 780 px or 390 px;
- a controlled local MediaStream reached the real worklet/session path;
- a real typed `Хочу короткую встречу, но только вечером.` turn received two server-supplied evening alternatives, 16:00 and 17:00 Moscow, rather than morning slots;
- the conversation was stopped without creating a booking.

Firefox headless rendered the 390×844 RC3 production page with the greeting card and no CSP, eval, worklet, or runtime errors. WebKit was not run.

## Fresh bounded provider evidence

Two explicit candidate checks used authorized local provider access:

1. The typed evening browser turn exercised Codex subscription / `gpt-5.6-luna` and OpenRouter TTS with server-owned 16:00/17:00 context.
2. The integrated external voice smoke passed:

```text
OpenRouter STT: openai/gpt-audio-mini
Brain: Codex subscription / gpt-5.6-luna
OpenRouter TTS: x-ai/grok-voice-tts-1.0, voice eve, MP3
Input: 1 bounded PCM fixture / 1 commit
Output: 1 transcript.final, 1 assistant.text.done, 2 complete MP3 segments
Decoder: 2/2 segments accepted; 209,664 response bytes
Booking: false
Observed functional duration: about 10.6 seconds
```

These are bounded functional observations, not latency benchmarks or SLO evidence. Post-booking qualification is proven by credential-free production-component tests rather than a new paid booking containing contact data.

## Security and truth boundaries

- The proactive greeting contains no visitor data and cannot record or submit an answer.
- Existing voice/contact consents and successful microphone/session setup remain mandatory before the visitor can answer.
- OpenRouter remains the only STT/TTS gateway; credentials remain backend-only.
- Server policy owns stages, time preference/rejection interpretation, candidates, identities, consent, idempotency, booking truth, and qualification completion.
- Booking still commits before confirmation and optional qualification.
- Logs, evals, fixtures, and release evidence contain no credentials, customer audio/base64, real contacts, provider bodies, or raw provider transcripts.

## Remaining external gates

- WebKit complete-MP3 playback and full journey acceptance.
- Target-VPS resources, clean deployment, DNS, public TLS/WSS, and target-host provider checks.
- Real calendar/CRM integration and external availability checks.
- Owner review of current provider rates, model availability, Codex capacity, privacy copy, and public commercial operation.

Recommended tag after merge and final checksum verification: `v0.5.0-local-rc.3`.
