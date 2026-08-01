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
| US-001 | Как посетитель, я запускаю разговор одной кнопкой | после двух consents запрашивается mic permission, UI показывает состояние |
| US-002 | Я говорю естественно по-русски | UI показывает sample-derived circular countdown во время capture, listening/processing, затем ровно один `transcript.final` |
| US-003 | Я печатаю финальную реплику | stage-gated composer отправляет provider-neutral `visitor.text.submit`; server-accepted typed turn проходит тот же semantic pipeline, что и speech |
| US-004 | Агент отвечает голосом и текстом | первая полная MP3-фраза может проиграться до завершения ответа Luna; ответ не содержит markdown-мусора |
| US-005 | Агент понимает, зачем я пришёл | задаёт не более одного вопроса за раз и максимум два discovery-вопроса до мягкого предложения следующего шага |
| US-006 | Агент объясняет Botamin на релевантном примере | использует только утверждённые knowledge claims; 10–15 млн ₽/месяц — только атрибутированное сообщение пользовательского брифа, не гарантия |
| US-007 | Я могу возразить или перебить | проигрывание останавливается, новый turn обрабатывается |
| US-008 | Я соглашаюсь на встречу | агент предлагает ровно два server-supplied слота, собирает обязательные данные и вызывает `create_booking` с выбранным кандидатом |
| US-009 | После брони я могу ответить на два доп. вопроса | после confirmation и consent месячный inbound volume и integer `salesManagerCount` патчат ту же бронь |
| US-010 | Я могу отказаться от квалификации | бронь остаётся `booked`, диалог корректно завершается |
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
- **FR-BRAIN-009:** каждый turn получает server-owned `currentInstant`, текущую московскую дату и день недели, а также ровно два structured meeting candidates с server-generated Russian `displayLabel`.
- **FR-BRAIN-010:** cadence умеренно проактивен: один вопрос за раз, не более двух discovery-вопросов до мягкого demo/meeting offer, без повторного давления после ясного отказа.

### 4.3 Booking

- **FR-BOOK-001:** обязательны `conversationId`, имя, компания, рабочий email, телефон или Telegram, `consentConfirmed=true` и structured `meetingSlot`.
- **FR-BOOK-002:** server выдаёт ровно два уникальных внутренних кандидата длительностью 20 минут в `Europe/Moscow`: будни, дата строго позже server-owned московского today, старты по 20-минутной сетке от 09:00 до 17:00 включительно.
- **FR-BOOK-003:** `create_booking` разрешён только в `COLLECT_BOOKING`; выбранный `meetingSlot` обязан byte-for-field совпасть с одним из двух candidates активного turn. Non-candidate, stale, occupied или уже не bookable slot отклоняется.
- **FR-BOOK-004:** `create_booking` атомарен и идемпотентен по `conversationId`/`idempotencyKey`; уникальны conversation и non-null internal `meeting_start_at`.
- **FR-BOOK-005:** успешный tool всегда возвращает стабильный `bookingId`.
- **FR-BOOK-006:** committed `booking.created` и user-facing confirmation предшествуют consent на qualification и первому qualification question.
- **FR-BOOK-007:** backend сохраняет внутреннюю бронь и outbox event, но не создаёт внешнее calendar event/invitation, не вызывает external availability API и не создаёт CRM record.
- **FR-BOOK-008:** in-chat form показывается только по server-owned `COLLECT_BOOKING`, валидирует name/company/working email/phone-or-Telegram и сериализует данные как обычную visitor typed turn; форма не вызывает tool и не подтверждает бронь.

### 4.4 Post-booking qualification

- **FR-QUAL-001:** запускается только при committed `booking.status=booked` и после user-facing booking confirmation.
- **FR-QUAL-002:** пользователь отдельно и явно соглашается на дополнительные вопросы; booking action envelope того же turn не может выдать это согласие.
- **FR-QUAL-003:** conversational collection ограничен двумя полями: `monthlyLeadVolume` только для месячного объёма входящих лидов и `salesManagerCount` как integer `0..10000`.
- **FR-QUAL-004:** оба поля необязательны и могут сохраняться partial patch-операцией; остальные legacy schema fields не являются вопросами текущего flow.
- **FR-QUAL-005:** disconnect/decline переводит qualification в `partial` или `skipped`, но booking остаётся `booked`.
- **FR-QUAL-006:** повторный patch идемпотентен.

### 4.5 Landing and UX

- **FR-WEB-001:** above-the-fold объясняет продукт и содержит один primary CTA.
- **FR-WEB-002:** до запуска голоса показывается понятное объяснение микрофона и обработки данных.
- **FR-WEB-003:** UI имеет состояния `idle`, `connecting`, `listening`, `thinking`, `speaking`, `booked`, `complete`, `error`.
- **FR-WEB-004:** текстовая копия реплик и stage-gated multiline composer доступны в активных visitor-turn stages; Enter отправляет, Shift+Enter добавляет строку.
- **FR-WEB-005:** booking details form существует внутри chat и видима только в `COLLECT_BOOKING`, полученном через server `state.changed`/`session.ready`, а не из transcript wording.
- **FR-WEB-006:** mobile viewport поддерживается.
- **FR-WEB-007:** при voice failure пользователю не показываются stack traces/provider details.

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

`0.5.0-local-rc.2` is accepted only for local hosting on a trusted owner machine. Chrome desktop/mobile and local Compose evidence can close local gates, but cannot close WebKit, target-VPS resource behavior, DNS, public TLS/WSS, or target-host paid-smoke gates. The internal booking remains deliberately different from a real calendar event.
