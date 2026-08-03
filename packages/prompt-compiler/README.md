# @botamin/prompt-compiler

Compiles the repository-owned Botamin Markdown prompts and knowledge into the only runtime instruction file, `AGENTS.md`.

## Contract

- Inputs are the exact allowlist exported as `PROMPT_ORDER`.
- Order is fixed: system, product, conversation policy, objections, booking, qualification, speech style, then overview, use cases, cases, FAQ, allowed claims, and prohibited claims.
- CRLF and CR line endings are normalized to LF; every source gets one final newline in the bundle.
- `promptVersion` is the lowercase, 64-character SHA-256 hex digest of the exact UTF-8 bytes written to `AGENTS.md`.
- Every file must be regular UTF-8 Markdown with its exact required headings, heading levels, and order.
- A source file is limited to 16 KiB; the compiled bundle is limited to 128 KiB.
- Secret-like material, non-canonical numeric currency claims, and stale robotic, call/callback, connection-diagnosis, personal-name, or long-form guidance fail compilation.
- The sole numeric revenue exception is the exact attributed, non-guaranteed user-brief hook enforced by compiler constants and tests.
- Discovery and value must precede booking; the exact booking-before-qualification invariant remains required in both `prompts/system.md` and `prompts/booking.md`.
- Natural-dialogue invariants and bad-to-concise examples are synchronized with `starter/prompts/`; ordinary speech targets one 6–14-word sentence and has a 22-word/eight-second ceiling.

The heading allowlist is intentionally strict. A content owner adding or renaming a heading must review and update the compiler contract and focused tests in the same change.

## Isolated runtime output

`runtimeDir` must resolve outside `sourceRoot`, and no existing runtime path component may be a symlink. Source files and their immediate source directories may not be symlinks. The runtime directory may contain only a regular `AGENTS.md`; unexpected files or symlinks cause a safe failure.

Compilation writes one file and sets it to mode `0444`. It does not copy the source repository, knowledge files, environment files, credentials, database content, or a manifest into runtime. The returned/printed metadata contains only the hash, path, byte count, and source-file order. Deployment must mount only this isolated runtime directory into the Codex working directory.

## Package-local commands

No credentials or root workspace configuration are required.

```bash
bun install --frozen-lockfile
bun run --cwd packages/prompt-compiler check
```

Compile production JavaScript and create a runtime bundle:

```bash
bun run --cwd packages/prompt-compiler build
bun packages/prompt-compiler/dist/src/cli.js \
  --source-root ../.. \
  --runtime-dir /app/runtime-brain
```

The CLI prints metadata JSON only. Consumers should persist `promptVersion` with the conversation and verify that Codex `instructionSources` includes the generated `AGENTS.md` before accepting traffic.
