# Validation report — Correction 004 migration

**Date:** 31 July 2026
**Spec version:** `0.5-demo`
**Result:** documentation/backlog/config migration passed

This report covers the Correction 004 migration only. It does not claim an OpenRouter STT/TTS provider implementation, the backlogged fake-provider suites, browser voice acceptance, deployment, text-only runtime exercise, or a paid external smoke.

## Official evidence verified

- `https://openrouter.ai/docs/guides/overview/multimodal/audio`: audio input uses `/api/v1/chat/completions`, base64 `input_audio`, model-dependent formats and audio-input model filtering. The active evidence does not document a dedicated realtime STT WebSocket.
- `https://openrouter.ai/api/v1/models/openai/gpt-audio-mini/endpoints`: current endpoint evidence reports `audio` in `input_modalities` for the configurable default `openai/gpt-audio-mini`.

No paid request was sent while verifying these public pages.

## Reproducible generated artifacts

DOT files were rendered with pinned temporary `@viz-js/viz@3.17.0`. `scripts/run-pandoc.sh` pins Pandoc `3.10.1`, using an exact local binary when available and otherwise `pandoc/core:3.10.1`. `scripts/build-charts.py` deterministically maintains all three charts.

The pinned render plus `bash scripts/build-spec.sh` was run twice. SHA-256 snapshots of these 12 artifacts had no diff:

- 7 `diagrams/*.svg` files;
- 3 `charts/*.png` files;
- `FULL_SPEC.md`;
- `technical-spec.html`.

## Specification validator and YAML DAG

```text
VALIDATION NOTES
- Correction 004 precedence, 0.5-demo and OpenRouter-only voice invariants verified
- Correction 003 is marked superseded and excluded from active/generated instructions
- 15 tasks; dependency graph is acyclic
- 8 agent packets
- 7 SVG diagrams
- 3 PNG charts
- HTML embeds 3 raster images and 7 SVGs
- 57 active Markdown files

ALL VALIDATIONS PASSED
```

The validator enforces:

- Correction 004 is the first link in both onboarding files;
- Correction 003 has the exact superseded header and is absent from active/generated instructions;
- `.env.example` and the architecture dotenv matrix are identical;
- one shared `OPENROUTER_API_KEY` plus exact STT defaults and retained TTS defaults;
- exact T11/T12 titles and owned paths;
- no active retired provider string, key, path, packet, chart, source or `transcript.partial` event;
- atomic WAV/final-transcript STT and complete-MP3 TTS invariants;
- local links, task IDs/gates, acyclic YAML DAG, SVG/PNG sanity, standalone embedded HTML and basic secret patterns.

A separate YAML check reported `spec_version=0.5-demo`, 15 tasks, five gates and an acyclic graph.

## Repository checks

```text
bun install --frozen-lockfile: passed
bun run typecheck: passed (5 workspaces)
bun test: passed (65 tests, 0 failed)
PNG verification: passed (3/3)
SVG XML parse: passed (7/7)
git diff --check: passed
sha256sum -c CHECKSUMS.sha256: passed for every manifest entry
```

An initial test command was started in parallel with dependency installation and failed on transient module resolution. It was classified as command-ordering/infrastructure evidence; the required sequential post-install rerun above passed all 65 tests. The existing suite does not constitute the backlogged OpenRouter STT/TTS fake-provider acceptance matrix.

## Stale-source and scope checks

The retired-provider grep over the repository, excluding `corrections/superseded/**` and embedded HTML base64, returned no matches after manifest/checksum regeneration. Generated visible HTML is checked separately by the validator because arbitrary embedded base64 can coincidentally contain short character sequences.

- `docker compose config`: not applicable; this repository has no `docker-compose.yml`, and deployment implementation is outside this migration.
- Paid Russian OpenRouter STT smoke: **not run**; no adapter/credentialed paid request is in scope.
- Paid Russian OpenRouter TTS smoke: **not run**; no adapter/credentialed paid request is in scope.
- Text-only runtime fallback: specified/backlogged, not exercised in this migration.
