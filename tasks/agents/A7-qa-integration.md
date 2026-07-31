# Agent A7 — QA, E2E and release integration

## Mission

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

- fake STT/TTS/brain/notifier components;
- PCM fixtures;
- unit/contract/integration command matrix;
- Playwright full journey;
- reconnect, barge-in and provider failure tests;
- idempotency/concurrency tests;
- 24+ conversation eval execution;
- latency p50/p95 report;
- security/secret scan;
- release evidence bundle.

## Release blockers

Any duplicate booking, qualification before booking, invented commercial promise, leaked secret, false calendar claim, unbounded buffer or inability to restore DB is critical.

## Completion report

Commit SHA, test matrix and pass counts, external test environment, latency summary, critical/noncritical defects by owner, and RC recommendation with explicit caveats.
