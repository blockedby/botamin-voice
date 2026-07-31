# Agent A0 — Platform and contracts

## Mission

Создать repository skeleton и заморозить shared contracts, чтобы остальные агенты работали параллельно через fakes.

## Read first

- `docs/00-scope-and-assumptions.md`
- `docs/03-system-architecture.md`
- `docs/05-api-events-data.md`
- task T00 in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/platform-contracts`.

Владей root workspace config, `packages/contracts`, baseline `apps/web`, `apps/server`, `packages/test-fixtures`. Не реализуй providers или product UI.

## Deliverables

- Bun workspace with React/Vite and Bun server packages.
- Strict TypeScript and shared Zod schemas.
- Discriminated unions for all WS events.
- Ports: Brain, STT, TTS, Notifier, Booking repository/service.
- Fake adapters and one fake full-turn test.
- Root scripts: typecheck, test, lint/format, build.
- ADR note for any deviation from the spec.

## Non-negotiables

- No secrets, no provider credentials, no online editor.
- Booking and qualification schemas must encode the ordering invariant.
- Contracts package stays runtime-neutral.
- Do not choose a production database/provider package on behalf of another agent.

## Completion report

Return commit SHA, changed paths, commands run, test output summary, unresolved assumptions, and any proposed contract change requiring review.
