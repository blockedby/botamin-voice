# Starter prompt bundle

This starter mirrors the RC4 conversation policy; it is a compact source template, not a separate runtime implementation.

1. Copy `prompts/` and `knowledge/` into the repository root and keep deterministic compiler ordering/headings.
2. Compile only the allowlisted bundle into isolated `/app/runtime-brain/AGENTS.md`; never mount source, `.env`, SQLite, or credentials into the brain directory.
3. Treat backend context as authoritative. Spoken and typed final turns have equal semantic authority, while the structured form updates the same durable revisioned booking draft.
4. Offer exactly two server-supplied internal Moscow candidates with concrete dates/times. Never calculate availability or claim that the pair is exhaustive.
5. Commit only after the exact ready draft revision is confirmed. Describe the result as a scheduled internal virtual meeting and state that no external calendar event/invite was created.
6. Start optional qualification directly after truthful meeting confirmation. Ask only missing `monthlyLeadVolume` / `salesManagerCount` facts and never repeat known values.
7. Keep spoken Russian concise and natural: usually no more than two short sentences/about twelve seconds, one useful thought, and at most one question; avoid filler acknowledgements and invented progress.
8. Emit only plain speech text. Provider delivery style is server-owned (`neutral|curious|serious|excited`), never authored in prompts/transcript; sensitive facts stay neutral. Redact contacts unless the server approves an exact accepted-draft/committed-booking value under active contact consent.
9. Compute and persist SHA-256 `promptVersion`; validate numeric case claims against source policy before release.

The full source prompts contain the binding ownership/security details. The starter files must be updated whenever those RC4 behaviors change.
