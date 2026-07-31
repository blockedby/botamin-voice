# Agent A7 — QA, E2E and release integration

## Mission

Provide a fake OpenRouter HTTP TTS server, `audio/mpeg` fixtures, error/timeout/abort/Retry-After/stale-generation tests, and tag the real external smoke test out of default CI.

Own the proof that independently implemented components satisfy the product invariants as one deployed system.

## Read first

- `docs/08-testing-and-acceptance.md`
- `docs/09-agent-task-plan.md`
- contracts in `docs/05-api-events-data.md`
- T22, T30, T31, T32 and release support in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/qa-integration`.

Owned: test harness, fixtures, Playwright, security tests, eval runner and release evidence. Component bugs should be reported to owners; avoid permanent fixes in foreign paths unless acting as merge integrator.

## Deliverables

- fake STT/OpenRouter-TTS/brain/notifier components;
- protocol-faithful fake `POST /api/v1/audio/speech`;
- PCM microphone plus valid/invalid MP3 fixtures;
- JSON errors for `400/401/402/404/429/502/503`, timeout, `Retry-After`, abort, empty body and wrong content type;
- unit/contract/integration command matrix;
- Playwright full journey;
- reconnect, barge-in, late-generation, deterministic retry/circuit and provider failure tests;
- assertion that non-2xx JSON never becomes audio and no unbounded queue exists;
- real paid smoke tagged `external` and excluded from default CI;
- idempotency/concurrency tests;
- 24+ conversation eval execution;
- latency p50/p95 report;
- security/secret scan;
- release evidence bundle.

## Release blockers

Any duplicate booking, qualification before booking, invented commercial promise, leaked secret, browser OpenRouter call, non-audio body treated as audio, stale-generation playback, repeated business side effect, unbounded buffer or inability to restore DB is critical.

## Completion report

Commit SHA, test matrix and pass counts, external test environment, latency summary, critical/noncritical defects by owner, and RC recommendation with explicit caveats.
