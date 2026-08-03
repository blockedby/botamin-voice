# Validation report — RC4 local release handoff

**Date:** 2 August 2026 (UTC)

**Spec version:** `0.5-demo`

**Release label:** `0.5.0-local-rc.4` (recommended; tag pending)

**Candidate branch:** `feat/conversation-memory-virtual-meeting`

**Integrated implementation baseline:** `58aa9ee99b2daa4e6d8bceacb537f117cb6fbf1c`; closure fixes and evidence are recorded by the later commits on this branch.

**Release commit:** pending final branch commit; no hash is predeclared in this artifact.

**Result:** RC4 implementation, closure fixes, documentation, local cutover safety, and generated specification are prepared. The full provider-independent test suite, typecheck, build, Biome, evals, spec validation, Compose static validation, and Chromium desktop/mobile landing smoke pass. This report does **not** claim the external gates listed below.

This report does not claim a WebKit/full voice journey, owner-configured live local cutover, target-VPS resources, DNS, public TLS/WSS, target-host provider live booking, external calendar availability/event/invite, or CRM integration.

The prior RC3 report is preserved verbatim at [`evidence/VALIDATION-local-rc3-2026-08-02.md`](evidence/VALIDATION-local-rc3-2026-08-02.md) and is historical only.

## RC4 behavior synchronized to code

- `0004_conversation_contexts.sql` adds one compact row per conversation with nonnegative revision, valid JSON object, matching draft/fact-registry revisions, matching timestamp, and cascade ownership. It does not add fact/evidence/meeting tables or backfill RC3 rows.
- Internal JSON preserves facts, provenance, bounded conflicts, exactly two candidate identities, selected candidate, readiness, exact-revision confirmation, commit state, booking ID, and timestamps. Browser projection strips conversation ownership, provenance, and evidence text.
- Typed and spoken final turns use one accepted-turn/fact/scheduling/draft path. The structured form submits revisioned field/candidate commands into the same draft; it is not encoded as visitor text and cannot directly create a booking.
- Scheduling always supplies exactly two current internal 20-minute Moscow candidates with concrete dates/times. Supported concrete date/time requests return exact+alternative or nearest internal candidates; stale/non-candidate selections fail closed.
- Exact confirmation of a ready current revision automatically performs one idempotent booking commit. A bounded DB-only startup/periodic sweeper recovers orphaned `committing` drafts without a session or provider call while leaving visitor confirmation/qualification pending. Only the durable booking derives the `internal_virtual` / `scheduled` projection and final widget; both external calendar/invite flags are false.
- Qualification begins directly after truthful meeting confirmation and asks only missing facts. Volume precedes manager count only when both are missing; one known asks only the other; both known asks nothing. Generic daily volume requires working/calendar-day clarification.
- Contact-shaped text is redacted from TTS by default. The narrow exception requires active contact-processing consent and an exact server-approved accepted-draft or committed-booking contact.
- Fixture eval evidence is 44 scenarios, 25 applicable booking-order checks, and 28 negative controls. It is fixture-only with zero provider calls and real Luna not run.

## Local cutover safety

`scripts/deploy-local.sh` now:

1. materializes file-backed secrets and renders/scans Compose configuration without changing `.env`;
2. builds and checks the image before cutover;
3. creates a protected `VACUUM INTO` backup before schema mutation when an existing DB is present;
4. gracefully stops a running app before migration, preventing live SQLite schema mutation races;
5. starts the replacement with `AUTO_MIGRATE=true`, so the normal entrypoint migrates before server startup;
6. requires bounded `/health/ready`;
7. runs PII-safe `db.js verify-rc4` after readiness.

`verify-rc4` checks SQLite integrity, exact context columns/FK/check constraints, persisted JSON/revision/timestamp consistency, `foreign_key_check`, and absence of duplicate fact/evidence/virtual-meeting tables. RC3→RC4 migration tests preserve an existing booking and leave the new context table empty until normal RC4 behavior initializes rows.

Rollback boundary: migrations are forward-only. Do not reverse `0004` in place. Use an owner-retained immutable previous image only after proving it tolerates the forward schema; otherwise stop and restore the matching protected pre-cutover backup. This handoff invents no predecessor tag/image/digest.

## Fresh command evidence

```text
bun install --frozen-lockfile: passed; Bun 1.3.14, 188 packages installed, lockfile unchanged
bun run typecheck: passed across contracts, prompt compiler, fixtures, web, and server
bun run build: passed across all workspaces; production web/server bundles built
bun run lint:format: passed, 173 files checked, no fixes
bunx biome check infra/ops/db.ts infra/ops/db.test.ts infra/ops/scripts.test.ts: passed

repository-wide test command: 715 passed, 0 failed across 68 files (11,633 assertions)
focused infra/ops command: 19 passed, 0 failed (147 assertions)
offline eval: 44/44 scenarios; 25/25 booking-order; 28/28 negative controls; zero critical failures
bun evals/src/generate-baseline.ts --check: deterministic artifact current

bun run test:browser:chromium: 2 passed
  - chromium-desktop landing smoke
  - chromium-mobile landing smoke
This is not a full voice journey.

sh -n deploy/backup/restore/rollback scripts: passed
docker compose config --quiet: passed
scripts/build-spec.sh + scripts/validate-spec.py: ALL VALIDATIONS PASSED
  - 15 tasks, 8 agent packets, 7 SVGs, 3 PNGs
  - generated HTML embeds 3 raster images and 7 SVGs
scripts/update-release-artifacts.py: MANIFEST/CHECKSUMS regenerated for 368 files
sha256sum -c CHECKSUMS.sha256: 368 files OK
git diff --check: passed
```

The prior integration-harness failures were closed by updating the provider contract and production-component journey to the RC4 exact-draft-confirmation lifecycle. The canonical credential-free suite is green; this does not substitute for the provider and browser external gates.

## Privacy and retention boundary

- Raw audio remains off by default.
- Startup/hourly retention deletes expired `turns` and `conversation_contexts` in bounded batches while preserving conversations and bookings.
- Explicit conversation deletion removes booking, context, turns, idempotency rows, related outbox entries, and conversation in one immediate transaction.
- Existing append-only domain events are already redacted and remain; deletion appends one additional count-only `privacy.deleted` event. The transcript-retention worker does not expire domain events.
- Local backup tooling creates mode-`0600` database/checksum files but does not implement encryption or automatic backup retention; those remain host-owner responsibilities.

## Browser and external gates

- **Chromium desktop/mobile:** landing smoke passed through the repository Playwright harness. No full voice booking journey is claimed.
- **WebKit:** not run. The browser binary is downloaded, but host libraries `libicu74`, `libxml2`, and `libflite1` are missing.
- **Live local Compose cutover:** not run by this handoff because configured owner credentials/volume were not used; deterministic fake-Docker ordering, shell syntax, Compose rendering, DB migration/backup/restore, and invariant checks passed.
- **Provider live booking:** not run. Fixture evals and synthetic component tests do not substitute for a real OpenRouter STT/TTS + Codex Luna booking journey.
- **Target VPS / DNS / TLS / WSS / provider smokes / load:** not run.

Recommended tag after owner acceptance and closure of required gates: `v0.5.0-local-rc.4` (pending; not created here).
