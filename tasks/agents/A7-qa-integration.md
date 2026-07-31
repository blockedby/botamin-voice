# Agent A7 — QA, E2E and release integration

## Mission

Prove the OpenRouter-only voice path using protocol-faithful fake STT and TTS HTTP endpoints by default. Keep paid external Russian smokes opt-in and excluded from default CI.

## Read first

- `corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md`
- `docs/08-testing-and-acceptance.md`
- `docs/09-agent-task-plan.md`
- contracts in `docs/05-api-events-data.md`
- T22, T30, T31, T32 and release support in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/qa-integration`.

Owned: test harness, fixtures, Playwright, security tests, eval runner and release evidence. Report component bugs to owners; avoid permanent fixes in foreign paths unless acting as merge integrator.

## Deliverables

- separate gateway/utterance-assembler tests proving bounded mono PCM16 plus one accepted `audio.commit` produces exactly one validated WAV;
- separate `OpenRouterSttAdapter` tests starting from already-WAV fixtures, including rejection of raw PCM/malformed WAV/content-type mismatch and proof that the adapter performs no PCM conversion;
- fake OpenRouter `POST /api/v1/chat/completions` endpoint that validates one unchanged-byte base64 WAV `input_audio` and returns one final transcript;
- fake OpenRouter `POST /api/v1/audio/speech` endpoint returning complete `audio/mpeg` fixtures;
- PCM microphone, raw PCM, valid/invalid WAV and valid/invalid MP3 fixtures;
- error fixtures for `400/401/402/404/413/429` and retryable `5xx`, plus timeout, bounded `Retry-After`, abort, empty/malformed body and stale turn/generation;
- proof that browser PCM chunks stay bounded, `audio.commit` makes one atomic `audio/wav` STT request, and the client receives only `transcript.final`;
- proof that STT retry cannot invoke Luna/tools and TTS retry cannot repeat Luna/tools/notifier;
- unit/contract/integration command matrix, Playwright journey, reconnect/barge-in and deterministic retry tests;
- real paid Russian STT and TTS smokes tagged `external`, excluded from default CI, and reported as not run unless observed;
- booking idempotency/concurrency, 24+ conversation eval, separate commit-to-final and final-to-playback latency metrics, security/secret scan, and release evidence bundle.

## Release blockers

Any duplicate booking, qualification before booking, fabricated or non-final STT event, invented commercial promise, leaked key/audio/PII, browser OpenRouter call, unbounded utterance, non-audio body treated as audio, stale result playback, repeated side effect, or inability to restore DB is critical.

## Completion report

Return commit SHA, test matrix/pass counts, external tests actually run or explicitly not run, latency summary only from observed evidence, defects by owner, and RC recommendation with caveats.
