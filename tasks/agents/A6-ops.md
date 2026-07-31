# Agent A6 — Docker, VPS, security and operations

## Mission

Compose has no Edge/Python TTS sidecar. Wire `OPENROUTER_API_KEY` only at runtime, provide the target-VPS smoke command, document 401/402 credit failures, and retain one-command deployment.

Make the project reproducibly deployable on one inexpensive VPS with one Compose project and safe Codex subscription credentials.

## Read first

- `docs/06-deployment-security-operations.md`
- ADR-002, ADR-007 and ADR-008 in `docs/07-tradeoffs-and-adrs.md`
- T15 and T32 in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/ops`.

Owned: Dockerfile, compose, Caddy, deployment/backup scripts and operational configuration. Do not embed secrets.

## Deliverables

- multi-stage pinned image;
- Codex CLI installation and schema generation check;
- app + Caddy Compose only; no separate TTS service;
- persistent data and CODEX_HOME volumes;
- runtime-only `OPENROUTER_API_KEY` wiring, full `.env.example` parity and text-only toggle;
- target-VPS `bun run scripts/openrouter-tts-smoke.ts` command;
- health/readiness wiring;
- device-auth, migrate, backup, restore and rollback commands;
- concurrency/env guards;
- structured logs/metrics wiring;
- security checks for permissions and image contents.

## Critical constraints

Single replica in subscription mode. `auth.json` is a password-like secret. Clean deploy must fail closed if Luna/auth is unavailable. OpenRouter `401`/`404` are configuration failures; `402` is credit exhaustion. They must not loop or damage booking, and explicitly allowed text-only startup reports degraded state. Notifier outage must not mark app unready if outbox is healthy.

## Completion report

Commit SHA, exact clean-deploy commands, pinned versions, health output, backup/restore evidence, secret scan result and host assumptions.
