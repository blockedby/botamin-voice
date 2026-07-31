STATUS: SUPERSEDED BY CORRECTION-004_OPENROUTER_VOICE_ONLY.md
DO NOT IMPLEMENT

# CORRECTION-003 — OpenRouter TTS, TypeScript-native implementation

**Проект:** Botamin Voice Sales Agent
**Статус:** APPROVED / обязательная корректировка
**Дата:** 2026-07-31
**Целевая версия спецификации после применения:** `0.4-demo`
**Область:** TTS, deployment, тесты, документация и backlog

> **Инструкция агенту:** применить этот документ перед продолжением реализации. Сначала исправить активную документацию и `tasks/tasks.yaml`, выполнить spec-validation и зафиксировать отдельный commit. Затем реализовывать TTS по обновлённым задачам.

---

## 0. Приоритет и отмена предыдущих решений

Этот документ имеет максимальный приоритет в вопросах TTS и отменяет:

1. `CORRECTION-002-EDGE-COMMUNITY-TTS-DEMO.md` целиком;
2. `CORRECTION_002_EDGE_COMMUNITY_TTS.md` целиком;
3. `EDGE_TTS_IMPLEMENTATION_DECISION.md` целиком;
4. все активные требования к `edge-tts`, `msedge-tts`, Python sidecar, Microsoft Edge Read Aloud consumer endpoint и голосам `ru-RU-SvetlanaNeural` / `ru-RU-DariyaNeural`;
5. прямое использование xAI TTS из базовой спецификации;
6. конфликтующие части `CORRECTION-001 — OpenRouter TTS`.

`CORRECTION-001` можно использовать только как исторический материал. Нормативным источником для новой реализации является **только этот документ плюс базовая спецификация в непротиворечащей части**.

### Обязательное действие с устаревшими файлами

Переместить старые корректировки в:

```text
corrections/superseded/
```

и добавить в начало каждого файла:

```text
STATUS: SUPERSEDED BY CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md
DO NOT IMPLEMENT
```

Они не должны попадать в собранный `FULL_SPEC.md`, `technical-spec.html`, onboarding flow или активные задания агентам.

---

## 1. Новое окончательное решение для P0-демо

Использовать OpenRouter как единственный TTS gateway P0:

```dotenv
TTS_PROVIDER=openrouter
OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
```

Реализация должна быть полностью на TypeScript/Bun:

- серверный `fetch` к OpenRouter;
- без Python;
- без sidecar-контейнера;
- без `edge-tts` и `msedge-tts`;
- без обязательного OpenAI SDK или универсального AI SDK;
- OpenRouter key находится только на backend;
- выбранная модель и голос задаются environment variables;
- при TTS failure приложение продолжает работать в text-only режиме.

### Целевой pipeline

```text
Browser microphone
        ↓
React audio client
        ↓ PCM16 / application WebSocket
Bun backend
        ↓
xAI Streaming STT
        ↓ final transcript
ConversationOrchestrator
        ↓
Codex subscription / GPT-5.6 Luna
        ↓ streamed text deltas
speech sanitizer + phrase chunker
        ↓
OpenRouterTtsAdapter on Bun
        ↓ POST /api/v1/audio/speech
OpenRouter TTS
        ↓ complete MP3 phrase segment
Bun WebSocket gateway
        ↓
Browser playback queue
```

### Что не меняется

- xAI остаётся STT-провайдером;
- Codex subscription + `gpt-5.6-luna` остаются LLM-мозгом;
- `BrainPort`, `SttPort`, `TtsPort` и domain ports сохраняются;
- booking создаётся **до** qualification;
- qualification остаётся опциональной и дополняет существующий `bookingId`;
- TTS retry или failure никогда не повторяет LLM turn и business tools;
- промпты остаются Markdown-файлами;
- реальная встреча в календаре не создаётся;
- проект остаётся одним TypeScript full-stack приложением в одном Docker Compose.

---

## 2. Почему это решение принято

### Плюсы

- владелец уже использует OpenRouter;
- единая API-авторизация вместо отдельного xAI TTS billing/auth;
- dedicated TTS endpoint принимает обычный JSON и возвращает raw audio bytes;
- интеграция выполняется нативным Bun `fetch`;
- нет второго runtime, Python image и private HTTP sidecar;
- TTS-модель можно сменить через конфигурацию, не затрагивая orchestration и domain logic;
- OpenRouter endpoint совместим по форме с OpenAI Audio Speech API, но SDK для P0 не требуется.

### Цена решения

- OpenRouter и upstream-провайдер становятся внешними зависимостями;
- TTS требует credits и не считается бесплатным;
- voice IDs и доступные параметры зависят от модели;
- HTTP TTS не является одной постоянной realtime speech-to-speech сессией;
- MP3 удобнее и надёжнее для браузера, но требует phrase segmentation для приемлемой задержки;
- модель или цена могут измениться, поэтому slug и voice нельзя зашивать в business logic.

### ADR

Добавить в `docs/07-tradeoffs-and-adrs.md`:

```text
ADR-015 — OpenRouter is the P0 TTS gateway
Status: accepted

Use a TypeScript/Bun adapter with native fetch against
POST https://openrouter.ai/api/v1/audio/speech.
Default profile: x-ai/grok-voice-tts-1.0 / eve / mp3.
Do not use Edge Community TTS, Python sidecars or direct xAI TTS in P0.
Keep TtsPort provider-neutral and retain text-only degradation.
```

---

## 3. OpenRouter API contract

### Endpoint

```http
POST https://openrouter.ai/api/v1/audio/speech
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
```

Optional attribution headers:

```http
HTTP-Referer: https://<public-site-host>
X-OpenRouter-Title: Botamin Voice Demo
```

When the account or preset could enable response caching, explicitly disable it for user-specific speech:

```http
X-OpenRouter-Cache: false
```

### P0 request

```json
{
  "model": "x-ai/grok-voice-tts-1.0",
  "input": "Здравствуйте! Расскажите, как сейчас обрабатываются новые заявки?",
  "voice": "eve",
  "response_format": "mp3"
}
```

`speed` may be sent only when explicitly configured. The application must not assume that every provider honors it.

### Success response

- body: raw audio bytes, not JSON;
- expected `Content-Type`: `audio/mpeg` for P0;
- `X-Generation-Id` may be recorded for provider observability;
- local `generationId` and `segmentId` remain the source of truth for cancellation and playback.

### Error response

For non-2xx responses, parse a bounded JSON or text error body. Support at least:

| Status | Meaning for the application | Retry |
|---:|---|---|
| `400` | invalid request/profile | no |
| `401` | missing or invalid OpenRouter key | no; readiness/config error |
| `402` | insufficient credits | no; open circuit and text-only |
| `403` | request/provider policy restriction | no by default |
| `404` | unavailable or incorrect model slug | no; config error |
| `413` | request too large | no; chunker defect |
| `429` | rate limit | one bounded retry, honor `Retry-After` |
| `500`, `502`, `503`, `524`, `529` | gateway/upstream failure | at most one bounded retry |

Rules:

- no retry after user abort;
- no retry for a segment that has already been accepted for playback;
- no unbounded exponential retry loops;
- a TTS retry repeats only that pure synthesis request;
- a TTS retry must never call Luna, `create_booking`, `append_booking_qualification` or notifier again.

---

## 4. Model and voice policy

### P0 default

```text
model: x-ai/grok-voice-tts-1.0
voice: eve
format: mp3
```

OpenRouter currently lists this model as multilingual, with built-in voices `Eve`, `Ara`, `Rex`, `Sal` and `Leo`, and prices it per input character. The code must use the configured lowercase voice ID expected by the endpoint, beginning with `eve`.

### Mandatory smoke test

Before demo deployment, synthesize the same Russian sample with every candidate voice that is actually available:

```text
Здравствуйте! Я голосовой AI-продавец Botamin.
Расскажите, как ваша команда сейчас обрабатывает новые заявки?
```

The owner selects the final voice by listening. This selection changes only `.env`, not code or prompts.

### P1 model comparison

Do not block P0 by implementing multiple models. After the first working end-to-end path, an optional benchmark may compare other OpenRouter TTS models from the speech-output catalog.

For P0 fallback:

```text
OpenRouter primary profile → text-only UI
```

Do not implement automatic cross-model failover until compatible voice IDs, Russian quality, output format and latency have been measured.

---

## 5. Environment configuration

Replace all active Edge TTS variables with:

```dotenv
# TTS
TTS_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
# Optional; omit from request if empty
OPENROUTER_TTS_SPEED=

# Optional app attribution
OPENROUTER_HTTP_REFERER=https://example.com
OPENROUTER_APP_TITLE=Botamin Voice Demo

# Segmentation and queueing
TTS_FIRST_SEGMENT_TARGET_CHARS=100
TTS_SOFT_SEGMENT_CHARS=160
TTS_MAX_SEGMENT_CHARS=240
TTS_IDLE_FLUSH_MS=350
TTS_PREFETCH_SEGMENTS=1
TTS_MAX_CONCURRENCY=2

# Network and degradation
TTS_CONNECT_TIMEOUT_MS=8000
TTS_TOTAL_TIMEOUT_MS=20000
TTS_MAX_RETRIES=1
TTS_RETRY_BASE_MS=400
TTS_CIRCUIT_BREAKER_FAILURES=3
TTS_CIRCUIT_BREAKER_COOLDOWN_MS=60000
TTS_TEXT_ONLY_FALLBACK=true

# Demo budget guards
TTS_MAX_CHARS_PER_SEGMENT=240
TTS_MAX_CHARS_PER_TURN=1800
TTS_MAX_CHARS_PER_SESSION=8000
```

Delete from active `.env.example`:

```text
EDGE_TTS_*
TTS_BROWSER_FALLBACK
XAI_TTS_*
```

`XAI_API_KEY` remains required for STT only.

---

## 6. TypeScript-native `TtsPort`

The public contract remains provider-neutral:

```ts
export type TtsSynthesisRequest = {
  conversationId: string;
  turnId: string;
  generationId: string;
  segmentId: string;
  text: string;
  signal: AbortSignal;
};

export type TtsAudioSegment = {
  generationId: string;
  segmentId: string;
  providerGenerationId?: string;
  contentType: "audio/mpeg";
  bytes: Uint8Array;
  final: true;
};

export interface TtsPort {
  synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment>;
  health(): Promise<"ready" | "degraded" | "unavailable">;
}
```

### Important P0 simplification

One OpenRouter HTTP request equals one atomic phrase-level MP3 segment.

Do **not** assume arbitrary network chunks from `response.body` are independently playable MP3 files. Buffer the response for one short phrase, validate it, then emit one complete `TtsAudioSegment` to the browser.

This is intentionally simpler and more reliable for the demo than MediaSource-based incremental MP3 assembly.

### Suggested module layout

```text
apps/server/src/providers/openrouter/tts/
├── openrouter-tts-adapter.ts
├── openrouter-tts-config.ts
├── openrouter-tts-errors.ts
├── openrouter-tts-client.ts
├── openrouter-tts-adapter.test.ts
└── index.ts

scripts/
├── openrouter-tts-smoke.ts
└── openrouter-list-tts-models.ts   # optional
```

### P0 transport rule

Use Bun/native TypeScript `fetch` directly. Do not add a provider SDK only for this endpoint.

Reference behavior:

```ts
const response = await fetch(`${baseUrl}/audio/speech`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-OpenRouter-Cache": "false",
    ...(httpReferer ? { "HTTP-Referer": httpReferer } : {}),
    ...(appTitle ? { "X-OpenRouter-Title": appTitle } : {}),
  },
  body: JSON.stringify({
    model,
    input: text,
    voice,
    response_format: "mp3",
  }),
  signal,
});
```

Required checks:

1. `response.ok === true`;
2. `Content-Type` is compatible with `audio/mpeg`;
3. response is bounded by configured maximum bytes;
4. response body is non-empty;
5. bytes are emitted only if the request `generationId` is still current;
6. non-2xx body is parsed as an error and never forwarded as audio.

Do not log:

- full `input` text;
- phone, email or Telegram handle;
- Authorization header;
- raw response audio;
- system prompts or tool payloads.

Allowed telemetry:

```text
provider=openrouter
model=<slug>
voice=<id>
format=mp3
chars=<count>
status=<http status>
latency_ms=<number>
bytes=<number>
provider_generation_id=<redacted-safe id>
conversation_id_hash=<hash>
turn_id=<internal id>
segment_id=<internal id>
```

---

## 7. Phrase segmentation and browser playback

### Chunker rules

- sanitize speech before TTS;
- remove Markdown formatting, code fences, raw URLs and tool envelopes;
- do not speak hidden IDs, system messages or structured payloads;
- redact phone/email/Telegram before sending text to TTS;
- flush on complete sentence punctuation when possible;
- first segment target: roughly 60–120 characters;
- normal segment soft target: 120–180 characters;
- hard limit: 240 characters for P0;
- do not split a number, abbreviation, email or company name in the middle;
- never send empty/punctuation-only segments;
- no more than one currently playing and one prefetched segment.

### Browser protocol

Keep provider-neutral WS events. Example:

```json
{
  "type": "audio.segment",
  "generationId": "gen_01J...",
  "segmentId": "seg_01J...",
  "sequence": 0,
  "contentType": "audio/mpeg",
  "bytes": "<binary frame or referenced binary payload>",
  "final": true
}
```

The browser must:

- decode a complete MP3 phrase segment;
- play segments in `sequence` order;
- stop current playback immediately on barge-in;
- clear queued segments;
- ignore any late segment with an obsolete `generationId`;
- continue showing the text answer if audio fails.

### Barge-in

On user speech during agent playback:

```text
1. stop current AudioBufferSourceNode / HTMLAudio;
2. clear browser queue;
3. send interruption event to backend;
4. abort in-flight OpenRouter fetches for that generation;
5. interrupt the active Luna turn if it is still running;
6. mark generation obsolete;
7. drop every late result from that generation.
```

OpenRouter has no project-specific provider cancellation contract that the application should depend on. Cancellation is local through `AbortController` plus generation filtering.

---

## 8. Health, circuit breaker and budget guard

### Readiness

`/health/ready` must validate:

- `OPENROUTER_API_KEY` is present when `TTS_PROVIDER=openrouter`;
- model, voice and format are non-empty and schema-valid;
- internal queue/circuit state is available;
- app can start in configured text-only mode if explicitly allowed.

Do not call OpenRouter on every healthcheck.

### External smoke test

Run only on deploy or manually:

```bash
bun run scripts/openrouter-tts-smoke.ts
```

The script must:

1. fail when `OPENROUTER_API_KEY` is absent;
2. send a short Russian sample;
3. require `2xx` and `audio/mpeg`;
4. require non-empty bytes;
5. write a temporary MP3 outside the repository or to an ignored artifacts directory;
6. print status, latency, byte count and provider generation ID;
7. never print the API key;
8. exit non-zero on `401`, `402`, `404`, invalid content type or empty audio.

### Circuit breaker

Open after three consecutive retryable failures or immediately for persistent configuration failures such as `401`, `402`, `404`.

While open:

- do not call OpenRouter;
- return typed `TTS_UNAVAILABLE`;
- UI stays text-only;
- booking and qualification continue;
- half-open after cooldown with one probe request.

### Budget guard

Count characters before each request. Reject synthesis beyond per-segment, per-turn or per-session limits and degrade to text-only. This guard must not truncate or mutate the visible text answer.

---

## 9. Mandatory documentation migration

The documentation-update agent must patch all active files before implementation begins.

### Root files

Update:

```text
README.md
CURRENT_DECISIONS.md
AGENT_START_HERE.md
AGENT_DISPATCH_PROMPT.md
00-UNPACK-FIRST.txt
.env.example
MANIFEST.txt
CHECKSUMS.sha256
VALIDATION.md
```

Requirements:

- active version becomes `0.4-demo`;
- root onboarding points to this correction;
- no active instruction tells an agent to implement Edge TTS;
- current architecture says xAI STT → Codex/Luna → OpenRouter TTS;
- Compose description contains no TTS sidecar;
- current environment variables exactly match `.env.example`.

### Product and architecture docs

Update at least:

```text
docs/00-scope-and-assumptions.md
docs/01-product-requirements.md
docs/03-system-architecture.md
docs/05-api-events-data.md
docs/06-deployment-security-operations.md
docs/07-tradeoffs-and-adrs.md
docs/08-testing-and-acceptance.md
docs/09-agent-task-plan.md
docs/10-ai-library-evaluation.md
sources.md
```

Specific changes:

- remove Edge consumer endpoint, Python, sidecar and LGPL/AGPL discussion from active architecture;
- add OpenRouter endpoint, server-only key, MP3 phrase segments and typed failures;
- document native `fetch` as the P0 TTS transport decision;
- retain provider-neutral `TtsPort`;
- add `401/402/404/429/5xx` behavior;
- add budget guard and text-only degradation;
- add OpenRouter source links;
- state that OpenRouter TTS is paid usage and no free tier is assumed.

### Diagrams and charts

Update or regenerate:

```text
diagrams/01-system-context.*
diagrams/02-turn-sequence.*
diagrams/05-deployment.*
diagrams/07-task-dependencies.*
charts/01-latency-budget.png
charts/02-xai-variable-cost.png
```

Actions:

- replace Edge sidecar with direct Bun → OpenRouter HTTPS connection;
- remove Python container;
- rename the cost chart to represent `xAI STT + OpenRouter TTS`, or remove it if it cannot be regenerated accurately;
- delete active `diagrams/08-edge-demo-tts.*` and optionally replace it with `diagrams/08-openrouter-tts.*`.

### Generated documents

After source docs are patched:

```bash
bash scripts/build-spec.sh
python3 scripts/validate-spec.py
```

Regenerate:

```text
FULL_SPEC.md
technical-spec.html
MANIFEST.txt
CHECKSUMS.sha256
VALIDATION.md
```

Generated artifacts must not contain stale active Edge instructions.

---

## 10. Mandatory backlog migration

Do not renumber tasks or change merge gates unnecessarily. Update existing task IDs so agent dispatch remains stable.

### Global task metadata

In `tasks/tasks.yaml`:

```yaml
spec_version: 0.4-demo
```

Replace the voice-stack invariant with:

```yaml
- xAI provides streaming STT; Codex subscription with gpt-5.6-luna provides the brain; OpenRouter provides server-side TTS through a TypeScript/Bun adapter
```

### Replace T12 completely

```yaml
- id: T12
  wave: 1
  priority: P0
  owner: A2
  title: OpenRouter TTS adapter in TypeScript/Bun
  depends_on:
    - T00
  owned_paths:
    - apps/server/src/providers/openrouter/tts/**
    - scripts/openrouter-tts*
  outputs:
    - provider-neutral OpenRouterTtsAdapter behind TtsPort using native Bun fetch
    - configurable model, voice and response format
    - phrase-level complete MP3 segment synthesis
    - AbortSignal cancellation and stale-generation rejection
    - bounded retry, timeout, circuit breaker and text-only fallback
    - Russian smoke command and provider error mapping
    - character usage and latency telemetry without spoken-text logging
  acceptance:
    - x-ai/grok-voice-tts-1.0 with configured voice produces a valid Russian MP3 in the external smoke test
    - OPENROUTER_API_KEY never reaches the browser or ordinary logs
    - the first short phrase can play before the complete Luna answer is generated
    - an aborted or obsolete generation emits no later playable segment
    - 400, 401, 402, 404, 429 and retryable 5xx cases map to bounded typed failures
    - no retry path repeats Luna, create_booking, append_booking_qualification or notifier side effects
    - application remains usable in text-only mode when TTS is unavailable
    - implementation adds no Python runtime, Edge sidecar or direct xAI TTS dependency
```

### Update T10

Outputs must include:

```yaml
- provider-neutral playback queue for complete audio/mpeg phrase segments
- generation cancellation, queue clearing, stale-segment rejection and reconnect
```

Acceptance must include:

```yaml
- complete MP3 phrase segments decode and play in sequence in Chromium and WebKit
- browser never calls OpenRouter directly and contains no OpenRouter key
- old-generation audio stops and queued segments are dropped after interruption
```

Remove references to Edge/Microsoft consumer endpoints and raw PCM TTS playback unless retained as a separately tested future option.

### Update T15

Replace Edge-specific outputs with:

```yaml
outputs:
  - multi-stage Bun image with pinned Codex CLI
  - app and Caddy services only for the P0 application path
  - data and CODEX_HOME volumes
  - healthchecks, migrations and auth bootstrap
  - OpenRouter TTS environment wiring and deploy smoke command
```

Acceptance must include:

```yaml
- clean VPS deploy starts with docker compose up -d
- no Python or Edge TTS service exists in docker-compose.yml
- OPENROUTER_API_KEY is injected at runtime and absent from image history and compose output
- external OpenRouter TTS smoke test runs from the target VPS
- text-only mode can be enabled without changing the image
```

### Update T20

Outputs must mention:

```yaml
- PII-safe speech sanitizer and bounded phrase chunker for OpenRouter MP3 requests
- generation coordination, TTS budget guard and degraded-mode policy
```

Acceptance must include:

```yaml
- phone, email, Telegram handles, tool payloads and hidden IDs never enter TTS input
- every P0 TTS segment is complete and no longer than the configured hard limit
- TTS retry/failure cannot repeat the brain turn or business tools
- visible text and committed booking side effects survive TTS failure
```

### Update T22

Replace the Edge fake with:

```yaml
outputs:
  - protocol-faithful fake OpenRouter /api/v1/audio/speech endpoint
  - valid and invalid MP3 fixtures
  - JSON error fixtures for 400, 401, 402, 404, 429, 502, 503 and abort
  - timeout, Retry-After, empty-body, wrong-content-type and late-generation tests
```

Acceptance must include:

```yaml
- default test suite needs no external OpenRouter credentials
- fake endpoint proves non-2xx JSON is never forwarded as audio
- retry count and circuit transitions are deterministic
- secret scan rejects OPENROUTER_API_KEY in client bundles, snapshots and logs
```

### Update T30

Outputs must include:

```yaml
- real xAI STT, Codex/Luna and target-VPS OpenRouter TTS smoke evidence
- end-to-end text-only degradation test
```

Acceptance must include:

```yaml
- browser-to-STT-to-Luna-to-OpenRouter-to-browser path works
- booking and qualification still succeed when OpenRouter TTS is unavailable
- a target-VPS Russian MP3 smoke test passes with the release configuration
- evidence includes speech-final, first LLM delta, TTS request, TTS completion and playback timestamps
```

### Update T32

Outputs must include:

```yaml
- OpenRouter TTS latency, failure, character-usage and circuit-breaker metrics
- budget, concurrency and response-size guards
```

Acceptance must include:

```yaml
- no unbounded synthesis or playback queue exists
- spoken text and API key are absent from ordinary logs
- 401/402/404 open a safe degraded mode without affecting booking persistence
```

### T40

Add an acceptance item:

```yaml
- active docs, tasks, environment variables, diagrams and Compose contain no stale Edge TTS implementation instructions
```

---

## 11. Agent assignment migration

Update role packets under `tasks/agents/`.

### A0 — Platform/contracts

- keep `TtsPort` provider-neutral;
- freeze `audio/mpeg` phrase-segment WS contract;
- no provider SDK types in shared packages.

### A1 — Web voice

Replace any raw 24 kHz PCM TTS requirement with:

```text
complete MP3 phrase segment decoding/playback,
ordered queue,
local stop and stale-generation filtering
```

Browser must never call OpenRouter.

### A2 — Voice providers

Rename mission to:

```text
xAI Streaming STT + OpenRouter TypeScript-native TTS
```

Owned TTS paths:

```text
apps/server/src/providers/openrouter/tts/**
scripts/openrouter-tts*
```

Delete Edge/Python deliverables.

### A5 — Conversation/orchestrator

- chunk Luna output into short complete phrases;
- sanitize PII and tool envelopes before TTS;
- preserve visible text and side effects on audio failure;
- never trigger cross-model TTS fallback in P0.

### A6 — Ops

- Compose has no Edge sidecar;
- provide `OPENROUTER_API_KEY` runtime secret wiring;
- provide target-VPS smoke command;
- document `401`, `402` and credit exhaustion behavior;
- retain one-command deployment.

### A7 — QA/integration

- fake OpenRouter HTTP TTS server;
- audio/mpeg fixtures;
- error, timeout, abort, Retry-After and stale-generation tests;
- real external smoke test tagged and excluded from default CI.

---

## 12. Removal checklist

Delete from implementation and active docs:

```text
services/edge-tts/**
apps/server/src/providers/edge-community/**
apps/server/src/providers/edge/**
Python TTS Dockerfile/requirements/app
edge-tts package references
msedge-tts package references
Edge internal HTTP contract
Edge-only license notices
EDGE_TTS_* environment variables
ru-RU-SvetlanaNeural release defaults
ru-RU-DariyaNeural release defaults
xAI TTS adapter and XAI_TTS_* variables
```

Run:

```bash
rg -n -i \
  'edge[-_ ]tts|edge-community|msedge-tts|services/edge-tts|SvetlanaNeural|DariyaNeural|Microsoft consumer endpoint' \
  . \
  --glob '!corrections/superseded/**'
```

Expected result: no active implementation or normative-document matches.

Also run:

```bash
rg -n \
  'XAI_TTS_|xAI Streaming TTS|api\.x\.ai/.*/tts' \
  . \
  --glob '!corrections/superseded/**'
```

Expected result: no active direct-xAI-TTS implementation requirement. Historical comparison text is allowed only when explicitly marked as rejected/superseded.

---

## 13. Verification matrix

### Static

```bash
bun install
bun run typecheck
bun test
bash scripts/build-spec.sh
python3 scripts/validate-spec.py
docker compose config
```

### Fake-provider tests

- successful `audio/mpeg` response;
- chunked network response buffered into one complete segment;
- wrong content type;
- zero-byte response;
- JSON error body;
- `401` invalid key;
- `402` insufficient credits;
- `404` model unavailable;
- `429` with and without `Retry-After`;
- `502/503` one retry;
- timeout;
- user abort;
- stale `generationId`;
- circuit open/half-open/closed;
- per-turn and per-session budget limits.

### Browser tests

- ordered playback of at least three MP3 phrase segments;
- immediate stop and queue clear on barge-in;
- late segment ignored;
- text remains visible on TTS failure;
- no provider error body is treated as audio;
- Chromium and WebKit smoke.

### Real smoke

```bash
OPENROUTER_API_KEY=... \
OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0 \
OPENROUTER_TTS_VOICE=eve \
bun run scripts/openrouter-tts-smoke.ts
```

Expected:

```text
status=200
content_type=audio/mpeg
bytes>0
latency_ms=<measured>
provider_generation_id=<id if present>
artifact=<ignored temporary mp3 path>
```

### End-to-end acceptance

1. User speaks in Russian.
2. xAI STT returns final transcript.
3. Luna begins streaming a response.
4. First complete phrase is synthesized through OpenRouter.
5. Browser plays it before the full Luna answer is finished.
6. User interrupts; current and queued audio stop.
7. Booking is created exactly once.
8. Post-booking qualification updates the same booking.
9. TTS outage leaves text and booking flow operational.

---

## 14. Release blockers introduced by this correction

Release is blocked when any condition holds:

- browser bundle contains `OPENROUTER_API_KEY`;
- browser calls `openrouter.ai` directly;
- Compose still includes an Edge/Python TTS sidecar;
- active docs or tasks instruct agents to implement Edge TTS;
- TTS error retries Luna or business tools;
- non-2xx JSON is forwarded as audio;
- late generation audio plays after interruption;
- phone/email/Telegram or tool payload enters TTS input;
- `401`, `402` or `404` causes an infinite retry loop;
- booking fails because TTS is unavailable;
- `.env.example`, README, tasks and deployment docs disagree;
- external Russian smoke test has not been recorded for the release profile.

---

## 15. Definition of Done for the correction itself

The correction is considered applied only when:

- [ ] active spec version is `0.4-demo`;
- [ ] this file is linked first from `README.md` and `AGENT_START_HERE.md`;
- [ ] previous TTS corrections are marked superseded and excluded from generated spec;
- [ ] active architecture is `xAI STT → Codex/Luna → OpenRouter TTS`;
- [ ] `tasks/tasks.yaml` contains the updated T12 and related task edits;
- [ ] A1, A2, A5, A6 and A7 assignment packets are updated;
- [ ] `.env.example` contains `OPENROUTER_*` and no `EDGE_TTS_*`;
- [ ] Compose contains no TTS sidecar;
- [ ] diagrams and cost/latency material no longer describe Edge or direct xAI TTS;
- [ ] `FULL_SPEC.md` and `technical-spec.html` are rebuilt;
- [ ] manifest/checksums are regenerated;
- [ ] spec validator passes;
- [ ] grep checks show no stale active Edge instructions;
- [ ] implementation uses native Bun `fetch` behind `TtsPort`;
- [ ] fake-provider tests pass;
- [ ] real Russian OpenRouter smoke test passes or the unresolved external blocker is explicitly reported without pretending completion.

---

## 16. Required completion report from the agent

The agent must return:

```text
1. Commit SHA for docs/tasks migration.
2. Commit SHA for implementation, if implemented in the same assignment.
3. List of deleted Edge/Python files.
4. List of modified documentation and task files.
5. Final .env variable matrix.
6. Exact OpenRouter model / voice / format used.
7. Static, unit, fake-provider and browser test results.
8. Real target-VPS smoke result with status, latency and byte count.
9. Grep output proving no active Edge references remain.
10. Known limitations and whether text-only fallback was exercised.
```

Do not report the task complete if only code was changed while active docs and backlog still describe Edge TTS.

---

## 17. Primary sources

The agent should verify implementation details against current official OpenRouter documentation immediately before coding:

- TTS guide: `https://openrouter.ai/docs/guides/overview/multimodal/tts`
- Create speech API reference: `https://openrouter.ai/docs/api/api-reference/tts/create-speech`
- TTS model discovery: `https://openrouter.ai/api/v1/models?output_modalities=speech`
- Filtered models page: `https://openrouter.ai/models?input_modalities=text&output_modalities=speech`
- Grok Voice TTS model page: `https://openrouter.ai/x-ai/grok-voice-tts-1.0`
- Authentication: `https://openrouter.ai/docs/api_reference/authentication`
- Errors and debugging: `https://openrouter.ai/docs/api_reference/errors-and-debugging`
- App attribution: `https://openrouter.ai/docs/app-attribution`

Model availability, pricing, voices and provider behavior are runtime configuration facts, not permanent assumptions. Record the values used by the release in the deployment evidence.
