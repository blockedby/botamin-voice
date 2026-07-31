# Agent A0 — Platform and contracts

## Mission

Freeze provider-neutral voice contracts: `SttPort` is one atomic bounded final-transcription request/result, while `TtsPort` returns complete `audio/mpeg` phrase segments. No provider SDK or HTTP types may enter shared packages.

Создать repository skeleton и заморозить shared contracts, чтобы остальные агенты работали параллельно через fakes.

## Read first

- `docs/00-scope-and-assumptions.md`
- `docs/03-system-architecture.md`
- `docs/05-api-events-data.md`
- task T00 in `tasks/tasks.yaml`

## Branch and ownership

Branch: `agent/platform-contracts`.

Владей root workspace config, `packages/contracts`, baseline `apps/web`, `apps/server`, `packages/test-fixtures`. Не реализуй providers или product UI.

## Deliverables

- Bun workspace with React/Vite and Bun server packages.
- Strict TypeScript and shared Zod schemas.
- Discriminated unions for all WS events.
- Ports: Brain, STT, TTS, Notifier, Booking repository/service.
- Provider-neutral `SttPort`: request contains conversation/turn identity, one gateway-produced bounded and validated `audio/wav` payload, language and `AbortSignal`; result contains one final transcript. Its operations are atomic `transcribe` and `health` only.
- Browser WS remains independently chunked PCM16 with explicit `audio.commit`; the gateway/utterance assembler owns PCM16-to-WAV encoding, and raw PCM/backend transport types do not leak into `SttPort`.
- Provider-neutral `TtsPort`: request includes conversation/turn/generation/segment IDs, text and `AbortSignal`; response is one `final: true` complete `audio/mpeg` segment with `Uint8Array` bytes.
- Provider-neutral WS `audio.segment` metadata with generationId, segmentId, sequence, content type and complete binary payload.
- Fake adapters and one fake full-turn test.
- Root scripts: typecheck, test, lint/format, build.
- ADR note for any deviation from the spec.

## Non-negotiables

- No secrets, no provider credentials, no online editor.
- Booking and qualification schemas must encode the ordering invariant.
- Contracts package stays runtime-neutral; no OpenRouter SDK/HTTP response types or other provider-specific types.
- Do not choose a production database/provider package on behalf of another agent.

## Completion report

Return commit SHA, changed paths, commands run, test output summary, unresolved assumptions, and any proposed contract change requiring review.
