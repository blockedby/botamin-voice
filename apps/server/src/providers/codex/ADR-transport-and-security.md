# T13 transport and security evidence

**Decision:** direct newline-delimited JSON-RPC over stdio to one supervised `codex app-server` process.

## Pin

- Codex CLI and schema generator: `codex-cli 0.146.0`.
- Compared official SDK: `@openai/codex-sdk@0.146.0`.
- Protocol bundles: stable/shared and v2 JSON schemas generated with `--experimental`; hashes are in `packages/codex-schemas/protocol-version.json`.
- Upgrades must run `bun scripts/codex-generate-schemas.ts --check`; a mismatch fails instead of being accepted at runtime.

## Bounded SDK gate

Reproduce with:

```bash
bun scripts/codex-sdk-spike.ts
```

The spike downloads the pinned package to an OS temporary directory, imports it with Bun, and inspects its published TypeScript declarations. Bun can import the package and the public SDK has streamed run events, thread IDs, abort-signal cancellation and structured output. Its package still declares Node `>=18`, and its public surface does **not** expose the mandatory app-server handshake/model list, addressable `turn/interrupt`, `instructionSources`, or dynamic tool registration. AbortSignal cancellation of an SDK `codex exec` child is not proof of an addressable interrupt on a shared long-lived process. Therefore the SDK fails the mandatory-control gate and is not installed in production.

No community wrapper was evaluated further: it would add an untrusted abstraction over the exact protocol details this adapter must verify.

## Runtime controls

- The app-server child receives an allowlisted environment only. Application keys, database configuration and arbitrary `.env` values are not inherited.
- App-server is started with strict config; shell/unified-exec, shell snapshots, web search, apps/connectors, plugins, in-app browser, network proxy, multi-agent tools, memories and MCP servers are disabled.
- Every thread and turn uses `approvalPolicy: never`, read-only sandbox with network denied, one isolated runtime workspace root and the configured model/effort. `environments` is omitted only on thread start/resume because CLI 0.146.0 returns no `instructionSources` when an empty environment list is supplied; every model turn explicitly sends `environments: []`, after instructions have been verified.
- The runtime directory must be absolute, contain exactly one read-only regular `AGENTS.md`, and no other file. `thread/start`/`thread/resume` must report exactly that file in `instructionSources`, the expected cwd, approval policy and read-only/network-denied sandbox.
- Only the two backend action descriptions can be registered as dynamic tools. Their arguments are validated again by frozen shared schemas and checked against `allowedActions`; unsupported server requests fail closed.
- In envelope mode, streamed JSON is buffered, checked by `BrainEnvelopeSchema`, then mapped to provider-neutral `BrainDelta` values.
- Protocol stdout and stderr contents are never logged. Only redacted lifecycle fields and stderr byte counts are available.

Disabling all model shell/network tools is the primary control that prevents reads of source, `.env`, auth and database paths. The isolated cwd and environment allowlist are defense in depth. Container mount isolation remains an operations-layer requirement for production.

## Recovery and identity

The JSONL client bounds each line, times out every request, and removes timed-out/exited requests from its pending map. Process exit rejects active turns with a provider-neutral safe error and schedules exponential-backoff restart. Threads are resumed and instruction sources re-verified after restart.

External `turnId` is mapped to the provider's returned turn ID. `turn/interrupt` always uses the provider ID. Deltas and terminal events are accepted only when both provider `threadId` and provider `turnId` match the active external turn/generation. Terminal turns are marked before queue closure, so late deltas cannot cross into a new generation.

## External preflight

Compile prompts to a directory outside the repository, then run:

```bash
CODEX_HOME=/absolute/protected/codex-home \
CODEX_CWD=/absolute/isolated/runtime-brain \
bun scripts/codex-preflight.ts
```

Output is metadata only: CLI version, configured model, health, prompt hash, instruction-source verification, whether a text delta streamed, whether addressable interrupt was sent, raw terminal status, completion and the fixed security profile. It never prints auth data, prompts or model text. If `gpt-5.6-luna` is absent, health returns `CODEX_MODEL_OR_EFFORT_UNAVAILABLE`; the script exits nonzero and never substitutes another model.
