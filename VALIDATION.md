# Validation report — Correction 004 review fixes

**Date:** 31 July 2026
**Spec version:** `0.5-demo`
**Result:** documentation findings fixed; full validator intentionally blocked by the pre-prerequisite package contract

This report covers REV-001 and REV-002 documentation changes only. It does not edit implementation contracts or claim an OpenRouter STT/TTS provider implementation, browser voice acceptance, deployment, text-only runtime exercise, or paid external smoke.

## Corrected documentation contract

- `transcript.final` is the sole active STT text event and the release checklist requires exactly one current final event per accepted utterance.
- The gateway/utterance assembler owns bounded 16 kHz mono PCM16 assembly and creates exactly one validated WAV after an accepted `audio.commit`.
- Atomic `SttPort` input contains the gateway-produced `audio/wav` bytes.
- `OpenRouterSttAdapter` only validates and bounds the already-WAV request, rejects raw PCM or malformed/incompatible WAV, base64-encodes unchanged bytes, and posts one chat completion.
- Gateway WAV encoder tests and adapter request tests are separate acceptance surfaces.

## Reproducible generated artifacts

DOT files are rendered with pinned temporary `@viz-js/viz@3.17.0`. `scripts/run-pandoc.sh` pins Pandoc `3.10.1`, using an exact local binary when available and otherwise `pandoc/core:3.10.1`. `scripts/build-charts.py` deterministically maintains all three charts.

The pinned render plus `bash scripts/build-spec.sh` was run twice. SHA-256 snapshots of the 12 generated artifacts had no second-build diff:

- 7 `diagrams/*.svg` files;
- 3 `charts/*.png` files;
- `FULL_SPEC.md`;
- `technical-spec.html`.

Generated visible HTML and `FULL_SPEC.md` contain only the active final-transcript contract. Embedded resources are excluded from visible-text scanning to avoid byte-pattern false positives.

## Specification validator and expected prerequisite blocker

`scripts/validate-spec.py` now scans every active text source, contract, fixture, document, `FULL_SPEC.md`, and rendered visible HTML for the retired partial event and session-style STT APIs. Only `corrections/superseded/**` is excluded as historical correction content.

On this documentation branch, the validator is expected to exit nonzero until the separate prerequisite STT-contract migration is merged and this branch is rebased. The remaining findings are confined to these unedited implementation-package files:

- `packages/contracts/src/ports.ts`;
- `packages/contracts/src/ws.ts`;
- `packages/test-fixtures/src/fakes.ts`;
- `packages/test-fixtures/src/full-turn.test.ts`.

Those files still define/use the old partial event and session-oriented STT surface. The current validator reports 21 line-level findings across those four files and no docs/generated finding. Weakening or exempting active package paths would hide the prerequisite defect, so the validator deliberately reports it. After the prerequisite contract lands, the same checks are structured to pass without a docs-side allowlist.

## Repository checks

```text
bun install --frozen-lockfile: passed (Bun 1.3.14; no changes)
bun run build: passed (5 workspaces)
bun run typecheck: passed (5 workspaces)
bun test: passed (76 tests, 0 failed)
```

The passing legacy package tests do not satisfy the corrected atomic STT contract; that is the separate prerequisite migration identified by the validator.

Additional package checks:

```text
YAML DAG: passed (spec 0.5-demo, 15 tasks, 5 gates)
SVG XML / PNG decode: passed (7 SVG, 3 PNG)
retired-provider stale grep: no active matches outside superseded history
retired-STT stale grep: matches confined to the four expected prerequisite package sources
git diff --check: passed
sha256sum -c CHECKSUMS.sha256: passed after artifact regeneration
```

## Integration sequencing

Do not rebase this branch yet. Preserve the Correction 004 source changes. After the prerequisite STT contracts merge, rebase onto current `main`; resolve only generated manifest/checksum/HTML conflicts by regeneration, then rerun the complete validator and repository checks.

## Scope boundaries

- Implementation contracts: **not edited** in this docs commit.
- Paid Russian OpenRouter STT smoke: **not run**.
- Paid Russian OpenRouter TTS smoke: **not run**.
- `docker compose config`: not applicable because this branch has no `docker-compose.yml`.
