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
| A2 xAI Voice | `apps/server/src/providers/xai` |
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

- `bun install`, `bun run typecheck`, `bun test` работают;
- contracts не импортируют server/browser-specific code;
- `BrainPort`, `SttPort`, `TtsPort`, booking schemas и WS event union существуют;
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
- 100 ms PCM16 frames;
- PCM playback queue;
- generation cancellation;
- WS client/reconnect;
- transcript/state UI на fake server.

### T11 — xAI Streaming STT adapter

**Владелец:** A2  
**Зависимости:** T00.

- WSS lifecycle;
- raw PCM relay;
- Smart Turn mapping;
- timeout/error/backpressure;
- fake/contract tests;
- redacted telemetry.

### T12 — xAI Streaming TTS adapter

**Владелец:** A2, отдельный PR/branch после или параллельно T11 при втором агенте  
**Зависимости:** T00.

- persistent/multi-utterance WSS;
- text delta → audio chunks;
- PCM decode metadata;
- cancellation;
- Russian voice smoke comparison for `iris` and `eve`;
- selected voice remains env-configurable;
- cost character counter.

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
- app/caddy compose;
- volumes;
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
- sentence chunker/sanitizer;
- interruption generation IDs;
- timeout/retry/degraded behavior.

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

- provider contract test harness;
- state/booking invariants;
- protocol fixtures;
- secret scan;
- fake server/browser audio fixtures.

## 6. Волна 3 — integration

### T30 — End-to-end integration

**Владелец:** A7 как integrator; component owners исправляют свои зоны.  
**Зависимости:** T20, T21, T22, T15.

- full browser → STT → Luna → TTS path;
- booking create/update;
- barge-in;
- reconnect;
- provider failure cases;
- Docker deployment smoke.

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

- latency metrics;
- concurrency guard;
- logs/redaction;
- backup/restore;
- outbox retry;
- auth failure drill;
- security tests.

## 7. Волна 4 — release

### T40 — Release candidate

**Владелец:** A0 или release integrator  
**Зависимости:** T31, T32.

- all gates green;
- compose clean deploy;
- docs match code;
- known limitations;
- redacted demo payloads;
- rollback instructions;
- tag/release commit.

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

Реальные xAI/Codex tests проходят на VPS/staging с tagged test command.

### Gate G4 — RC

Acceptance checklist полностью приложен, critical known issue отсутствует.

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
agent/xai-voice
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
