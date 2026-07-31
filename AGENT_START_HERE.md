# Agent start here

**Read the authoritative migration first:** [`corrections/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md`](corrections/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md).

This directory is the authoritative **technical specification and delivery handoff** for the Botamin browser voice-sales-agent MVP, version `0.4-demo`. It contains requirements, architecture, task ownership, acceptance criteria, prompts, knowledge, diagrams, and validation scripts. It does **not** contain the finished application.

## 1. Unpack the package

### Linux or macOS

```bash
mkdir -p botamin-agent-work
unzip botamin-voice-agent-agent-handoff-v0.4-demo.zip -d botamin-agent-work
cd botamin-agent-work/botamin-voice-agent-spec
```

To avoid overwriting an earlier extraction:

```bash
rm -rf botamin-agent-work/botamin-voice-agent-spec
unzip botamin-voice-agent-agent-handoff-v0.4-demo.zip -d botamin-agent-work
```

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force botamin-agent-work | Out-Null
Expand-Archive `
  .\botamin-voice-agent-agent-handoff-v0.4-demo.zip `
  -DestinationPath .\botamin-agent-work `
  -Force
Set-Location .\botamin-agent-work\botamin-voice-agent-spec
```

### Headless AI-agent sandbox

Extract into a clean workspace and keep this specification read-only or committed under `spec/`:

```bash
WORKSPACE="$PWD/botamin-implementation"
mkdir -p "$WORKSPACE/spec"
unzip -q botamin-voice-agent-agent-handoff-v0.4-demo.zip -d "$WORKSPACE/spec"
cd "$WORKSPACE/spec/botamin-voice-agent-spec"
```

The implementation repository may be created next to the package, or the A0 agent may create it at the workspace root. Do not accidentally generate application code inside the documentation directory unless the dispatcher explicitly asks for that layout.

## 2. Verify the extraction

The ZIP itself can be checked before extraction:

```bash
unzip -t botamin-voice-agent-agent-handoff-v0.4-demo.zip
```

After extraction, verify content checksums:

```bash
sha256sum -c CHECKSUMS.sha256
```

On macOS without GNU `sha256sum`:

```bash
while read -r expected file; do
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  test "$actual" = "$expected" || { echo "Checksum failed: $file"; exit 1; }
done < CHECKSUMS.sha256
```

Run the package validator:

```bash
python3 -m pip install --user PyYAML
python3 scripts/validate-spec.py
```

Expected final line:

```text
ALL VALIDATIONS PASSED
```

The validator checks local links, task dependencies, diagrams, the assembled HTML specification, required invariants, and basic secret patterns.

## 3. Read the common context before coding

Every agent must read these files, in order:

1. [`corrections/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md`](corrections/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md)
2. [`CURRENT_DECISIONS.md`](CURRENT_DECISIONS.md)
3. [`README.md`](README.md)
4. [`docs/00-scope-and-assumptions.md`](docs/00-scope-and-assumptions.md)
5. [`docs/03-system-architecture.md`](docs/03-system-architecture.md)
6. [`docs/05-api-events-data.md`](docs/05-api-events-data.md)
7. [`docs/08-testing-and-acceptance.md`](docs/08-testing-and-acceptance.md)
8. [`docs/09-agent-task-plan.md`](docs/09-agent-task-plan.md)
9. [`tasks/tasks.yaml`](tasks/tasks.yaml)
10. The agent-specific packet in [`tasks/agents/`](tasks/agents/)

Use [`FULL_SPEC.md`](FULL_SPEC.md) or [`technical-spec.html`](technical-spec.html) when a single consolidated reference is preferable.

## 4. Non-negotiable product invariants

An implementation is invalid if it violates any of these rules:

1. The internal booking is committed **before** optional post-booking qualification begins.
2. A qualification refusal, error, timeout, or disconnect never cancels an existing booking.
3. Repeated `create_booking` calls for the same conversation return the existing booking rather than creating a duplicate.
4. xAI, OpenRouter, and Codex credentials never reach browser code, browser logs, or client-visible events.
5. The assistant never claims that a real calendar event or CRM record was created in this MVP.
6. Prompts and product knowledge remain Markdown files in the repository; no online editor is built.
7. xAI provides streaming STT; Codex subscription with GPT-5.6 Luna is the primary brain, and OpenRouter provides server-side TTS through a TypeScript/Bun adapter.
8. Provider-specific code remains behind the defined ports so the provider can be replaced without rewriting domain logic.

## 5. Dispatch order

### Wave 0: start immediately and in parallel

- **A0 Platform/Contracts** — [`tasks/agents/A0-platform-contracts.md`](tasks/agents/A0-platform-contracts.md)
- **A5 Conversation/Prompts** — [`tasks/agents/A5-conversation-prompts.md`](tasks/agents/A5-conversation-prompts.md)

A0 owns the repository skeleton and shared contracts. A5 can work on knowledge and prompt assets concurrently. The dispatcher should merge or freeze A0 contracts before the remaining implementation agents integrate against them.

### Wave 1: start after Gate G0, in parallel

- **A1 Web Voice** — [`tasks/agents/A1-web-voice.md`](tasks/agents/A1-web-voice.md)
- **A2 Voice Providers (xAI STT + OpenRouter TTS)** — [`tasks/agents/A2-xai-voice.md`](tasks/agents/A2-xai-voice.md)
- **A3 Codex/Luna** — [`tasks/agents/A3-codex-luna.md`](tasks/agents/A3-codex-luna.md)
- **A4 Domain/Data** — [`tasks/agents/A4-domain-data.md`](tasks/agents/A4-domain-data.md)
- **A6 Operations** — [`tasks/agents/A6-ops.md`](tasks/agents/A6-ops.md)
- **A7 QA/Integration** — [`tasks/agents/A7-qa-integration.md`](tasks/agents/A7-qa-integration.md)

A7 should build fixtures and contract tests early rather than waiting for all adapters to finish.

### Later gates

- **G1:** independent adapters pass fake and contract tests.
- **G2:** orchestrator and product UI pass invariant tests.
- **G3:** real end-to-end voice, booking, post-booking qualification, interruption, reconnect, and provider-failure scenarios pass.
- **G4:** clean VPS deployment, backup/restore, security checks, eval evidence, rollback notes, and release tag are complete.

See [`docs/09-agent-task-plan.md`](docs/09-agent-task-plan.md) for the complete dependency graph.

## 6. Recommended repository and branch discipline

A practical layout is:

```text
botamin-implementation/
├── spec/
│   └── botamin-voice-agent-spec/   # this extracted package
├── apps/
├── packages/
├── prompts/
├── knowledge/
├── infra/
└── ...
```

Recommended branch names:

```text
agent/A0-T00-contracts
agent/A5-T01-prompts
agent/A1-T10-web-voice
agent/A2-T11-stt
agent/A2-T12-tts
agent/A3-T13-codex-luna
agent/A4-T14-booking-domain
agent/A6-T15-ops
agent/A7-T22-contract-tests
```

Rules for parallel agents:

- Work only inside the `owned_paths` listed for the assigned task.
- Treat shared contracts as frozen after G0; propose changes in a small explicit contract PR.
- Do not let two agents own the same file or directory concurrently.
- Build against fake ports first; do not block local work on real provider credentials.
- Never commit API keys, Codex auth material, user audio, or real lead PII.
- Record assumptions and deviations in the PR description or an ADR.
- Commit generated files only when the specification explicitly requires them.
- Keep provider smoke tests opt-in and clearly separated from deterministic tests.

## 7. What an agent must return

Each agent handoff should include:

1. A concise implementation summary.
2. The task IDs completed.
3. Files changed, grouped by owned path.
4. Commands run and their results.
5. Acceptance criteria evidence.
6. Remaining risks, assumptions, or provider-dependent checks.
7. Any proposed shared-contract change.
8. A commit hash or patch/PR reference.

An agent must not report completion when required tests were skipped. Provider tests that cannot run because credentials are unavailable should be identified separately from deterministic tests and supported by mocks or protocol fixtures.

## 8. Copy-paste dispatch prompt

Use [`AGENT_DISPATCH_PROMPT.md`](AGENT_DISPATCH_PROMPT.md). Replace the bracketed values and attach either the full archive or the extracted package plus the relevant agent packet.

## 9. Source of truth and conflict resolution

Use this precedence order when documents appear to conflict:

1. `corrections/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md` for all TTS decisions.
2. `CURRENT_DECISIONS.md` and non-negotiable invariants in `README.md` and this file.
3. `tasks/tasks.yaml` acceptance criteria and ownership.
4. `docs/05-api-events-data.md` contracts.
5. Agent-specific task packet.
6. Other explanatory documents.

Do not silently choose between contradictory requirements. Preserve the safer invariant, implement behind a configurable port when possible, and record the discrepancy for the integrator.
