# T30 observed local voice smoke — 2026-07-31

## Provenance and safety boundary

This artifact records **owner-supplied observations from an owner-run local real-provider smoke**. The agent completing T30 did not run, repeat, or independently verify the paid smoke.

- Environment: local runtime, **not VPS**.
- Input: synthetic audio supplied to the runtime; no paid input was synthesized by the smoke harness itself.
- Capture policy: no transcript text, provider speech text, personal data, API key, audio, base64, conversation/turn/generation/segment/booking IDs, or provider request IDs were captured.
- Interpretation: functional path evidence only; **not a release latency benchmark** and not target-VPS evidence.

## Runtime readiness

The local runtime reported ready with all readiness checks passing before the observed journey.

## Observed one-turn real path

| Observation | Value |
|---|---:|
| Required event completion | `transcript.final`, `assistant.text.done`, `assistant.audio.done` |
| Complete response MP3 bytes | 134,400 |
| `session.ready` | 55 ms |
| `audio.commit` | 55 ms |
| `transcript.final` | 1,401 ms |
| first text delta | 5,194 ms |
| first audio segment | 7,939 ms |
| `state.changed` | 9,034 ms |
| `assistant.text.done` | 9,035 ms |
| `assistant.audio.done` | 9,035 ms |

## Observed multi-turn path after the real envelope fix

The observed run followed the server-owned envelope identity fix from [PR 18](https://github.com/blockedby/botamin-voice/pull/18). The rationale is that conversation identity, booking identity, consent evidence, call identity, and idempotency keys must come from server-owned turn/session state rather than model-authored envelope values.

| Observation | Value |
|---|---:|
| Commits | 5 |
| Final transcripts | 5 |
| Text completions | 5 |
| Audio completions | 5 |
| Complete response MP3 bytes | 1,061,376 |
| Observed stages | `DISCOVERY → BOOKING_OFFER → COLLECT_BOOKING → BOOKED` |
| Total elapsed | 46,448 ms |
| SQLite bookings | exactly 1 booked row |
| Qualification | none |
| Notification outbox | sent once, attempt 1 |
| Conversation | completed |

## Observed model labels

- STT: `openai/gpt-audio-mini`
- Brain: `gpt-5.6-luna` via subscription
- TTS: `x-ai/grok-voice-tts-1.0`
- Voice: `eve`
- Output: `mp3`

## T30 review remediation boundary

The deterministic remediation after `749fb4f` did **not** repeat an external provider run. It hardens the owner-operated smoke and adds credential-free loopback evidence for:

- structural whole-file MP3 prefiltering plus decoder-backed acceptance before any `playback.started` acknowledgement, including one-byte/non-MP3/header-valid-random-body rejection and a known-valid two-segment generation;
- one-final-per-commit and one-generation-per-turn state binding, with zero/double/stale/mismatched negative controls;
- one overall create/body/WS/turn/WS-stop/REST-stop deadline, validated stop response, and no passing output before successful cleanup;
- honest deterministic timeline boundaries for provider STT/TTS request and completion, first actual Brain delta, client metadata/binary receipt, pairing, and playback start/completion.

### Local decoder requirement

Bun/non-browser execution of `scripts/local-voice-e2e-smoke.ts` requires `ffmpeg` on `PATH`. The smoke passes each structurally valid MP3 to a bounded, argument-array subprocess with error-on-decode and null output. Decoder absence, nonzero exit/crash, or timeout fails the smoke before acknowledgement; decoder stdout/stderr are never forwarded. Browser execution remains gated on successful Web Audio `decodeAudioData` and buffer-source `start`.

## Remaining release gates — REV-005 follow-up

**REV-005 remains an explicit release follow-up and is not closed by the deterministic T30 suite.**

- WebKit complete-MP3 playback and journey acceptance remain unobserved here.
- The configured target-VPS Russian STT/TTS smoke remains required before release.
- These local timings must not be used as target-VPS SLO or release latency evidence.
