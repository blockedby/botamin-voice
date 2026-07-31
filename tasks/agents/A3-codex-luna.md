# Agent A3 — Codex subscription and Luna brain

## Mission

Build a robust typed adapter from Bun to a pinned `codex app-server`, authenticated by the owner's ChatGPT/Codex subscription and using `gpt-5.6-luna`.

## Read first

- Codex sections in `docs/03-system-architecture.md`
- `docs/06-deployment-security-operations.md`
- ADR-001 through ADR-004 and ADR-013 in `docs/07-tradeoffs-and-adrs.md`
- `docs/10-ai-library-evaluation.md`
- T13 in `tasks/tasks.yaml`
- official links in `sources.md`

## Branch and ownership

Branch: `agent/codex-luna`.

Owned: `apps/server/src/providers/codex/**`, generated Codex schemas and Codex-specific scripts. Do not edit conversation policy or booking DB.

## Transport decision gate

Start with a bounded spike, not a framework rewrite. Verify the current official `@openai/codex-sdk` on the production Bun image against all mandatory controls: streamed deltas, addressable interrupt, thread IDs, instruction source verification, dynamic tools/envelope fallback and sandbox settings. The documented default is direct app-server JSON-RPC because the public TypeScript SDK surface does not expose all required controls. Do not adopt a community wrapper unless it passes the same contract suite and removes more code than it adds. Record evidence in the ADR.

## Required protocol

- long-running child process;
- JSONL JSON-RPC over stdio;
- initialize/initialized;
- model/list preflight;
- compile/read isolated runtime `AGENTS.md`, then verify it in `thread/start.instructionSources`;
- thread/start or resume per conversation;
- turn/start and `item/agentMessage/delta` streaming;
- turn/interrupt;
- dynamic tools behind feature flag;
- outputSchema envelope fallback;
- request timeout, process restart and pending-map cleanup.

## Security

Use approval policy never and the most restrictive sandbox/permission profile available. The runtime cwd must contain only compiled `AGENTS.md`/allowlisted knowledge and must not expose the source repository, `.env` or database. Add a test proving shell/network attempts do not execute.

## Auth

Support `CODEX_HOME` volume and `codex login --device-auth`; never read or log token contents. Missing/invalid auth makes readiness fail.

## Completion report

Commit SHA, pinned CLI/SDK versions, transport decision with evidence, generated schema diff, real preflight output without secrets, Bun compatibility result, test results, dynamic-tool status, fallback behavior and known subscription constraints.
