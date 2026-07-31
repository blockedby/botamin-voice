# Agent A5 — Conversation orchestrator, prompts and eval content

## Mission

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
- speech sanitizer and sentence chunker;
- generation IDs and interruption semantics;
- prompt bundle with checksum;
- allowed/prohibited claims and case sources;
- at least 24 eval scenarios with automated critical assertions.

## Behavior constraints

Short spoken Russian, one question at a time, no human impersonation, no fabricated price/guarantee, clear refusal handling. Qualification is optional and cannot precede booking.

## Completion report

Commit SHA, state table coverage, prompt version, eval pass/fail summary, representative redacted transcripts, and remaining conversation-quality risks.
