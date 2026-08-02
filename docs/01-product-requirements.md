# 01. Product Requirements Document

## 1. Продуктовая формулировка

Botamin Voice Sales Agent — это лендинг с живой голосовой демонстрацией продукта: AI-продавец сам показывает, как Botamin может отвечать, квалифицировать, обрабатывать возражения и передавать менеджеру структурированный результат.

### North Star для MVP

**Доля начатых голосовых разговоров, в которых backend получил валидный `booking.created`.**

Не следует оптимизировать MVP под длительность разговора или количество реплик: главная ценность — качественно зафиксированный следующий шаг.

## 2. Целевая аудитория

Основные роли:

- собственник / CEO;
- Head of Sales / коммерческий директор;
- CMO / руководитель лидогенерации;
- руководитель первой линии;
- операционный руководитель, отвечающий за SLA обработки лидов.

Типовые контексты:

- лиды теряются ночью или в выходные;
- менеджеры долго отвечают;
- большой объём нецелевых обращений;
- требуется реактивация или обработка холодной базы;
- квалификация и CRM-рутина перегружают команду;
- нужно быстро протестировать AI-сценарий продаж.

## 3. User stories P0

| ID | История | Приёмка |
|---|---|---|
| US-000 | Как посетитель, я сразу слышу короткое представление продукта | при entry выполняется одна попытка committed same-origin MP3 без REST/WS/mic/provider/session; blocked/error даёт `Включить приветствие` |
| US-001 | Как посетитель, я запускаю разговор одной кнопкой | proactive greeting останавливается; только после двух consents запрашивается mic permission и создаётся session, UI показывает состояние |
| US-002 | Я говорю естественно по-русски | UI показывает sample-derived circular countdown во время capture, listening/processing, затем ровно один `transcript.final` |
| US-003 | Я печатаю финальную реплику | stage-gated composer отправляет provider-neutral `visitor.text.submit`; server-accepted typed turn проходит тот же semantic pipeline, что и speech |
| US-004 | Агент отвечает голосом и текстом | первая полная MP3-фраза может проиграться до завершения ответа Luna; ответ не содержит markdown-мусора |
| US-005 | Агент понимает, зачем я пришёл | задаёт не более одного вопроса за раз и максимум два discovery-вопроса до мягкого предложения следующего шага |
| US-006 | Агент объясняет Botamin на релевантном примере | использует только утверждённые knowledge claims; 10–15 млн ₽/месяц — только атрибутированное сообщение пользовательского брифа, не гарантия |
| US-007 | Я могу возразить или перебить | проигрывание останавливается, новый turn обрабатывается |
| US-008 | Я соглашаюсь на встречу | server предлагает ровно два concretely dated current Moscow slots, не выдавая их за глобальную доступность; spoken/text/form заполняют один durable revisioned draft, а exact-revision confirmation автоматически commit-ит выбранный вариант |
| US-009 | После встречи я могу ответить на два доп. вопроса | после durable commit и truthful confirmation server без отдельного permission turn спрашивает только первый missing fact: monthly lead/contact volume, затем integer `salesManagerCount`; known facts не повторяются, оба ответа одной репликой допустимы |
| US-010 | Я могу отказаться от квалификации | без ответов статус `skipped`, после одного ответа `partial`; scheduled internal virtual meeting в обоих случаях остаётся `booked`, диалог корректно завершается |
| US-011 | Получатель видит данные | console/webhook получает структурированный payload со слотом |
| US-012 | Сервис перезапускается | сохранённые booking/event данные остаются в volume |
| US-013 | Проект сначала разворачивается локально | `scripts/deploy-local.sh` поднимает готовые app + Caddy на `http://localhost:5173`; target VPS/TLS проверяется отдельным later gate |

## 4. Functional requirements

### 4.1 Voice session

- **FR-VOICE-001:** создание сессии должно выдавать уникальный `conversationId`.
- **FR-VOICE-002:** браузер передаёт mono PCM16, 16 kHz, чанками около 100 ms; максимум реплики — 60,000 ms, максимум atomic WAV — 2,000,000 bytes. Server-advertised client PCM cap учитывает WAV overhead и stricter ceiling (при defaults 1,920,000 PCM bytes).
- **FR-VOICE-003:** backend держит единственный `OPENROUTER_API_KEY` server-side для STT и TTS.
- **FR-VOICE-004:** `audio.commit` закрывает utterance; gateway/utterance assembler создаёт ровно один validated mono PCM16 WAV и передаёт его atomic `SttPort`. Adapter валидирует/bounds already-WAV bytes, base64-кодирует их без conversion и выполняет один audio-input chat completion. UI получает только один `transcript.final`, а Luna запускается только для валидного неустаревшего результата.
- **FR-VOICE-005:** при barge-in клиент немедленно останавливает playback и очищает очередь, backend abort-ит OpenRouter fetches текущего `generationId` и по возможности вызывает `turn/interrupt`.
- **FR-VOICE-006:** reconnect не должен создавать вторую бронь.
- **FR-VOICE-007:** stop завершает внешние соединения и фиксирует событие.
- **FR-VOICE-008:** OpenRouter вызывается только backend-ом; browser получает provider-neutral полные `audio/mpeg` phrase segments в sequence order.
- **FR-VOICE-009:** TTS failure сохраняет видимый текст и все уже committed business side effects; synthesis retry не повторяет brain turn или tools.
- **FR-VOICE-010:** перед TTS удаляются PII, tool envelopes, hidden IDs, Markdown, code fences и raw URLs; hard limit сегмента — configurable, default 240 chars.
- **FR-VOICE-011:** STT duration/byte/time/retry guards и TTS per-segment/turn/session/concurrency/response guards ограничивают voice path; retry не запускает Luna/tools повторно.
- **FR-VOICE-012:** chunked PCM16 описывает только browser-to-gateway transport; provider boundary получает один atomic `audio/wav` request и возвращает один final result.
- **FR-VOICE-013:** circular countdown отображается только при active capture и вычисляется по числу принятых PCM16 samples (`acceptedPcmBytes / 2 / 16000`), ограниченному меньшим из server `maxUtteranceMs` и byte-derived duration; wall-clock drift не является источником значения.
- **FR-TEXT-001:** `visitor.text.submit` содержит один trimmed final typed turn до 2,000 символов, monotonic sequence и не содержит provider/tool fields.
- **FR-TEXT-002:** typed turn очищает uncommitted microphone bytes, допускает не более одного pending submit и считается принятым только после server `transcript.final`; rejected retry сохраняет sequence.
- **FR-TEXT-003:** после final acceptance typed и spoken turns семантически равнозначны: один и тот же Luna context, server state policy, tools, persistence, assistant text и optional TTS.

### 4.2 Brain and orchestration

- **FR-BRAIN-001:** модель по умолчанию `gpt-5.6-luna`; фактическая модель задаётся `CODEX_MODEL`, но её смена требует повторного conversation eval gate.
- **FR-BRAIN-002:** один Codex thread соответствует одной conversation.
- **FR-BRAIN-003:** backend, а не LLM, является источником истины для текущего stage.
- **FR-BRAIN-004:** LLM не получает shell/network privileges, кроме явно зарегистрированных доменных tools.
- **FR-BRAIN-005:** ответы проходят speech sanitizer перед TTS.
- **FR-BRAIN-006:** system/product/conversation prompts загружаются из Markdown.
- **FR-BRAIN-007:** tool mode имеет feature flag: `dynamic` и стабильный fallback `envelope`.
- **FR-BRAIN-008:** reasoning effort задаётся конфигурацией; стартовый профиль Luna использует минимальный уровень, который проходит quality evals.
- **FR-BRAIN-009:** каждый turn получает server-owned `currentInstant`, текущую московскую дату и день недели, parsed time-of-day/concrete-date-time request и ровно два structured meeting candidates с concrete Moscow date/time labels.
- **FR-BRAIN-010:** cadence умеренно проактивен: один вопрос за раз, не более двух discovery-вопросов до мягкого demo/meeting offer, без повторного давления после ясного отказа.

### 4.3 Booking

- **FR-BOOK-001:** обязательны `conversationId`, имя, компания, рабочий email, телефон или Telegram, `consentConfirmed=true` и structured `meetingSlot`.
- **FR-BOOK-002:** server всегда выдаёт ровно два уникальных внутренних кандидата длительностью 20 минут в `Europe/Moscow`, каждый с конкретной датой и временем: будни, дата строго позже server-owned московского today, старты по 20-минутной сетке от 09:00 до 17:00 включительно. Без preference это одна утренняя и одна вечерняя альтернатива.
- **FR-BOOK-003:** bounded Russian parser одинаково обрабатывает typed/spoken явные предпочтения `morning`, `daytime`, `second_half`, `evening`, одно явное rejection и поддерживаемые конкретные московские дату+время. Time band даёт два in-band варианта; concrete request даёт exact permitted start и одну alternative либо два ближайших internal starts. Missing/ambiguous date or time asks for clarification; same-day/past/out-of-hours requests fail closed.
- **FR-BOOK-004:** два candidates — только текущие внутренние альтернативы, не exhaustive/global availability claim. Они исключают committed internal starts без external availability API.
- **FR-BOOK-005:** `create_booking` разрешён только в `COLLECT_BOOKING`; выбранный `meetingSlot` обязан byte-for-field совпасть с одним из двух candidates активного turn. Non-candidate, stale, occupied или уже не bookable slot отклоняется.
- **FR-BOOK-006:** одна durable draft projection хранится в `conversation_contexts` как revisioned JSON facts/provenance/conflicts/lifecycle. Mutations используют expected revision, compare-and-swap, bounded conflicts и idempotent request IDs; stale revisions fail closed.
- **FR-BOOK-007:** exact-revision draft confirmation переводит draft через `committing` и автоматически вызывает идемпотентный booking create; стабильный `bookingId` записывается и в durable draft, и в единственный booking.
- **FR-BOOK-008:** committed `booking.created`, committed draft и server-derived internal meeting projection предшествуют final widget и первому qualification question.
- **FR-BOOK-009:** backend сохраняет booking/outbox и публикует `kind=internal_virtual`, `status=scheduled`, `externalCalendarEventCreated=false`, `externalInviteSent=false`; отдельной meeting table, external availability API, calendar event/invitation или CRM record нет.
- **FR-BOOK-010:** in-chat form показывается только по server-owned `COLLECT_BOOKING`, редактирует browser-safe projection без provenance/evidence и отправляет structured field patch/current candidate identity. Spoken, typed, and form inputs merge into one authoritative draft; conflicts require explicit resolution and changed candidates require reselection.

### 4.4 Post-booking qualification

- **FR-QUAL-001:** запускается только после committed booking, committed draft, durable internal meeting publication и truthful user-facing confirmation; отдельного qualification-permission turn нет.
- **FR-QUAL-002:** server спрашивает только missing authoritative fact: при двух missing сначала контекстный месячный объём лидов/обрабатываемых контактов (`monthlyLeadVolume`), затем integer `salesManagerCount`; при одном known спрашивается только второе, при обоих known — ничего.
- **FR-QUAL-003:** server не повторяет known facts. Generic daily volume требует clarification `рабочие или календарные дни`; только затем server может нормализовать. Model не вычисляет 22/30 и не может изменить persisted truth.
- **FR-QUAL-004:** оба поля необязательны для meeting и могут сохраняться partial patch-операцией; `complete` только при обоих. Если пользователь сообщает оба missing значения одновременно, оба сохраняются и flow завершается.
- **FR-QUAL-005:** explicit refusal без ответов даёт `skipped`; refusal после одного ответа сохраняет `partial`; disconnect/failure не отменяет scheduled internal meeting.
- **FR-QUAL-006:** повторный patch идемпотентен.

### 4.5 Landing and UX

- **FR-WEB-000:** при entry выполняется ровно одна automatic playback attempt committed product-owned same-origin MP3. До двух consents запрещены conversation REST, WS, mic, provider и session effects; blocked/error показывает native button `Включить приветствие`, а session start немедленно останавливает и освобождает audio.
- **FR-WEB-001:** above-the-fold объясняет продукт и содержит один primary CTA.
- **FR-WEB-002:** до запуска голоса показывается понятное объяснение микрофона и обработки данных.
- **FR-WEB-003:** UI имеет состояния `idle`, `connecting`, `listening`, `thinking`, `speaking`, `booked`, `complete`, `error`.
- **FR-WEB-004:** текстовая копия реплик и stage-gated multiline composer доступны в активных visitor-turn stages; Enter отправляет, Shift+Enter добавляет строку.
- **FR-WEB-005:** booking form существует внутри chat и видима только в server-owned `COLLECT_BOOKING`. Она показывает auto-filled durable facts, five contact/identity fields, conflicts, exactly two concretely dated candidates, exact-revision confirmation, and safe rejection/retry state.
- **FR-WEB-005A:** final meeting widget appears only from `session.ready.internalMeeting` or `internal.meeting.updated` derived from the durable booking; legacy UI state or transcript wording cannot synthesize it.
- **FR-WEB-006:** mobile viewport поддерживается.
- **FR-WEB-007:** при voice failure пользователю не показываются stack traces/provider details.
- **FR-WEB-008:** proactive MP3 содержит только фиксированный product copy без visitor data. Его замена выполняется отдельным explicit admin opt-in OpenRouter generation script и commit-ится как static asset; runtime visit не генерирует greeting.

## 5. P1 и P2

### P1

- generic signed webhook notifier с retry;
- dev-only inspector с событиями и latency;
- prompt checksum в каждом conversation;
- TTS cache для статических приветствий;
- automated conversation eval suite;
- basic abuse/rate limiting;
- export одного лида в JSON.

### P2

- Telegram notifier;
- A/B prompts;
- admin dashboard;
- real CRM/calendar adapters;
- selectable voices;
- multilingual flows;
- analytics warehouse.

## 6. Non-functional requirements

| ID | Требование | Цель MVP |
|---|---|---|
| NFR-LAT-001 | `audio.commit` → final transcript и final transcript → playback первой полной MP3-фразы | измерять и публиковать отдельно; re-baseline после target-VPS smoke, без provider guarantee |
| NFR-REL-001 | успешность `create_booking` при валидных данных | ≥ 99.5% внутри приложения |
| NFR-IDEM-001 | дубли брони при retry/reconnect | 0 в тестовой матрице |
| NFR-SEC-001 | TLS | обязательно в production |
| NFR-SEC-002 | raw credentials в клиентском bundle/logs | 0 |
| NFR-PRIV-001 | raw audio storage | off by default |
| NFR-OBS-001 | traceability | `conversationId`, `turnId`, `bookingId` во всех событиях |
| NFR-OPS-001 | deployment | один local-first Compose project; target VPS/TLS evidence later |
| NFR-OPS-002 | backup | ежедневная копия SQLite + restore check |
| NFR-COMP-001 | browser | актуальные Chrome, Edge, Safari; Firefox best effort |
| NFR-A11Y-001 | keyboard/control labels | WCAG-oriented базовый уровень |

![Целевой latency budget](../charts/01-latency-budget.png)

Значения на графике — инженерный бюджет и release target, а не обещание провайдера. Реальные p50/p95 должны собираться в E2E.

## 7. Бизнес-события воронки

Минимальный набор:

1. `landing.viewed`
2. `voice.cta_clicked`
3. `voice.permission_granted` / `voice.permission_denied`
4. `conversation.started`
5. `conversation.discovery_completed`
6. `booking.offered`
7. `booking.created`
8. `qualification.started`
9. `qualification.updated`
10. `conversation.completed`
11. `conversation.failed`

## 8. Success metrics после запуска

- start rate: `conversation.started / landing.viewed`;
- speech activation: доля с хотя бы одной финальной репликой;
- booking conversion: `booking.created / conversation.started`;
- post-booking qualification opt-in;
- qualification completeness;
- drop-off stage distribution;
- p50/p95 time-to-first-audio;
- provider error rate, OpenRouter circuit state и доля text-only degradation;
- OpenRouter TTS character usage без spoken-text logging;
- duplicate booking rate;
- доля диалогов с manual review flag.

Метрики качества продаж нельзя интерпретировать без объёма трафика и human review выборки.

## 9. Release sequencing boundary

`0.5.0-local-rc.4` is the recommended, still-untagged local candidate for one trusted owner machine. RC3 evidence is preserved as history, not reused as RC4 proof. Chromium desktop/mobile landing smoke is not a full voice journey. WebKit has a downloaded browser binary but the current host is missing `libicu74`, `libxml2`, and `libflite1`; WebKit full journey therefore remains not run. Target-VPS resources, DNS, public TLS/WSS, and target-host provider live booking are also external gates. The internal virtual meeting remains deliberately different from an external calendar event.
