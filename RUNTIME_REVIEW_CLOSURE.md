# Runtime review closure

**Base:** `a3b6a97`
**Scope:** REV-001 through REV-012
**Provider policy:** deterministic fakes and local runtime checks only; no paid/external provider request and no push.

## Finding closure

| Finding | Closure evidence |
|---|---|
| REV-001 | Validated transcript retention; bounded startup/scheduled SQLite turn purge preserves bookings; stop/expiry invokes Codex `thread/delete`/map release and TTS session reset. Covered by privacy, gateway lifecycle, Codex fake-process, and config tests. |
| REV-002 | Session stop is a deduplicated bounded cancellation barrier: queued/active STT and generation work are aborted, sockets close, late events/tools are fenced, and active work drains to a deadline. Covered by blocking-STT, queued-stop, and late-event gateway tests. |
| REV-003 | Runtime constructs a validated dedicated-console or signed bounded-webhook notifier, starts a persisted retry worker, reports worker readiness, and drains/aborts delivery on shutdown. Covered by notifier/outbox and runtime readiness tests. |
| REV-004 | High-precision negative intent declines clear pre-booking refusals, completes explicit post-booking qualification refusal without removing booking, and ignores ambiguous text. Covered by intent and full gateway tests. |
| REV-005 | Brain provider failure produces one `ERROR` state event and one guarded durable `failed`/`ERROR` transition; browser capture/reconnect stops while terminal safe fallback text is retained. Covered by gateway, SQLite runtime, and browser integration tests. |
| REV-006 | Brain permit release is in an unconditional inner `finally`; failed turn persistence emits only `DB_UNAVAILABLE`, does not mark the turn persisted early, and a following turn succeeds. Covered by the throwing-persistence gateway regression. |
| REV-007 | Registry tracks stop promises after records are removed, deduplicates them, and `dispose()` awaits them before worker/brain/database shutdown. Covered by registry lifecycle tests. |
| REV-008 | Direct-peer/proxy-aware bounded source admission, create/WS rates, per-source active limits, one pending hello candidate, first-hello bearer, reconnect token validation, hello deadline, and abandoned-session reclaim are implemented. Covered by admission, registry, app, browser, and gateway reconnect tests. |
| REV-009 | Runtime/provider/gateway reject WAV limits that cannot hold the 44-byte header plus one canonical 100 ms PCM frame. Covered by config/WAV tests and container startup rejection. |
| REV-010 | `MAX_PENDING_BRAIN_TURNS` drives a cancellable timeout queue; committed WAV remains resident while queued; booked and standard lanes are FIFO with booked priority; overflow is safe. Covered by exact max-1/max-6, priority, timeout, cancellation, retained-WAV, and overflow tests. |
| REV-011 | Bun transport cap is above the 8192-byte application contract; an actual Bun server returns the structured Hono `413` for a 9 KB body. Covered by `apps/server/src/app.test.ts`. |
| REV-012 | Terminal brain `ERROR` retains the safe completed fallback, then sends WebSocket `session.stop` before outbound fencing/socket close and issues the idempotent REST stop fallback. A five-second server grace reclaims a noncompliant client's terminal session and provider state. Covered by transport/browser/registry tests and the credential-free actual Bun browser-to-runtime `maxActive=1` test. |

## Final evidence

- REV-012 targeted suite: **45 pass, 0 fail** across browser transport/integration and server registry/session/runtime integration files.
- `bun test`: **347 pass, 0 fail** across 39 files.
- `bun run typecheck`: all workspaces passed.
- `bun run lint` and `bun run format:check`: passed.
- `bun run build`: contracts, server, prompt compiler, web, and fixtures passed.
- `bun test apps/server/src/app.ws.test.ts`: localhost Bun WebSocket fake-dependency smoke passed.
- `docker compose config --quiet`, shell syntax checks, final image build, image-content assertion, container liveness/static/migration/graceful-shutdown smoke, and relational startup rejection: passed.
- `bash scripts/build-spec.sh`, `python3 scripts/validate-spec.py`, and `sha256sum -c CHECKSUMS.sha256`: passed after generated spec/release artifact regeneration.
- Tracked/untracked source secret-pattern scan and image config/history credential assertion: passed.

Real OpenRouter/Codex paid-provider smoke was intentionally not run because this closure forbids external providers. Protocol/provider behavior is covered by deterministic fake-process and adapter tests.
