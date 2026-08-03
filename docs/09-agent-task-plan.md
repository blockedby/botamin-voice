# 09. Параллельный план задач для агентов

## 1. Принцип декомпозиции

Работа делится по стабильным интерфейсам, чтобы агенты могли реализовывать куски с fakes до общей интеграции. Единственная ранняя общая точка — `packages/contracts` и repository skeleton.

Не назначать двум агентам одновременное владение одним каталогом. Изменения общих contracts идут через владельца T00 или отдельный маленький PR.

![Task dependencies](../diagrams/07-task-dependencies.svg)

![Parallel waves](../charts/03-parallel-workstreams.png)

График показывает логические волны/merge gates, а не календарную оценку.

## 2. Владелец путей

| Агент | Основные owned paths |
|---|---|
| A0 Platform/Contracts | `packages/contracts`, root configs, repo skeleton |
| A1 Web Voice | `apps/web/src/audio`, voice state/components |
| A2 Voice providers | `apps/server/src/providers/openrouter/stt/**`, `scripts/openrouter-stt*`, `apps/server/src/providers/openrouter/tts/**`, `scripts/openrouter-tts*` |
| A3 Codex/Luna | `apps/server/src/providers/codex`, generated schemas |
| A4 Domain/Data | `apps/server/src/domain`, `db`, `notifiers`, `drizzle` |
| A5 Conversation | `orchestrator`, `prompt-compiler`, `prompts`, `knowledge` |
| A6 Ops | `Dockerfile`, `docker-compose.yml`, `infra`, run scripts |
| A7 QA/Integration | test harness, Playwright, evals, release evidence |

## 3. Волна 0 — freeze contracts

### T00 — Repository skeleton и shared contracts

**Владелец:** A0  
**Зависимости:** нет  
**Результат:** Bun workspace, React/Bun apps, event/type schemas, fake ports.

Definition of Done:

- `bun install`, `bun run typecheck`, `bun run test` работают;
- contracts не импортируют server/browser-specific code;
- `BrainPort`, atomic final-transcription `SttPort`, complete-segment `TtsPort`, booking schemas и WS event union существуют;
- fake adapters позволяют собрать skeleton E2E;
- formatting/lint/test scripts зафиксированы.

### T01 — Research, claims и prompt skeleton

**Владелец:** A5  
**Зависимости:** нет  
**Можно делать параллельно T00.**

DoD:

- product/use-case/cases/allowed/prohibited claims заполнены;
- каждый case claim имеет source note;
- prompt files имеют ownership и expected headings;
- не зашиты изменяемые цены;
- conversation stages согласованы со spec.

## 4. Волна 1 — независимые adapters

### T10 — Browser voice transport

**Владелец:** A1  
**Зависимости:** T00.

- AudioWorklet capture/resample;
- 100 ms PCM16 frames with bounded browser buffering and the gateway-facing chunk/commit contract;
- explicit `audio.commit`, duplicate suppression and listening/processing/`transcript.final` UI;
- provider-neutral ordered playback queue for complete `audio/mpeg` phrase segments;
- local stop, queue clear, generation cancellation and stale-segment filtering;
- WS client/reconnect;
- transcript/state UI на fake server.

### T11 — OpenRouter phrase-level STT adapter in TypeScript/Bun

**Владелец:** A2  
**Зависимости:** T00.

- native Bun `fetch` to `/api/v1/chat/completions` with configurable audio-input-capable model;
- consume one atomic, already-encoded `audio/wav` request produced by the gateway/utterance assembler after `audio.commit`;
- validate WAV format and request duration/byte bounds, reject raw PCM, then base64-encode unchanged WAV bytes as `input_audio`; the adapter does not implement PCM-to-WAV encoding;
- atomic `SttPort` returns one final transcript;
- connect/total-timeout bounds, at most one retry, abort and stale-turn suppression;
- typed `400/401/402/404/413/429/5xx` without key/audio/PII logs;
- protocol-faithful fake endpoint and opt-in paid Russian smoke;
- retry repeats only transcription and never invokes brain/tools/notifier.

### T12 — OpenRouter TTS adapter in TypeScript/Bun

**Владелец:** A2, отдельный PR/branch после или параллельно T11 при втором агенте  
**Зависимости:** T00.

- provider-neutral `OpenRouterTtsAdapter` behind `TtsPort` using native Bun `fetch`;
- configurable model, voice, response format and optional speed;
- one complete validated MP3 phrase segment per HTTP request;
- AbortSignal cancellation and stale-generation rejection;
- bounded retry, timeout, circuit breaker, character budgets and text-only fallback;
- error mapping for `400/401/402/404/429` and retryable `5xx`;
- Russian external smoke command; character/latency telemetry without spoken-text logging;
- no provider SDK, second runtime or sidecar.

### T13 — Codex app-server/Luna brain adapter

**Владелец:** A3  
**Зависимости:** T00.

- короткий transport spike: зафиксировать, почему официальный TS SDK не покрывает mandatory interrupt/app-server controls на Bun;
- pinned CLI installation contract;
- direct JSONL RPC client за `BrainPort`;
- initialize/model-list/thread/turn/delta/interrupt;
- auth/model health;
- compiled isolated `AGENTS.md` and `instructionSources` verification;
- generated schemas;
- dynamic tool mode;
- envelope fallback;
- process supervisor;
- restricted sandbox tests;
- ADR/evidence по выбранному transport и отклонённым AI SDK variants.

### T14 — Booking, SQLite, notifier

**Владелец:** A4  
**Зависимости:** T00.

- Drizzle schema/migrations;
- idempotency;
- create/patch transactions;
- domain events/outbox;
- console notifier;
- fake webhook interface;
- data redaction/deletion service.

### T15 — Docker/Compose/TLS bootstrap

**Владелец:** A6  
**Зависимости:** T00.

- multi-stage Dockerfile;
- pinned Codex install;
- app/Caddy Compose only for the P0 application path;
- data and `CODEX_HOME` volumes;
- exactly one runtime OpenRouter secret/env matrix for both STT/TTS and two opt-in target-VPS smoke commands;
- healthcheck;
- migration and device-auth runbook;
- prompt compile step into isolated runtime directory;
- non-secret `.env.example`.

## 5. Волна 2 — orchestration и UX

### T20 — Conversation orchestrator

**Владелец:** A5  
**Зависимости:** T01, T11, T12, T13, T14 contracts; может начинаться с fakes после T00.

- deterministic state machine;
- compact prompt context;
- tool policy;
- booking-before-qualification invariant;
- one accepted final STT result starts at most one brain turn; aborted/retried/stale transcription never invokes brain/tools;
- PII-safe bounded phrase chunker/sanitizer for complete OpenRouter MP3 requests;
- turn/generation IDs and stale STT/TTS result rejection;
- TTS budgets, circuit policy and text-only degraded behavior;
- audio failure cannot repeat brain turn or business tools and cannot erase visible text or committed effects.

### T21 — Product landing + integrated voice states

**Владелец:** A1  
**Зависимости:** T10 и server event contracts; real integration после T20.

- Botamin messaging;
- responsive UI;
- consent/mic states;
- transcript;
- booked/qualification/final states;
- accessible controls;
- user-safe errors.

### T22 — Component/contract test matrix

**Владелец:** A7  
**Зависимости:** outputs T10–T15.

- separate gateway PCM16-to-WAV encoder tests and OpenRouter adapter already-WAV request tests;
- protocol-faithful fake OpenRouter `/api/v1/chat/completions` audio-input and `/api/v1/audio/speech` endpoints;
- raw PCM, valid/invalid WAV/MP3 and JSON error fixtures for `400/401/402/404/413/429` and retryable `5xx`;
- timeout, bounded `Retry-After`, abort, malformed/empty body, wrong content type and stale-turn/generation tests;
- state/booking invariants and deterministic retry/circuit assertions;
- secret scan for OpenRouter key in browser bundles, snapshots and logs.

## 6. Волна 3 — integration

### T30 — End-to-end integration

**Владелец:** A7 как integrator; component owners исправляют свои зоны.  
**Зависимости:** T20, T21, T22, T15.

- full browser PCM16 → one gateway-produced validated WAV on `audio.commit` → atomic `SttPort` request → OpenRouter final transcript → Luna → OpenRouter complete MP3 → browser path;
- booking create/update;
- barge-in;
- reconnect;
- provider failure cases;
- Docker deployment smoke;
- opt-in target-VPS OpenRouter Russian STT/MP3 smoke evidence and end-to-end text-only output degradation.

### T31 — Conversation evals/content tuning

**Владелец:** A5 + A7  
**Зависимости:** T30.

- 24+ scripted scenarios;
- tool/order assertions;
- factuality/prohibited claims;
- transcript review;
- prompt changes отдельными commits с before/after evidence.

### T32 — Hardening/observability

**Владелец:** A6 + A7  
**Зависимости:** T30.

- OpenRouter STT commit-to-final duration/bytes/latency/failure/retry/stale metrics and TTS latency/failure/character/circuit metrics;
- STT utterance/request and TTS budget/concurrency/queue/response-size guards;
- logs/redaction;
- backup/restore;
- outbox retry;
- auth failure drill;
- security tests.

## 7. Волна 4 — release

### T40 — Local release candidate

**Владелец:** A0 или release integrator  
**Зависимости:** T31, T32.

**Current label:** `0.5.0-local-rc.4` recommended/pending; no previous immutable image name is assumed.

- RC4 local checks are fresh steps in docs 08/11; RC3 evidence is preserved separately and not inherited;
- active docs describe the durable revisioned draft/fact/conflict model, structured form plus spoken/text parity, two concretely dated Moscow candidates, automatic internal meeting commit/widget, approved-contact TTS exception, and direct missing-only qualification;
- release integrator records actual counts, commands, generated artifacts, and limitations after fresh execution;
- release commit is prepared without inventing or creating a tag/PR/hash;
- WebKit full journey, target VPS/DNS/TLS/WSS, and provider live booking remain external gates.

## 8. Merge gates

### Gate G0 — Contracts frozen

После T00 изменения event/tool schemas требуют explicit review владельцев затронутых adapters.

### Gate G1 — Adapters pass fakes/contracts

T10–T15 могут merge независимо, если:

- не ломают shared contracts;
- имеют fake tests;
- secrets отсутствуют;
- owned paths соблюдены.

### Gate G2 — Orchestrator integration

T20 merge после прохождения invariant suite. Не ждать реальных providers: сначала fakes.

### Gate G3 — External smoke

For the local RC, the committed T30 artifact records owner-observed real local OpenRouter/Codex paths. Paid probes are never part of default verification. Target-host paid smokes remain required only for the later VPS release.

### Gate G4 — RC

The local checklist and known limitations are attached, with no unresolved critical issue inside local scope. WebKit and target VPS/DNS/TLS/WSS are explicit later blockers, so G4 must not be described as a target-VPS release gate.

## 9. Как выдавать задания агентам

Каждому агенту передать:

1. этот spec pack;
2. конкретный файл `tasks/agents/A*.md`;
3. branch name;
4. owned paths;
5. запрет менять shared contracts без отдельного PR;
6. требование приложить test output и assumptions.

Рекомендуемые branches:

```text
agent/platform-contracts
agent/web-voice
agent/openrouter-voice
agent/codex-luna
agent/booking-domain
agent/conversation
agent/ops
agent/qa-integration
```

## 10. Critical path

```text
T00 → T13/T14/T11/T12 → T20 → T30 → T31/T32 → T40
```

T01, T10 и T15 не должны задерживать первые adapter spikes. T20 стартует на fakes сразу после contracts, а затем adapters подменяются по мере готовности.

## 11. Что не распараллеливать

- финальное изменение state/event schemas;
- migration numbering;
- root lockfile после первого scaffold;
- merge orchestration;
- production secrets/auth bootstrap;
- release tag.

## 12. Machine-readable backlog

Полный backlog с dependencies, acceptance и outputs находится в [`../tasks/tasks.yaml`](../tasks/tasks.yaml).
