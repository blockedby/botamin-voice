# Agent A1 — Web voice client and product UI

## Mission

Implement complete MP3 phrase-segment decoding/playback, ordered queueing, local stop, and stale-generation filtering. The browser must never call OpenRouter.

Реализовать browser audio capture/playback и затем Botamin-specific voice funnel UI, работая сначала против fake server.

## Read first

- `docs/01-product-requirements.md`
- `docs/02-botamin-research-and-funnel.md`
- audio/WS sections in `docs/03-system-architecture.md` and `docs/05-api-events-data.md`
- T10 and T21 in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/web-voice`.

Owned: `apps/web/src/audio`, transport, voice state, UI components/pages/styles. Не меняй shared contracts напрямую.

## Deliverables

- AudioWorklet capture and resampling to 16 kHz mono PCM16.
- Binary PCM16 frame batching around 100 ms with bounded local buffering.
- Explicit end-of-turn `audio.commit`; duplicate commit suppression and UI states `listening → processing → final transcript`.
- No UI contract or copy that assumes provider interim transcripts; microphone chunks are browser transport, not streaming provider STT.
- Complete `audio/mpeg` phrase-segment decoding/playback using Web Audio or `HTMLAudio`, ordered by sequence.
- Immediate local barge-in cancellation and generation filtering.
- Reconnect/resume token behavior.
- UI states: idle, connecting, listening, thinking, speaking, booked, qualification, complete, error.
- Botamin landing copy from research doc.
- Keyboard labels, mobile layout and safe user errors.

## Tests

Use deterministic PCM microphone fixtures, utterance duration/byte-boundary and `audio.commit` cases, valid/invalid MP3 fixtures, fake WS server, Chromium and WebKit. Prove at least three complete segments play in order; local barge-in stops playback, clears queued segments and rejects late generations; text remains visible on audio failure. Prove the browser never calls OpenRouter and no provider secret appears in build output.

## Completion report

Commit SHA, screenshots or short test evidence, browser matrix, known audio compatibility issues, and contract assumptions.
