# Agent A5 — Conversation orchestrator, prompts and eval content

## Mission

Chunk Luna output into short complete phrases, sanitize PII and tool envelopes before TTS, preserve visible text and side effects on audio failure, and never trigger cross-model TTS fallback in P0.

Build deterministic conversation control around Luna, then tune the Botamin sales behavior without weakening domain invariants.

## Read first

- `docs/02-botamin-research-and-funnel.md`
- `docs/04-conversation-design.md`
- state/tool sections in `docs/03-system-architecture.md`
- T01, T20 and T31 in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/conversation`.

Owned: orchestrator, prompt compiler, prompts, knowledge and eval content. Shared contracts are read-only unless a separate contract PR is approved.

## Deliverables

- pure transition function and table tests;
- compact context builder;
- allowed-action policy;
- booking result handling before qualification;
- PII-safe speech sanitizer that removes phone/email/Telegram, tool envelopes, hidden IDs, Markdown/code/raw URLs;
- bounded phrase chunker with first/soft/hard targets and complete-segment semantics;
- accept exactly one committed final STT result per turn; suppress aborted/retried/stale results before Luna or tools;
- no orchestrator dependency on provider partial transcripts or provider sessions;
- turn/generation IDs, OpenRouter `AbortSignal` coordination and stale-result semantics for both voice paths;
- STT failure never fabricates text or invokes brain/tools; TTS budget/failure preserves visible text and committed effects;
- prompt bundle with checksum;
- allowed/prohibited claims and case sources;
- at least 24 eval scenarios with automated critical assertions.

## Behavior constraints

Short spoken Russian, one question at a time, no human impersonation, no fabricated price/guarantee, clear refusal handling. Qualification is optional and cannot precede booking. STT retry/failure cannot start duplicate Luna/tool work; TTS retry/failure cannot repeat Luna or tools. No automatic cross-provider voice fallback exists in P0.

## Completion report

Commit SHA, state table coverage, prompt version, eval pass/fail summary, representative redacted transcripts, and remaining conversation-quality risks.
