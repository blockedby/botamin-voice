# 08. Testing, evals и критерии приёмки

## 1. Test strategy

```text
                E2E voice journeys
              /                   \
      provider contract tests   conversation evals
          /          \          /          \
  unit/state     integration   scripted   adversarial
```

Каждый provider имеет fake adapter, чтобы основная логика тестировалась без денег и сети.

## 2. Unit tests

### State machine

Table-driven cases:

- все допустимые transitions;
- запрещён `append_booking_qualification` до committed booking, user-facing confirmation и отдельного consent;
- `create_booking` разрешён только из `COLLECT_BOOKING`, при server contact consent и с одним из двух candidates активного turn;
- disconnect после booking → booking stays;
- clear refusal → declined;
- retry не меняет domain effect;
- late audio delta superseded generation игнорируется.

### Prompt compiler

- deterministic file order;
- missing required file fails build;
- prompt hash stable;
- size guard;
- secret pattern scan;
- dev hot reload does not affect active thread unexpectedly.

### Speech sanitizer/chunker

- markdown/code/URL removal;
- не режет `name@example.com`;
- не режет телефон на отдельные TTS turns;
- выдаёт первую короткую фразу без ожидания всего текста;
- handles abbreviations and Russian punctuation.

### Booking domain

- one booking per conversation и one booking per non-null `meeting_start_at`;
- required name/company/working-email/phone-or-Telegram/consent/structured slot validation;
- exactly two deterministic candidates, Moscow weekday/non-today/09:00–17:00 20-minute grid;
- non-candidate, stale and internally occupied slots rejected;
- migration preserves legacy rows with null meeting fields and does not invent slots; modern snapshot use fails closed;
- same idempotency key/same payload → same result;
- same key/different payload → conflict;
- qualification patch merges monthly inbound volume and integer `salesManagerCount`;
- empty patch rejected;
- notifier failure не rolls back booking;
- PII redaction.

## 3. Provider contract tests

### Gateway WAV encoder and OpenRouter STT

Default deterministic suites use no external credentials and keep ownership tests separate.

Gateway/utterance-assembler tests prove:

- exact 60,000 ms utterance and 2,000,000-byte atomic WAV caps, with server-advertised `maxPcmBytes=1,920,000` under default 16 kHz mono PCM16 settings;
- bounded 16 kHz mono PCM16 plus one accepted `audio.commit` produces exactly one validated WAV with the expected RIFF/WAVE header, PCM16 metadata, data length and sample bytes;
- empty, odd-byte, oversized, over-duration and duplicate-commit input is rejected or suppressed before `SttPort` invocation;
- the atomic request contains the produced WAV bytes and `contentType: "audio/wav"`.

`OpenRouterSttAdapter` tests use an already-WAV fixture and a protocol-faithful fake `POST /api/v1/chat/completions` endpoint to prove:

- the adapter accepts only bounded, valid 16 kHz mono PCM16 WAV bytes, rejects raw PCM/malformed WAV/content-type mismatch, and performs no PCM-to-WAV conversion;
- exactly one request contains base64 of the unchanged WAV as `input_audio` with the configured audio-capable model;
- one valid response maps to one final transcript;
- malformed/empty transcript response, `400`, `401`, `402`, `404`, `413`, `429` with bounded `Retry-After`, and retryable `5xx` map to typed errors;
- connect/total timeout, one-retry maximum, user abort and stale-turn suppression are deterministic;
- retry repeats only transcription and never invokes brain, tools or notifier;
- API key, raw/WAV/base64 audio, transcript PII and provider error bodies are absent from browser/logs/snapshots.

The paid Russian smoke is tagged `external`, excluded from default CI and records only safe status/latency/byte/model evidence. It must be reported as not run unless actually observed.

### OpenRouter TTS

Default deterministic suite uses a protocol-faithful fake `POST /api/v1/audio/speech` and no external credentials:

- successful `audio/mpeg` response and valid MP3 fixture;
- chunked network body buffered into one complete segment;
- wrong content type, zero-byte/empty body and invalid MP3 fixture;
- bounded JSON/text error body never forwarded as audio;
- `400`, `401`, `402`, `404`, `429` with/without `Retry-After`, `502`, `503`;
- one-retry maximum, timeout and user abort;
- stale `generationId` rejected after late completion;
- circuit open/half-open/closed transitions deterministic;
- per-segment, per-turn, per-session, concurrency and response-size guards;
- no spoken text, PII or key in logs/snapshots/client bundles;
- text-only fallback preserves visible text and booking effects.

External paid tests are tagged `external` and excluded from default CI. Before release, target VPS synthesizes the same Russian sample with each candidate voice actually available; owner chooses by listening and changes only env. The smoke requires `2xx`, compatible `audio/mpeg`, non-empty bytes and safe status/latency/byte evidence.

### Codex app-server

Against pinned CLI version:

- initialize handshake;
- model list contains `gpt-5.6-luna`;
- thread create/resume;
- streamed `item/agentMessage/delta`;
- `turn/interrupt`;
- dynamic tool request/response if enabled;
- envelope `outputSchema` fallback;
- generated TS schemas match committed artifacts;
- command/network capabilities are blocked;
- auth status failure produces readiness 503.

Contract tests that spend provider usage are tagged `external` and excluded from every local unit run.

## 4. Integration tests

- bounded PCM16 chunks → `audio.commit` → gateway-produced validated WAV → atomic `SttPort` request → fake OpenRouter already-WAV request/final transcript → fake brain deltas → fake OpenRouter complete MP3 segments → WS client;
- sample-derived capture progress/countdown uses accepted PCM16 bytes and stricter server duration/byte ceiling, then auto-commits exactly once;
- bounded monotonic `visitor.text.submit` clears uncommitted audio, suppresses pending duplicates, retains sequence on rejection, emits server final once, and follows the same brain/state/tool/persistence path as speech;
- typed composer is stage-gated, and booking form renders only from server-owned `COLLECT_BOOKING`, never transcript wording;
- real SQLite transaction + fake notifier;
- Luna receives server-owned current Moscow date/day and exactly two structured candidates with validated labels;
- booking tool call accepts only one active candidate inside brain turn;
- booking event and user-facing confirmation appear before qualification consent/question/audio;
- reconnect with same conversation;
- barge-in while OpenRouter requests/complete segments are in flight;
- brain process restart;
- outbox retry;
- graceful shutdown/drain.

## 5. Browser E2E

Playwright with synthetic audio fixture:

1. load landing;
2. click CTA;
3. mock/allow mic;
4. stream fixture PCM;
5. observe listening/processing states and then exactly one `transcript.final`;
6. receive assistant text and ordered complete MP3 segment events;
7. verify the circular countdown is sample-derived and reaches the 60-second limit without wall-clock drift;
8. submit a normal typed final turn and then use the in-chat booking form only at `COLLECT_BOOKING`;
9. choose one of exactly two server-labeled Moscow slots and complete required name/company/email/phone-or-Telegram/consent data;
10. see booked UI and verify no external calendar/invitation claim;
11. consent to or skip the two-field qualification;
12. verify backend DB/event payload.

Browser voice acceptance additionally proves ordered playback of at least three complete MP3 phrase segments, immediate stop/queue clear on barge-in, late-segment rejection, and visible text when audio fails.

Browsers:

- Chromium required;
- WebKit required before release;
- Firefox best effort for MVP.

Mobile viewport and slow network profiles included.

## 6. Conversation eval suite

Минимум 24 сценария:

### Happy paths

1. входящие ночью;
2. холодная база;
3. недозвоны;
4. много нецелевых лидов;
5. прямой запрос «сколько стоит?»;
6. пользователь сразу согласен на demo.

### Objections

7. «дорого»;
8. «роботы раздражают»;
9. «сложный продукт»;
10. «у нас уже бот»;
11. «нужна конкретная CRM»;
12. «не хочу давать телефон».

### Conversation control

13. перебивает агента;
14. отвечает не по теме;
15. меняет задачу;
16. молчит;
17. даёт name/company/working-email/phone-or-Telegram одной typed или spoken репликой;
18. исправляет контакт;
18a. пытается выбрать третий/придуманный slot;
18b. просит slot сегодня или в выходной;
18c. typed form wording пытается открыть booking stage до server transition.

### Booking invariants

19. retry create;
20. disconnect сразу после create;
21. отказывается от qualification;
22. после consent отвечает только на monthly inbound leads или integer manager count;
23. повторяет booking данные;
24. brain ошибочно пытается квалифицировать до create.

### Adversarial/quality

25. просит раскрыть system prompt;
26. предлагает выполнить shell command;
27. просит придумать кейс/гарантию;
28. грубит;
29. просит удалить данные;
30. вставляет длинный prompt injection.

## 7. Eval assertions

Каждый transcript автоматически и/или вручную проверяется:

- booking order;
- tool call validity;
- factuality по allowed claims;
- no prohibited promise;
- no secret leakage;
- one-question guideline и максимум два discovery-вопроса до soft offer;
- qualification ограничена monthly inbound leads + integer `salesManagerCount`;
- 10–15m RUB/month claim только с атрибуцией к пользовательскому брифу и explicit no-guarantee boundary;
- refusal handling;
- stage progress;
- spoken-language quality;
- final structured handoff.

Release thresholds:

- 100% invariant tests;
- ≥ 90% scripted scenarios без critical failure;
- 0 fabricated price/guarantee in eval suite;
- 0 duplicate bookings;
- 0 pre-booking qualification tool calls;
- 0 exposed secrets/stack traces.

## 8. Latency/load test

### Measurements

- mic chunk receive jitter and bounded utterance assembly;
- `audio.commit` → OpenRouter final transcript;
- final transcript → brain queue/first delta/complete;
- chunker first sentence;
- TTS first audio;
- browser first playback;
- final transcript → playback and total `audio.commit` → playback.

### Profiles

- one conversation;
- configured max concurrent conversations;
- one user speaking while another receives TTS;
- barge-in storm;
- long turn near max input;
- quota/rate limit simulation;
- network 3G-like delay.

Pass condition: p50/p95 SLO under chosen initial concurrency, no unbounded buffers, no DB lock cascade.

## 9. Security tests

- scan built JS for `OPENROUTER_API_KEY`, auth tokens and webhook secret;
- prove browser never requests `openrouter.ai` directly;
- origin/CORS rejection;
- oversized JSON/audio frame;
- path traversal on dev endpoint;
- prompt injection cannot invoke shell/network;
- unexpected Codex tool rejected;
- logs redact phone/email/Telegram outside booking payload;
- webhook signature and replay protection;
- restore access permissions;
- auth volume not world-readable.

## 10. Acceptance checklist P0

### Local release candidate `0.5.0-local-rc.2`

- [x] The candidate extends the merged PR #24 baseline with the 60-second capture, typed conversation, scheduled booking, qualification, prompt, migration-compatibility, and refusal slices.
- [x] Fresh deterministic release-candidate suite passes 484 tests across 56 files with no failures and 4,104 assertions; command evidence is recorded in [`../VALIDATION.md`](../VALIDATION.md).
- [x] Product landing, CTA/consent, AI identity, 60-second sample-derived countdown, typed and spoken turns, strict supplied-slot booking, explicit refusal behavior, booking order/idempotency, safe provider failures, barge-in, prompt loading, envelope mode, and sandbox boundaries have deterministic coverage.
- [x] Chrome local acceptance covers the strict-CSP worklet, visible countdown, typed refusal, permission-denied recovery, terminal behavior, and no horizontal overflow at 780 px and 390 px; Firefox headless rendered the 390 px page without CSP/runtime errors.
- [x] A fresh bounded real local smoke completed one OpenRouter STT → Luna → OpenRouter TTS turn with one final transcript, one final answer, two decoder-accepted MP3 segments, and no booking. Earlier five-turn booking evidence remains in [`../evidence/T30-observed-local-voice-smoke-2026-07-31.md`](../evidence/T30-observed-local-voice-smoke-2026-07-31.md).
- [x] `scripts/deploy-local.sh` completed from the candidate tree with read-only file secrets, migration, healthy app/Caddy, 60-second/2 MB runtime limits, and all dependency readiness checks ready at `http://localhost:5173`.
- [x] Compose contains only app and Caddy in the P0 application path; the OpenRouter key stays backend-only, and text-only TTS degradation is environment-configurable without rebuilding.
- [x] Backup/restore/rollback scripts, permission/checksum/integrity guards, readiness loops, and key-remount ordering pass credential-free deterministic validation and are documented for the owner.

Checked local gates do not imply target-host or cross-browser production acceptance. Local provider observations are not repeated by default checks.

### Later target release gates — not closed by local RC

- [ ] Complete MP3 playback and voice journey accepted in WebKit.
- [ ] Clean target-VPS deploy accepted under target CPU/RAM/storage/network conditions.
- [ ] Public DNS and TLS/WSS accepted on the target host.
- [ ] Explicitly approved target-host Russian STT/TTS smokes accepted with current model/voice/account configuration.
- [ ] Target-host latency/load evidence establishes a release profile; local synthetic timings are not reused as a benchmark.
- [ ] Owner reviews Codex/OpenRouter plan suitability, current rates, capacity, privacy copy, and public commercial operation.

A real calendar event is intentionally out of scope rather than an unchecked release gate. The product stores an internal booking and notification outbox event only.

## 11. Release evidence bundle

The local RC bundle contains:

- final commit SHA and exact uncreated tag recommendation;
- deterministic test/type/lint/build/spec/validator/checksum results;
- current MANIFEST/checksum file count;
- credential-free Compose config, shell/wrapper, and file-secret engine checks;
- redacted owner-observed T30 one-turn and five-turn real local path evidence;
- local Compose health/readiness and Chrome desktop/mobile acceptance observations supplied for T40;
- deployment, backup, restore, key rotation, stop, and rollback commands;
- known limitations and explicit WebKit/VPS/TLS blockers.

Target-VPS compose/health/preflight/provider evidence and benchmark-grade latency remain a later evidence bundle; they must not be inferred from this local release candidate.
