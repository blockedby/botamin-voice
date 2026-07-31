# Validation report — Correction 004

**Date:** 31 July 2026

**Spec version:** `0.5-demo`
**Result:** documentation, backlog, generated artifacts, and atomic STT contract integration passed

This report covers the OpenRouter-only voice migration and its shared atomic STT prerequisite. It does not claim provider adapters, browser acceptance, deployment, runtime degradation drills, or paid external smokes.

## Active contract

- OpenRouter is the only STT/TTS gateway and uses one backend-only `OPENROUTER_API_KEY`.
- Browser PCM16 chunks end with one accepted `audio.commit`.
- The gateway creates one bounded mono PCM16 16 kHz WAV.
- Atomic `SttPort` receives that `audio/wav` and returns one current `transcript.final`; no provider session or partial event exists.
- `OpenRouterSttAdapter` validates and base64-encodes the existing WAV without wrapping it again.
- TTS returns complete provider-neutral `audio/mpeg` phrase segments using the canonical nine-byte binary framing contract.

## Reproducible artifacts

`scripts/run-pandoc.sh` pins Pandoc `3.10.1`; diagram rendering uses `@viz-js/viz@3.17.0`; chart generation is deterministic. Two complete builds produced no second-build diff across seven SVGs, three PNGs, `FULL_SPEC.md`, and `technical-spec.html`.

## Verification

```text
scripts/validate-spec.py: ALL VALIDATIONS PASSED
CHECKSUMS.sha256: 164 files OK
YAML DAG: 15 tasks, 5 gates, acyclic
SVG/PNG validation: 7 SVG and 3 PNG passed
OpenRouter-only env/tasks/agent packets: passed
Correction 003 superseded/excluded: passed
retired provider and retired STT source scan: zero active matches
bun run typecheck: passed (5 workspaces)
bun test: passed (81 source tests, 0 failed)
bun run lint:format: passed
bun run build: passed
git diff --check: passed
```

The validator was also probed with disposable retired partial-event and provider-session constructs and rejected all of them as intended.

## Scope boundaries

- OpenRouter STT/TTS adapters and fake HTTP provider suites: not implemented by this documentation migration.
- Paid Russian OpenRouter STT smoke: not run.
- Paid Russian OpenRouter TTS smoke: not run.
- `docker compose config`: not applicable to this branch; T15 is integrated separately.
