# Validation report — local release candidate

**Date:** 1 August 2026

**Spec version:** `0.5-demo`

**Release label:** `0.5.0-local-rc.1`

**Branch:** `release/local-0.5.0-rc1`

**Integrated baseline:** `1b604b8bdf0ab51db4a2c4c3436d41f5c935fe9d` (PR #21)

**Result:** local P0 evidence and handoff gates pass. This report does not claim a target-VPS, public TLS/WSS, or WebKit release.

## Integrated baseline evidence

- Current `main` implementation sequence PRs #6–#21 is present (16 squash commits from atomic MP3 contracts through the PR #21 production journey/local-smoke artifact).
- Integrated PR #21 branch evidence supplied for T40 included passing typecheck, lint/format, build, deterministic spec checks, and a **315-file** checksum set. Its pre-canonical test count is superseded by the release-commit suite below, which excludes ignored generated `dist` output.
- The committed [`evidence/T30-observed-local-voice-smoke-2026-07-31.md`](evidence/T30-observed-local-voice-smoke-2026-07-31.md) is owner-observed real local OpenRouter/Luna evidence: the one-turn path completed final transcript/text/audio events; the five-turn path produced five finals/text/audio completions, exactly one booked SQLite row, and exactly one sent outbox event at attempt 1.
- T30 is local functional evidence only. It is not a target-host run or latency benchmark.

## Observed local runtime and browser evidence

The T40 handoff evidence records:

- `scripts/deploy-local.sh` completed with mode-`0600` materialized files mounted read-only;
- app and Caddy were healthy; dependency readiness reported all checks ready;
- the local endpoint was `http://localhost:5173`;
- Chrome desktop and mobile covered landing, consent, microphone permission denial, the safe denied state, zero fetch/WebSocket activity before microphone permission, and no horizontal overflow.

This documentation pass did not repeat a credentialed deploy, browser session, or paid provider request. The observations above are retained with that provenance rather than represented as fresh T40 automation.

## Fresh credential-free T40 verification

After `bun install --frozen-lockfile` restored the locked workspace dependencies:

```text
bun run test: 433 passed, 0 failed across 54 files (3,788 assertions), both before and after bun run build
bun run typecheck: passed (contracts, prompt compiler, test fixtures, web, server)
bun run lint:format: passed (141 files, no fixes)
bun run build: passed (all five workspaces; production web bundle built)
scripts/build-spec.sh + update-release-artifacts.py twice: byte-identical 14-artifact hash sets (7 SVG, 3 PNG, FULL_SPEC.md, technical-spec.html, MANIFEST.txt, CHECKSUMS.sha256)
scripts/validate-spec.py: ALL VALIDATIONS PASSED
active retired-provider/retired-STT scan: 0 matches; superseded correction excluded
docker compose config --quiet: passed with safe /dev/null secret defaults
shell syntax: all scripts/*.sh and infra/entrypoint.sh passed
scripts/test-compose-file-secrets.sh: passed read-only rotated-inode remount engine smoke
CHECKSUMS.sha256: 317 files verified after release artifact regeneration
git diff --check: passed
```

## Active contract and secret boundary

- OpenRouter remains the only STT/TTS gateway and uses one backend-only `OPENROUTER_API_KEY`.
- Browser PCM16 is bounded and assembled into one validated WAV after `audio.commit`; provider STT is phrase-level and nonstreaming and emits one current `transcript.final`.
- `scripts/deploy-local.sh` parses `.env` without shell evaluation, materializes private file sources, exports only `*_FILE` paths, and force-recreates app before readiness.
- Codex device auth persists in the fixed `botamin-codex-home` volume and must be protected as a password-like secret.
- Paid OpenRouter/Codex smokes are explicit owner opt-ins and were not called by T40 verification.

## Scope boundaries and remaining blockers

Local P0 checklist: **passed**; see [`docs/11-local-release-handoff.md`](docs/11-local-release-handoff.md).

Outstanding later gates:

- WebKit complete-MP3 playback and voice journey remain unobserved.
- Target VPS resource behavior, clean deploy, DNS, public TLS/WSS, and target-host paid smokes remain unobserved.
- Local synthetic timings are functional sequencing evidence, not benchmark/SLO evidence.
- The app creates one internal SQLite booking and notifier outbox event; it does not create a real calendar/CRM record or meeting invitation.
- OpenRouter model/voice availability and rates, Codex plan suitability/capacity, privacy copy, and public commercial operation require owner review at the later target-host gate.

No Git tag was created. Exact recommendation after owner acceptance: `v0.5.0-local-rc.1`.
