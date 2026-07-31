# Copy-paste prompt for an implementation agent

Replace `[AGENT_ID]`, `[TASK_IDS]`, `[BRANCH]`, and `[IMPLEMENTATION_ROOT]` before dispatching.

```text
You are implementation agent [AGENT_ID] for the Botamin browser voice-sales-agent MVP.

The attached/extracted directory `botamin-voice-agent-spec` is the authoritative version `0.5-demo` specification package. Start by reading:
1. `botamin-voice-agent-spec/corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md`
2. `botamin-voice-agent-spec/CURRENT_DECISIONS.md`
3. `botamin-voice-agent-spec/AGENT_START_HERE.md`
4. `botamin-voice-agent-spec/README.md`
5. `botamin-voice-agent-spec/docs/00-scope-and-assumptions.md`
6. `botamin-voice-agent-spec/docs/03-system-architecture.md`
7. `botamin-voice-agent-spec/docs/05-api-events-data.md`
8. `botamin-voice-agent-spec/docs/08-testing-and-acceptance.md`
9. Your packet under `botamin-voice-agent-spec/tasks/agents/`
10. The assigned records in `botamin-voice-agent-spec/tasks/tasks.yaml`

Assignment:
- Agent: [AGENT_ID]
- Task IDs: [TASK_IDS]
- Branch/worktree: [BRANCH]
- Implementation root: [IMPLEMENTATION_ROOT]

Execution rules:
- Implement the assigned tasks now; do not only write another plan.
- Work only in the task's `owned_paths` unless a shared-contract change is unavoidable.
- Treat contracts as frozen after G0. Put any required contract change in a small explicit commit and explain affected agents.
- Preserve the booking-before-qualification invariant and all security constraints.
- Use fake ports and deterministic fixtures when provider credentials are unavailable.
- Do not commit secrets, Codex auth files, raw production audio, or real PII.
- Keep the project TypeScript + React + Bun and deployable with one Docker Compose as specified.
- OpenRouter is the only P0 STT/TTS gateway and is called only by the backend with one shared server secret. STT uses native Bun `fetch` to `/chat/completions` with one bounded base64 WAV `input_audio` after `audio.commit` and returns only a final transcript—never model it as provider streaming or promise provider partials. TTS uses complete `audio/mpeg` phrase segments and text-only output degradation; the browser never calls OpenRouter.
- Run the relevant typecheck, unit, contract, and integration commands before reporting completion.
- Do not claim a test passed when it was not run.

Required final report:
1. Completed task IDs and implementation summary.
2. Files changed.
3. Commands/tests run with results.
4. Acceptance-criteria evidence.
5. Remaining risks or blocked external smoke tests.
6. Contract changes, if any.
7. Commit hash, patch, or PR reference.
```

## Initial dispatch examples

### A0

```text
Agent: A0 Platform/Contracts
Task IDs: T00
Branch: agent/A0-T00-contracts
Packet: tasks/agents/A0-platform-contracts.md
```

### A5

```text
Agent: A5 Conversation/Prompts
Task IDs: T01 initially; T20 and T31 only after their dependencies/gates
Branch: agent/A5-T01-prompts
Packet: tasks/agents/A5-conversation-prompts.md
```

After A0 freezes shared contracts, dispatch A1, A2, A3, A4, A6, and A7 in separate branches or worktrees.
