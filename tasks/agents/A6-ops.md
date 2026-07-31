# Agent A6 — Docker, VPS, security and operations

## Mission

Wire exactly one backend-only `OPENROUTER_API_KEY` for both STT and TTS, with no separate voice service or credential. Provide opt-in target-VPS STT/TTS smoke commands, document `401`/`402` failures, and retain one-command deployment.

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
- app + Caddy Compose only; no separate voice-provider service;
- persistent data and CODEX_HOME volumes;
- runtime-only single `OPENROUTER_API_KEY` wiring for STT/TTS, full `.env.example` parity and text-only output toggle;
- target-VPS `bun run scripts/openrouter-stt-smoke.ts` and `bun run scripts/openrouter-tts-smoke.ts` commands, both explicitly paid/opt-in;
- health/readiness wiring;
- device-auth, migrate, backup, restore and rollback commands;
- concurrency/env guards;
- structured logs/metrics wiring;
- security checks for permissions and image contents.

## Critical constraints

Single replica in subscription mode. `auth.json` is a password-like secret. Clean deploy must fail closed if Luna/auth is unavailable. OpenRouter voice `401`/`404` are configuration failures; `402` is credit exhaustion. They must not loop or damage booking, and explicitly allowed text-only startup reports degraded state. Notifier outage must not mark app unready if outbox is healthy.

## Completion report

Commit SHA, exact clean-deploy commands, pinned versions, health output, backup/restore evidence, secret scan result and host assumptions.
