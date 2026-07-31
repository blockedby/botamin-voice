# Validation report — Correction 003 migration

**Date:** 31 July 2026

**Spec version:** `0.4-demo`

**Result:** documentation/backlog/config migration passed

This report covers the migration only. It does not claim an OpenRouter adapter implementation, fake-provider implementation suite, browser playback result, deployment, or real paid smoke.

## Reproducible build

```bash
bash scripts/build-spec.sh
```

`scripts/run-pandoc.sh` pins Pandoc `3.10.1`, using an exact local binary when available and otherwise `pandoc/core:3.10.1`. The build regenerates both maintained charts, `FULL_SPEC.md`, and `technical-spec.html`. DOT sources were rendered with pinned temporary `@viz-js/viz@3.17.0`; all seven SVGs parse successfully.

## Specification validator

```text
VALIDATION NOTES
- Correction 003 precedence, 0.4-demo and OpenRouter TTS invariants verified
- 15 tasks; dependency graph is acyclic
- 8 agent packets
- 7 SVG diagrams
- 3 PNG charts
- HTML embeds 3 raster images and 7 SVGs
- 55 Markdown files

ALL VALIDATIONS PASSED
```

The validator also enforces:

- Correction 003 is the first link in both onboarding files;
- `.env.example` and the architecture env matrix are identical;
- required OpenRouter defaults, paid-use/text-only policy, and complete `audio/mpeg` contracts are present;
- retired active TTS endpoint/variable/package instructions are rejected;
- T12 ownership/title and spec version are correct;
- generated Markdown/HTML contain `0.4-demo` and no stale direct TTS transport text.

## Static repository checks

```text
bun install --frozen-lockfile: passed
bun run typecheck: passed (5 workspaces)
bun test: passed (26 tests, 0 failed)
YAML parse/dependency check: passed (15 tasks, acyclic)
PNG verification: passed (3)
SVG XML parse: passed (7)
git diff --check: passed
sha256sum -c CHECKSUMS.sha256: passed
```

The existing 26 tests are scaffold/contracts/prompt/fake-turn tests; they are not the Correction 003 fake OpenRouter matrix.

## Scope-limited or blocked evidence

- `docker compose config`: not applicable; this repository currently has no `docker-compose.yml`, and this assignment does not implement deployment.
- OpenRouter fake-provider and browser playback suites: not implemented or run in this docs-only migration.
- Real target-VPS Russian OpenRouter smoke: not run; it requires later provider implementation, runtime credentials, paid usage, and a target VPS.
- Text-only runtime fallback: specified and backlogged, not exercised in this migration.
