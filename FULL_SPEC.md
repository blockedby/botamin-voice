---
title: "Botamin Voice Sales Agent — техническая спецификация"
subtitle: "React + Bun + OpenRouter STT + OpenRouter TTS + Codex subscription / GPT-5.6 Luna"
author: "Architecture & delivery handoff"
date: "31 июля 2026"
lang: ru-RU
---

# Botamin Voice Sales Agent — техническая спецификация

**Версия:** 0.5-demo

**Статус:** основа для передачи агентам-разработчикам

**Deployment target:** одна trusted VPS, один Docker Compose

**Runtime split:** browser PCM16 chunks → gateway/utterance assembler emits one validated WAV → atomic `audio/wav` SttPort request → OpenRouter audio-input chat completion final transcript → Codex app-server / `gpt-5.6-luna` → OpenRouter TTS complete MP3 segment

> Ключевой инвариант: внутренняя бронь создаётся до любой опциональной квалификации. После `booking.created` отказ, обрыв или ошибка квалификации не отменяют и не удаляют лид.

## Карта пакета

Эта сводная версия объединяет scope, PRD, исследование Botamin, архитектуру, conversation design, API/data contracts, deployment/security, ADR, тестирование, сравнение AI-библиотек и parallel delivery plan. Machine-readable backlog и отдельные задания агентам находятся в `tasks/`. All STT/TTS decisions follow `corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md`; correction history is intentionally not assembled into this generated document.

<div class="page-break"></div>



<div class="page-break"></div>

# 00. Scope, допущения и терминология

## 1. Цель MVP

Продемонстрировать работающий вертикальный срез AI-продавца Botamin:

> посетитель открывает лендинг, начинает голосовой разговор, получает релевантную презентацию продукта, отвечает на уточняющие вопросы, соглашается на встречу, передаёт минимальный контакт, после чего backend фиксирует бронь и опционально обогащает её квалификацией.

MVP должен выглядеть как небольшой реальный продукт, а не как набор несвязанных API-примеров.

## 2. Участники

| Участник | Роль |
|---|---|
| Посетитель | потенциальный B2B-клиент Botamin |
| Голосовой AI-продавец | ведёт разговор и достигает целевого действия |
| Backend | владеет состоянием, tools, транзакциями и аудитом |
| Получатель лида | в MVP читает console/webhook/push payload |
| Владелец проекта | редактирует Markdown prompts в Git |

## 3. В scope

- адаптивный лендинг Botamin;
- браузерный доступ к микрофону;
- phrase-level STT на русском: chunked PCM16 до backend, bounded WAV request после `audio.commit`, final transcript only;
- текстовое рассуждение и ответ через GPT-5.6 Luna в Codex;
- phrase-level TTS через полные MP3-сегменты, запускаемый до завершения полного ответа;
- interruption/barge-in на базовом уровне;
- управляемая state machine разговора;
- product knowledge из Botamin-сайта и Telegram-кейсов;
- создание внутренней брони;
- необязательная квалификация после брони;
- SQLite persistence;
- console notifier и интерфейс для webhook/push;
- transcript/event audit;
- Docker Compose, TLS, health checks, backup;
- тесты контрактов, компонентов, E2E и conversation evals.

## 4. Вне scope

- визуальный conversation builder;
- prompt CMS, роли и авторизация редакторов;
- реальный Google Calendar, Calendly или CRM;
- проверка свободных слотов;
- телефония, SIP, PSTN, Twilio;
- исходящие звонки;
- полноценный call-center dashboard;
- биллинг и multi-tenant;
- Kubernetes, autoscaling, микросервисное дробление;
- отдельная vector database и сложный RAG;
- хранение аудиозаписей по умолчанию;
- юридическая экспертиза privacy copy.

## 5. Зафиксированные defaults

| Вопрос | Default MVP |
|---|---|
| Язык | русский; структура допускает локализацию |
| Канал | браузерный voice widget |
| Мозг | Codex app-server, `gpt-5.6-luna` |
| Voice | OpenRouter — единственный STT/TTS gateway; один backend-only key |
| STT profile | `openai/gpt-audio-mini` / `wav` / `ru`, configurable audio-input model; atomic final transcript only |
| TTS profile | `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`, все значения конфигурируемы; usage платный, бесплатный tier не предполагается |
| Backend | Bun + TypeScript, Hono как лёгкий HTTP/WS слой |
| Frontend | React + TypeScript + Vite |
| Storage | SQLite в WAL-режиме, Drizzle migrations |
| Notifications | console обязательно; webhook — адаптер |
| Calendar | отсутствует |
| Prompts | Markdown в Git |
| Deployment | один Compose project на одной VPS; только app + Caddy в P0 application path |
| Raw audio retention | выключено |
| Qualification | включаемая опция, только после booking |

## 6. Допущения, которые агенты не должны превращать в блокеры

- Как минимум один контактный канал обязателен: телефон, email или Telegram.
- Предпочтительное время хранится свободным текстом; календарного slot resolution нет.
- Логотипы, точная типографика и brand book могут быть заменены аккуратным нейтральным стилем.
- Console output является достаточным handoff для P0.
- Если subscription auth временно недоступен, сервис показывает понятный degraded state; автоматический переход на платный API не включается без конфигурации.
- Числовые кейсы на лендинге используются только с подписью источника и без обещания повторить результат.

## 7. Термины

- **Conversation** — одна пользовательская голосовая сессия.
- **Turn** — одна завершённая реплика пользователя и следующий ответ агента.
- **Booking** — внутренняя запись о согласованном следующем шаге, не календарное событие.
- **Qualification** — необязательные сведения, добавляемые к уже существующей брони.
- **BrainPort** — внутренний интерфейс текстового LLM-мозга.
- **VoicePort** — provider-neutral внутренние `SttPort` и `TtsPort`: один STT request принимает bounded `audio/wav` и возвращает один final transcript; один TTS request возвращает один полный `audio/mpeg` phrase segment.
- **Barge-in** — пользователь начинает говорить во время ответа агента.
- **Tool** — строго валидируемая backend-операция с доменным эффектом.
- **Luna** — модель `gpt-5.6-luna`, доступная через Codex.


<div class="page-break"></div>

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
| US-001 | Как посетитель, я запускаю разговор одной кнопкой | запрашивается mic permission, UI показывает состояние |
| US-002 | Я говорю естественно по-русски | UI показывает listening/processing, затем ровно один `transcript.final` |
| US-003 | Агент отвечает голосом и текстом | первая полная MP3-фраза может проиграться до завершения ответа Luna; ответ не содержит markdown-мусора |
| US-004 | Агент понимает, зачем я пришёл | задаёт не более одного вопроса за раз, фиксирует роль/задачу |
| US-005 | Агент объясняет Botamin на релевантном примере | использует только утверждённые knowledge claims |
| US-006 | Я могу возразить или перебить | проигрывание останавливается, новый turn обрабатывается |
| US-007 | Я соглашаюсь на встречу | агент собирает минимум данных и вызывает `create_booking` |
| US-008 | После брони я могу ответить на доп. вопросы | данные патчат ту же бронь через `append_booking_qualification` |
| US-009 | Я могу отказаться от квалификации | бронь остаётся `booked`, диалог корректно завершается |
| US-010 | Получатель видит данные | console/webhook получает структурированный payload |
| US-011 | Сервис перезапускается | сохранённые booking/event данные остаются в volume |
| US-012 | Проект разворачивается на VPS | `docker compose up -d` поднимает готовый сервис |

## 4. Functional requirements

### 4.1 Voice session

- **FR-VOICE-001:** создание сессии должно выдавать уникальный `conversationId`.
- **FR-VOICE-002:** браузер передаёт mono PCM16, 16 kHz, чанками около 100 ms; browser/backend buffers ограничены duration/bytes.
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

### 4.2 Brain and orchestration

- **FR-BRAIN-001:** модель по умолчанию `gpt-5.6-luna`; фактическая модель задаётся `CODEX_MODEL`, но её смена требует повторного conversation eval gate.
- **FR-BRAIN-002:** один Codex thread соответствует одной conversation.
- **FR-BRAIN-003:** backend, а не LLM, является источником истины для текущего stage.
- **FR-BRAIN-004:** LLM не получает shell/network privileges, кроме явно зарегистрированных доменных tools.
- **FR-BRAIN-005:** ответы проходят speech sanitizer перед TTS.
- **FR-BRAIN-006:** system/product/conversation prompts загружаются из Markdown.
- **FR-BRAIN-007:** tool mode имеет feature flag: `dynamic` и стабильный fallback `envelope`.
- **FR-BRAIN-008:** reasoning effort задаётся конфигурацией; стартовый профиль Luna использует минимальный уровень, который проходит quality evals.

### 4.3 Booking

- **FR-BOOK-001:** обязательны `conversationId`, имя и хотя бы один контактный канал.
- **FR-BOOK-002:** `create_booking` атомарен и идемпотентен по `conversationId`/`idempotencyKey`.
- **FR-BOOK-003:** успешный tool всегда возвращает стабильный `bookingId`.
- **FR-BOOK-004:** событие `booking.created` отправляется до первого квалификационного вопроса.
- **FR-BOOK-005:** meeting/calendar event не создаётся.
- **FR-BOOK-006:** агент подтверждает только факт получения данных.

### 4.4 Post-booking qualification

- **FR-QUAL-001:** запускается только при `booking.status=booked`.
- **FR-QUAL-002:** пользователь явно или контекстно соглашается на дополнительные вопросы.
- **FR-QUAL-003:** каждое осмысленное подмножество данных может сохраняться patch-операцией.
- **FR-QUAL-004:** поля qualification необязательны.
- **FR-QUAL-005:** disconnect/decline переводит qualification в `partial` или `skipped`, но booking остаётся `booked`.
- **FR-QUAL-006:** повторный patch идемпотентен.

### 4.5 Landing and UX

- **FR-WEB-001:** above-the-fold объясняет продукт и содержит один primary CTA.
- **FR-WEB-002:** до запуска голоса показывается понятное объяснение микрофона и обработки данных.
- **FR-WEB-003:** UI имеет состояния `idle`, `connecting`, `listening`, `thinking`, `speaking`, `booked`, `complete`, `error`.
- **FR-WEB-004:** текстовая копия реплик доступна для accessibility/debug.
- **FR-WEB-005:** mobile viewport поддерживается.
- **FR-WEB-006:** при voice failure пользователю не показываются stack traces/provider details.

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
| NFR-OPS-001 | deployment | один compose project |
| NFR-OPS-002 | backup | ежедневная копия SQLite + restore check |
| NFR-COMP-001 | browser | актуальные Chrome, Edge, Safari; Firefox best effort |
| NFR-A11Y-001 | keyboard/control labels | WCAG-oriented базовый уровень |

![Целевой latency budget](charts/01-latency-budget.png)

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


<div class="page-break"></div>

# 02. Исследование Botamin и проект воронки

## 1. Источники и ограничение

Исследованы:

- публичный сайт `https://botamin.ru/`;
- публичная лента Telegram `https://t.me/GPT_for_sales`;
- согласованный scope из текущего диалога.

Страница Notion была недоступна. Поэтому этот документ является продуктовым research brief для MVP, а не дословным пересказом исходного тестового.

## 2. Что продаёт Botamin

Сайт позиционирует Botamin как платформу AI-агентов, которая:

- автоматизирует первую линию продаж;
- генерирует и квалифицирует лиды из холодных и входящих источников;
- доводит лид до ключевого этапа воронки;
- работает с входящими, реактивацией и холодными базами;
- отвечает круглосуточно;
- передаёт результат менеджерам и в CRM;
- использует анализ диалогов для улучшения сценариев.

На сайте выделены доказательства и обещания: внедрение «под ключ», большое число внедрений, CRM-интеграции, быстрый ответ и кейсы из разных отраслей. В voice funnel эти тезисы лучше использовать не списком, а в ответ на конкретную боль собеседника.

## 3. Повторяющиеся pain patterns

| Pain | Что обещает сценарий Botamin | Как спросить в разговоре |
|---|---|---|
| медленная реакция | быстрый ответ 24/7 | «Сколько сейчас проходит от заявки до первого контакта?» |
| ночные/выходные лиды | непрерывная первая линия | «Есть заметный входящий поток вне рабочего времени?» |
| нецелевые обращения | автоматическая квалификация | «Какую долю обращений менеджеры отсеивают вручную?» |
| недозвоны/молчуны | follow-up и реактивация | «Что происходит с теми, кому менеджер не дозвонился?» |
| рутина CRM | структурированный handoff | «Менеджеры сами заполняют карточки после разговора?» |
| холодная база | выход на ЛПР и квалификация | «Есть база, которую команда не успевает системно отрабатывать?» |
| нестабильные скрипты | единый сценарий + итерации | «Насколько одинаково менеджеры проводят первую квалификацию?» |

## 4. Что найдено в кейсах

Публичная Telegram-лента содержит кейсы, подходящие как social proof. Числа ниже являются утверждениями источника и не должны подаваться как гарантированный результат будущего клиента.

| Сценарий | Опубликованный результат | Применение в funnel |
|---|---|---|
| «Главтрассы», голосовой outbound | 15% в квалифицированный лид; резюме и транскрипция в Telegram | пример выхода на ЛПР и передачи тёплого лида |
| РоллПроф, входящий + follow-up | 13% доведены до реального интереса | 24/7 и работа с недозвонами |
| продавец утеплительной пены на Авито | рост конверсии с 10% до 45% по публикации | скорость ответа и фильтрация нецелевых |
| поставщик стройматериалов | 1000 обращений, 31% горячих лидов, нагрузка пяти менеджеров | масштаб и квалификация по предметным полям |
| Foxford / сценарий недозвонов | возвращённая и квалифицированная часть пропущенных контактов | реактивация после неуспешного звонка |

### Правило claims

В prompt/knowledge нужно разделить:

- **Product facts:** что платформа умеет и как реализуется.
- **Case claims:** что было опубликовано в конкретном кейсе.
- **Prohibited promises:** «мы гарантированно поднимем конверсию в X раз», «заменим отдел», «окупимся за N дней».

## 5. Предлагаемый landing narrative

### Блок 1. Hero

**Заголовок:**

> AI-продавец, который сам покажет, как перестать терять лиды

**Подзаголовок:**

> Поговорите с голосовым агентом Botamin. Он разберёт ваш процесс, покажет релевантный сценарий и зафиксирует следующий шаг.

**CTA:**

> Поговорить с AI-продавцом

Под CTA: «Нужен микрофон. Разговор можно завершить в любой момент».

### Блок 2. Три ценностных сценария

1. Обрабатывать входящие 24/7.
2. Квалифицировать и передавать только целевые лиды.
3. Реактивировать недозвоны и холодные базы.

### Блок 3. Как это работает

`Источник → AI-первая линия → квалификация → структурированный handoff → менеджер`.

### Блок 4. Кейсы

Показывать 2–3 коротких карточки с источником и контекстом, без перегруза цифрами.

### Блок 5. Voice demo

Sticky/inline widget с transcript, статусом и одной главной кнопкой.

### Блок 6. Trust and limits

- данные не попадают в публичный чат;
- разговор можно остановить;
- реальная встреча в этом MVP не создаётся, данные только фиксируются.

## 6. Воронка

![Воронка Botamin](diagrams/06-funnel.svg)

### Funnel stages и события

| Stage | Цель | Главный event | Drop-off reason examples |
|---|---|---|---|
| Visit | понять ценность | `landing.viewed` | неясный оффер |
| Voice start | снять страх mic | `conversation.started` | permission denied |
| Discovery | найти задачу | `discovery.completed` | слишком много вопросов |
| Value | связать pain и use case | `value.presented` | общая презентация |
| Intent | получить согласие на следующий шаг | `booking.offered` | нет доверия/времени |
| Booking | сохранить минимальный лид | `booking.created` | контакт не собран |
| Qualification | обогатить лид | `qualification.updated` | пользователь устал |
| Handoff | вывести структурированный результат | `notification.sent` | provider/output error |

## 7. Conversation value map

| Что сказал пользователь | Какую ценность раскрыть | Какой кейс допустим |
|---|---|---|
| «Мы долго отвечаем» | SLA и 24/7 первая линия | Авито/РоллПроф |
| «Много мусорных лидов» | квалификация до менеджера | стройматериалы |
| «Есть старая база» | реактивация и follow-up | Foxford/недозвоны |
| «Нужны холодные звонки» | выход на ЛПР, summary | Главтрассы |
| «Боюсь качества» | knowledge base, итерации, human review | общий процесс внедрения |
| «Нужна интеграция» | CRM/connectors как продуктовая возможность | сайт Botamin; без обещания конкретной даты |

## 8. Минимальная квалификация для этого funnel

Квалификация после брони должна выбирать 3–5 вопросов по контексту, а не проходить анкету целиком:

- роль и зона ответственности;
- отрасль / тип продаж;
- объём лидов в месяц или порядок величины;
- входящий, исходящий, реактивация или mix;
- текущий SLA ответа;
- CRM;
- главный bottleneck;
- желаемый срок пилота.

## 9. Контентные риски

- Сайт и Telegram — маркетинговые источники; кейсы нуждаются в аккуратной атрибуции.
- Цены и продуктовые детали могут измениться: не зашивать их в core prompt без даты.
- Агент не должен сравнивать Botamin с конкурентами без отдельной knowledge policy.
- Нельзя придумывать интеграции или функциональность, которой нет в источнике.
- При вопросе, требующем коммерческого расчёта, агент предлагает встречу, а не выдумывает цену.


<div class="page-break"></div>

# 03. Системная архитектура

## 1. Решение верхнего уровня

![Системный контекст](diagrams/01-system-context.svg)

Архитектура намеренно разделяет голос и интеллект:

- **OpenRouter phrase-level STT** — один audio-input chat completion для bounded WAV после конца реплики;
- **Codex app-server + GPT-5.6 Luna** — текстовый reasoning, dialogue policy и tool decisions;
- **OpenRouter TTS** — backend-only paid synthesis через native Bun `fetch`;
- **Bun gateway/utterance assembler** — единственный владелец utterance buffers, PCM16 bounds и PCM16-to-WAV encoding;
- **Bun backend** — владелец state, tools, credentials, voice budgets и persistence.

Действующий pipeline: **browser PCM16 chunks → gateway/utterance assembler bounds mono PCM16 and emits one validated WAV → atomic `audio/wav` SttPort request → OpenRouter audio-input chat completion final transcript → Codex/Luna → OpenRouter TTS complete MP3 segment**. Один OpenRouter key остаётся только на backend и авторизует оба voice endpoint.

Это отличается от end-to-end speech-to-speech: добавляется один orchestration layer, зато используется уже оплаченная Codex subscription и мозг можно заменить без переделки audio UI.

## 2. Контейнеры и компоненты

### React client

Ответственность:

- mic permission;
- AudioWorklet capture;
- resample browser audio до mono PCM16 16 kHz;
- отправка бинарных PCM16 чанков около 100 ms;
- явный end-of-turn `audio.commit` и bounded local buffer;
- UI states `listening → processing → transcript.final`;
- ordered playback queue для полных MP3 phrase segments;
- decode через Web Audio или `HTMLAudio`;
- barge-in: немедленно stop local playback и clear queue;
- rendering transcript/state/errors;
- reconnect с тем же `conversationId`, если сессия ещё жива.

Клиент не знает OpenRouter или Codex credentials и не вызывает providers напрямую.

### Bun API / WebSocket gateway

Ответственность:

- выдача conversation ID;
- аутентификация/лимиты публичной сессии;
- multiplex JSON events и binary audio;
- bounded utterance assembly до `audio.commit`, duration/byte guards и encoding bounded mono PCM16 into exactly one validated WAV;
- atomic provider request lifecycle, abort и stale-turn suppression;
- backpressure;
- orchestration turns;
- speech sanitizer + sentence chunker;
- запись событий и latency;
- cleanup при stop/disconnect.

### ConversationOrchestrator

Источник истины для:

- текущего stage;
- собранных slots;
- разрешённых actions;
- booking lifecycle;
- prompt context;
- retry/cancellation;
- post-booking qualification policy.

LLM предлагает действие, но backend валидирует, разрешено ли оно в текущем состоянии.

### CodexAppServerBrain

P0 transport — direct typed JSON-RPC к app-server. Универсальный AI SDK не используется в критическом пути; подробное сравнение находится в [`10-ai-library-evaluation.md`](docs/10-ai-library-evaluation.md).

- запускает один долгоживущий `codex app-server` процесс;
- transport — JSONL over stdio через внутренний `BrainPort`;
- делает `initialize`/`initialized` один раз;
- создаёт отдельный `thread/start` на conversation;
- модель — `gpt-5.6-luna`;
- читает `item/agentMessage/delta`;
- обрабатывает `item/tool/call`, если включён experimental mode;
- отменяет turn через `turn/interrupt` при barge-in;
- генерирует/версионирует TS schema из установленной версии Codex;
- запускает thread с `cwd=/app/runtime-brain`, где prompt compiler создаёт только `AGENTS.md` и безопасные read-only knowledge-файлы;
- проверяет `instructionSources` из `thread/start`: ожидаемый `AGENTS.md` обязан быть загружен;
- не даёт модели доступ к рабочему репозиторию, `.env`, SQLite или общему filesystem.

### OpenRouterSttAdapter

- server-side native Bun `fetch` к `POST https://openrouter.ai/api/v1/chat/completions`;
- принимает через atomic `SttPort` одну уже закодированную и проверенную gateway 16 kHz mono PCM16 WAV реплику с `contentType: "audio/wav"`;
- повторно валидирует WAV container/format и request duration/byte bounds, отклоняя raw PCM, malformed WAV и mismatched content type;
- base64-кодирует неизменённые WAV bytes и отправляет content part `{"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}`; adapter не добавляет WAV header и не конвертирует PCM;
- default model `openai/gpt-audio-mini`; model, `wav` format и `ru` language задаются env, а audio-input capability проверяется smoke/discovery evidence;
- возвращает один atomic final transcript;
- current official evidence documents chat completions audio input, not a dedicated realtime STT WebSocket; поэтому adapter нельзя называть provider-streaming STT;
- `AbortSignal` и turn identity подавляют aborted/stale result; `400/401/402/404/413` не ретраятся, `429`/retryable `5xx` получают не более одного bounded retry;
- STT retry повторяет только transcription fetch и никогда не запускает Luna, tools или notifier;
- telemetry содержит model/format/status/latency/duration/bytes/retry и safe IDs, но не key, WAV/base64, transcript text или PII.

### OpenRouterTtsAdapter

- server-side native Bun `fetch` к `POST https://openrouter.ai/api/v1/audio/speech`;
- default profile: `x-ai/grok-voice-tts-1.0`, voice `eve`, `response_format=mp3`;
- model, voice, speed и format задаются env; `speed` не отправляется, если empty;
- `Authorization` и optional attribution headers остаются server-side; `X-OpenRouter-Cache: false` обязателен для user-specific speech;
- один HTTP request синтезирует одну короткую фразу; весь response буферизуется, проверяется как непустой bounded `audio/mpeg`, затем эмитится одним atomic segment;
- raw network chunks не считаются самостоятельно playable MP3;
- `AbortSignal` отменяет fetch, а generation filtering отбрасывает late result;
- `429` и retryable `5xx` получают не более одного bounded retry; `400/401/402/403/404/413` не ретраятся по умолчанию;
- `401`, `402` и `404` открывают safe degraded mode; text answer, booking и qualification продолжают работать;
- circuit breaker открывается после трёх consecutive retryable failures и half-opens после cooldown;
- per-segment/turn/session character budgets, concurrency и maximum response bytes ограничены;
- telemetry содержит model/voice/format/chars/status/latency/bytes и safe IDs, но не spoken text, PII, key или audio.

### BookingService

- валидирует contact minimum;
- создаёт/находит booking в одной транзакции;
- обновляет qualification patch;
- пишет event outbox;
- никогда не удаляет booking из-за incomplete qualification.

### Notifier

Интерфейс:

```ts
export interface LeadNotifier {
  publish(event: BookingCreatedEvent | BookingUpdatedEvent): Promise<void>;
}
```

P0 adapter — structured console JSON. P1 — signed HTTP webhook с retry/outbox.

## 3. Критический путь turn

![Turn sequence](diagrams/02-turn-sequence.svg)

### Порядок

1. Browser отправляет примерно 100 ms PCM16 chunks; gateway/utterance assembler собирает их в bounded utterance.
2. End-of-turn / `audio.commit` закрывает реплику. Gateway/utterance assembler проверяет duration/bytes, создаёт и валидирует ровно один mono PCM16 WAV.
3. Gateway передаёт WAV атомарному `SttPort`; OpenRouter STT adapter повторно валидирует/bounds already-WAV request, base64-кодирует его и отправляет один `input_audio` chat completion.
4. Только валидный неустаревший final transcript становится user turn и публикуется как `transcript.final`.
5. Orchestrator добавляет stage, known slots, booking status и краткий dialogue context; Codex thread получает `turn/start` ровно один раз.
6. Text deltas проходят PII-safe sanitizer и bounded phrase chunker.
7. Законченная короткая фраза отправляется в OpenRouter TTS; один request соответствует одному segment.
8. После проверки один полный `audio/mpeg` segment идёт в browser ordered playback queue.
9. Tool call исполняется транзакционно и результат возвращается brain независимо от audio path.
10. Voice retries повторяют только соответствующий pure provider request и никогда не повторяют Luna turn, notifier или business tools.

## 4. Latency design

### Целевой budget

- end-of-turn decision and `audio.commit`: browser/backend measurement point;
- gateway WAV encoding/validation и adapter base64/application overhead измеряются отдельно и имеют независимые bounds;
- OpenRouter phrase-level STT request to final transcript: measured release-profile input, no provider latency guarantee;
- Luna first delta after final transcript: target ≤ 900 ms;
- first phrase buffer: default target 100 chars, idle flush 350 ms;
- OpenRouter request + complete MP3 response: измеряется отдельно для release profile, без provider latency guarantee;
- total target is re-baselined from measured `audio.commit → final transcript → playback`; phrase-level STT necessarily adds post-commit upload/inference latency.

### Приёмы снижения задержки

- показывать client listening/processing state и только atomic `transcript.final`;
- Luna effort `low`/минимально доступный после model capability check;
- короткий state context вместо полного event log;
- запускать phrase-level synthesis до завершения полного Luna ответа;
- первая фраза 60–120 chars, normal soft target 120–180, hard limit 240;
- держать не более одного playing и одного prefetched segment;
- исключить RAG/network tools из критического пути;
- не делать второй classifier call на каждый turn.

## 5. BrainPort

```ts
export type BrainToolMode = "dynamic" | "envelope";

export interface BrainTurnInput {
  conversationId: string;
  threadId?: string;
  userText: string;
  stage: ConversationStage;
  knownFacts: KnownFacts;
  booking: BookingSnapshot | null;
  allowedActions: BrainActionName[];
  promptVersion: string;
}

export interface BrainDelta {
  type: "speech.delta" | "tool.request" | "turn.completed" | "error";
  text?: string;
  tool?: { name: BrainActionName; callId: string; args: unknown };
  error?: { code: string; retryable: boolean; message: string };
}

export interface BrainPort {
  createThread(conversationId: string): Promise<string>;
  runTurn(input: BrainTurnInput, signal: AbortSignal): AsyncIterable<BrainDelta>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
```

## 6. Provider-neutral SttPort

```ts
export type SttTranscriptionRequest = {
  conversationId: string;
  turnId: string;
  audio: Uint8Array;
  contentType: "audio/wav";
  language: string;
  signal: AbortSignal;
};

export type SttTranscriptionResult = {
  conversationId: string;
  turnId: string;
  text: string;
  final: true;
};

export interface SttPort {
  transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>;
  health(): Promise<"ready" | "degraded" | "unavailable">;
}
```

`SttPort` содержит только atomic `transcribe`/`health` operations и provider-neutral request/result types. Chunked PCM16 остаётся отдельным browser-to-backend WS transport; gateway/utterance assembler создаёт один validated WAV request только после `audio.commit`, а adapter принимает только already-WAV bytes.

## 7. Dynamic tools и fallback

### Mode A — `dynamic`

Codex app-server регистрирует динамические tools. Плюс — обычный streamed natural-language ответ и низкая задержка. Минус — API помечен experimental.

Server-side guard:

```ts
if (!policy.isAllowed(state, tool.name)) {
  return toolError("ACTION_NOT_ALLOWED_IN_STATE");
}
const args = ToolSchemas[tool.name].parse(tool.args);
return toolHandlers[tool.name](args);
```

### Mode B — `envelope`

Стабильный fallback с `outputSchema`:

```ts
type BrainEnvelope = {
  speech: string;
  nextStage: ConversationStage;
  action:
    | { type: "none" }
    | { type: "create_booking"; payload: CreateBookingInput }
    | { type: "append_booking_qualification"; payload: QualificationPatchInput };
};
```

В этом режиме TTS обычно стартует после получения валидного envelope, поэтому задержка выше. Feature flag позволяет не блокировать релиз, если dynamic tools изменятся.

## 8. Provider-neutral TtsPort

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

Shared packages не импортируют provider SDK types. Cancellation выполняется request `AbortSignal` плюс `generationId`; provider adapter не меняет public contract.

## 9. State machine

![Conversation state](diagrams/03-conversation-state.svg)

Backend transition function должна быть чистой и покрытой table-driven tests:

```ts
transition(currentState, domainEvent) => nextState | TransitionError
```

LLM не может напрямую записать произвольный next state. Он предлагает intent/action, orchestrator применяет допустимый transition.

## 10. Barge-in

При детекции начала пользовательской речи во время `speaking`:

1. client немедленно очищает audio queue;
2. client посылает `playback.interrupted`;
3. backend помечает текущий response generation как superseded;
4. abort-ит in-flight OpenRouter requests этой generation;
5. вызывает `turn/interrupt`, если Codex turn ещё активен;
6. gateway продолжает принимать новые browser PCM16 chunks в новый bounded utterance;
7. поздние STT results, text и complete MP3 segments старого turn/generation игнорируются.

Ключевой контракт: **устаревший complete audio segment никогда не проигрывается после нового user turn**. OpenRouter-specific cancellation contract не предполагается; cancellation локальна.

## 11. Предлагаемый repository layout

```text
/
  apps/
    web/
      src/audio/
      src/components/
      src/state/
    server/
      src/http/
      src/ws/
      src/orchestrator/
      src/providers/openrouter/stt/
      src/providers/openrouter/tts/
      src/providers/codex/
      src/domain/booking/
      src/notifiers/
      src/db/
  packages/
    contracts/
    prompt-compiler/
    test-fixtures/
  prompts/
    system.md
    product.md
    conversation-policy.md
    objections.md
    booking.md
    qualification.md
  knowledge/
    botamin-overview.md
    cases.md
    faq.md
    allowed-claims.md
  drizzle/
  infra/
    Caddyfile
  docs/
  docker-compose.yml
  Dockerfile
  bun.lock
  package.json
```

## 12. Основные env variables

`.env.example` is the exact active matrix; local defaults are reproduced here without secrets:

```dotenv
# Botamin local development environment
# Copy this file to .env and fill only the secret values marked REQUIRED.
# Never commit .env or Codex authentication files.

# Local application
APP_ORIGIN=http://localhost:5173
AUTO_MIGRATE=true
DATABASE_URL=file:./data/app.db
LOG_LEVEL=info
MAX_ACTIVE_CONVERSATIONS=3
MAX_ACTIVE_CONVERSATIONS_PER_SOURCE=2
MAX_CONCURRENT_BRAIN_TURNS=3
MAX_PENDING_BRAIN_TURNS=6
BRAIN_QUEUE_TIMEOUT_MS=45000
SESSION_MAX_MINUTES=20
SESSION_STOP_DRAIN_MS=5000
TURN_TIMEOUT_MS=45000
TRUSTED_PROXY_HOPS=0
ADMISSION_WINDOW_MS=60000
MAX_CONVERSATION_CREATES_PER_SOURCE=5
MAX_SESSION_CONNECTIONS_PER_SOURCE=20
CLIENT_HELLO_TIMEOUT_MS=2000
ABANDONED_SESSION_TIMEOUT_MS=10000

# Codex subscription brain
# Authentication is performed separately with `codex login --device-auth`.
# Keep CODEX_HOME outside this source repository and use an absolute path.
BRAIN_PROVIDER=codex-subscription
CODEX_MODEL=gpt-5.6-luna
CODEX_EFFORT=low
CODEX_HOME=/home/your-user/.local/share/botamin-voice/codex-home
# Production runtime is fixed to the server-validated envelope mode.
CODEX_TOOL_MODE=envelope
CODEX_CWD=.runtime/brain
CODEX_MAX_CONCURRENT_TURNS=3

# OpenRouter phrase-level STT — backend-only key authorizes STT and TTS
STT_PROVIDER=openrouter
OPENROUTER_STT_MODEL=openai/gpt-audio-mini
OPENROUTER_STT_AUDIO_FORMAT=wav
OPENROUTER_STT_LANGUAGE=ru
STT_CONNECT_TIMEOUT_MS=8000
STT_TOTAL_TIMEOUT_MS=30000
STT_MAX_RETRIES=1
STT_RETRY_BASE_MS=400
STT_MAX_UTTERANCE_MS=30000
STT_MAX_AUDIO_BYTES=1000000
STT_TEXT_ONLY_INPUT_FALLBACK=false

# OpenRouter paid usage; this one key authorizes STT and TTS and never reaches the browser
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# TTS — complete MP3 phrase segments
TTS_PROVIDER=openrouter

OPENROUTER_TTS_MODEL=x-ai/grok-voice-tts-1.0
OPENROUTER_TTS_VOICE=eve
OPENROUTER_TTS_RESPONSE_FORMAT=mp3
# Optional; omit from request if empty
OPENROUTER_TTS_SPEED=

# Optional app attribution; localhost is safe for local development
OPENROUTER_HTTP_REFERER=http://localhost:5173
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

# Booking and qualification
POST_BOOKING_QUALIFICATION_ENABLED=true

# Notifications: console is sufficient for local development
NOTIFIER=console
WEBHOOK_URL=
WEBHOOK_SIGNING_SECRET=
WEBHOOK_TIMEOUT_MS=5000

# Privacy and retention
TRANSCRIPT_RETENTION_DAYS=30
STORE_RAW_AUDIO=false
```

Значение concurrency — initial guardrail, а не окончательная capacity claim; оно настраивается после load test и проверки лимитов конкретной подписки. `MAX_PENDING_BRAIN_TURNS` ограничивает сохранённые в памяти committed WAV; booked sessions имеют отдельную приоритетную FIFO-очередь, а внутри каждой очереди сохраняется порядок поступления. `TRUSTED_PROXY_HOPS=0` безопасно игнорирует forwarding headers для прямого Bun-запуска; Compose явно задаёт `1`, потому что app доступен только через Caddy. `CODEX_MODEL` и `CODEX_EFFORT` конфигурируемы, но любое изменение release-профиля требует полного conversation eval gate.


<div class="page-break"></div>

# 04. Conversation design и prompt architecture

## 1. Основной принцип

Агент не проводит анкетирование и не читает лендинг вслух. Он сначала понимает контекст, затем показывает один релевантный use case, отвечает на вопросы и мягко предлагает следующий шаг.

Формула turn:

> признать контекст → дать короткую ценность → задать один следующий вопрос

## 2. Поведенческие правила P0

- представиться как AI-продавец Botamin;
- не маскироваться под человека;
- одна реплика обычно 1–3 коротких предложения;
- один вопрос за раз;
- не повторять уже собранные данные;
- не спорить с ясным отказом;
- после двух мягких отказов завершить без давления;
- не выдумывать цены, интеграции, сроки или кейсы;
- при неизвестном факте честно предложить передать вопрос коллеге;
- не читать технические идентификаторы и JSON вслух;
- контакт повторять для подтверждения только при низкой уверенности STT;
- booking confirmation произносить сразу после tool success;
- qualification начинается только после confirmation и согласия.

## 3. Conversation policy по stages

### GREETING

Цель: быстро объяснить формат.

Пример:

> Здравствуйте! Я голосовой AI-продавец Botamin. Могу за пару минут разобрать, где у вас теряются лиды, и показать подходящий сценарий. Что сейчас важнее: входящие заявки, недозвоны или холодная база?

### DISCOVERY

Собрать минимум:

- роль;
- основной канал/сценарий;
- bottleneck;
- примерный объём или частоту проблемы.

Не задавать все вопросы, если intent уже очевиден.

### VALUE

Структура:

1. пересказать pain одной фразой;
2. описать релевантный workflow Botamin;
3. привести один case claim с атрибуцией, если помогает;
4. проверить интерес.

### OBJECTION

Алгоритм:

1. назвать сомнение без обесценивания;
2. дать один точный ответ;
3. предложить проверяемый следующий шаг.

### BOOKING_OFFER

Не говорить «давайте созвонимся» без value bridge.

> Похоже, у вас есть конкретный сценарий для пилота. Могу зафиксировать короткую демонстрацию с коллегой, чтобы он пришёл уже с вариантом процесса. Записать?

### COLLECT_BOOKING

Минимальный порядок:

1. имя;
2. один удобный контакт;
3. компания — если ещё не известна;
4. пожелание по времени — свободным текстом.

Если пользователь дал несколько полей одной фразой, не переспрашивать их по одному.

### BOOKED

После `create_booking`:

> Всё получила и зафиксировала. Реальную запись в календарь я сейчас не создаю — коллега свяжется по указанному контакту. Можно ещё три коротких вопроса, чтобы он подготовился?

Формулировку про отсутствие календаря можно сделать менее технической в production copy, но нельзя утверждать обратное.

### POST_BOOKING_QUALIFICATION

Выбирать вопросы динамически. Не более 3–5, если ответы короткие. После каждого содержательного блока допустим partial patch.

### COMPLETE

Коротко повторить результат и завершить без нового CTA.

## 4. Lifecycle брони

![Booking lifecycle](diagrams/04-booking-state.svg)

Жёсткое правило prompt + backend policy:

```text
Квалификация не является условием брони.
Никогда не откладывай create_booking ради дополнительных вопросов.
После tool success сначала подтверди сохранение, затем запроси согласие на qualification.
```

## 5. Объекты памяти

В каждый turn передаётся compact state, а не полный внутренний лог:

```json
{
  "stage": "VALUE",
  "knownFacts": {
    "name": null,
    "role": "руководитель продаж",
    "company": "примерно 30 менеджеров",
    "pain": ["медленный ответ ночью", "много нецелевых"],
    "leadVolume": "около 2000 в месяц",
    "crm": null
  },
  "booking": null,
  "allowedActions": ["offer_booking"],
  "lastUserText": "А как это будет интегрироваться?"
}
```

Codex thread сохраняет естественную историю; compact state страхует от drift и упрощает resume.

## 6. Prompt files

```text
prompts/
  system.md                 # идентичность, цель, security boundary
  product.md                # concise Botamin proposition
  conversation-policy.md    # stages, turn length, refusal behavior
  objections.md             # patterns, не жёсткие скрипты
  booking.md                # tool timing, minimum data, confirmation
  qualification.md          # optional fields and stopping rules
  speech-style.md            # spoken Russian, no markdown
knowledge/
  botamin-overview.md
  use-cases.md
  cases.md
  faq.md
  allowed-claims.md
  prohibited-claims.md
```

Prompt compiler:

- читает файлы в фиксированном порядке;
- проверяет размер и обязательные headings;
- вычисляет SHA-256 `promptVersion`;
- валидирует отсутствие секретов;
- собирает `/app/runtime-brain/AGENTS.md` — основной instruction source для Codex thread;
- при необходимости копирует туда только разрешённые read-only knowledge-файлы; исходный repository туда не монтируется;
- при `thread/start` проверяет, что `instructionSources` содержит ожидаемый `AGENTS.md`;
- перед каждым `turn/start` добавляет компактный machine-generated context envelope: stage, known facts, booking snapshot, allowed actions и текст пользователя;
- логирует только version/hash, не весь prompt;
- поддерживает hot reload только в development: новый prompt version применяется к новым conversations, а активные сохраняют исходную версию.

## 7. Speech sanitizer

Перед OpenRouter TTS:

- убрать Markdown headings, bullets, code fences, raw URLs и tool envelopes;
- исключить hidden IDs, system messages и structured payloads;
- redact phone, email и Telegram handle до отправки provider-у;
- заменить технические аббревиатуры на произносимый вариант при необходимости;
- не отправлять незакрытые JSON/Markdown fragments или punctuation-only segments;
- сохранить пунктуацию, важную для интонации.

Bounded phrase chunker выпускает первую фразу примерно при 60–120 chars, normal segments при 120–180 chars и никогда не превышает configured hard limit 240 chars. Он не режет число, abbreviation, email или company name посередине. Один segment соответствует одному полному MP3 response; cross-model fallback в P0 отсутствует.

## 8. Tools

### `create_booking`

LLM вызывает только когда:

- пользователь согласился;
- известно имя;
- есть хотя бы один контакт;
- согласие на обработку/передачу данных зафиксировано UI или разговором.

### `append_booking_qualification`

LLM вызывает только после `bookingId`. Patch может быть частичным.

Backend возвращает safe result:

```json
{
  "ok": true,
  "bookingId": "bkg_...",
  "status": "booked",
  "messageForAssistant": "Данные сохранены. Можно подтвердить бронь и предложить необязательную квалификацию."
}
```

Не возвращать модели лишние PII или внутренние stack traces.

## 9. Возражения

| Возражение | Ответная стратегия | Запрещено |
|---|---|---|
| «Это будет роботизировано» | признать риск, объяснить настройку knowledge и сценария, предложить demo | обещать неотличимость от человека |
| «Дорого» | уточнить объём рутины/потерь, перевести к расчёту пилота | придумывать цену/ROI |
| «У нас сложный продукт» | спросить пример сложного вопроса, объяснить knowledge boundary | заявлять, что знает любой продукт без внедрения |
| «У нас уже CRM» | объяснить handoff/integration как отдельный слой | обещать конкретный connector без проверки |
| «Не хочу оставлять телефон» | предложить email/Telegram | давить или требовать один канал |
| «Неинтересно» | один раз уточнить причину, затем уважительно завершить | повторно продавать после ясного отказа |

## 10. Failure behavior

### STT uncertainty

> Кажется, я не уверенно расслышала контакт. Повторите, пожалуйста, только адрес или номер.

Не просить повторить всю длинную реплику.

### Brain unavailable before booking

> Сейчас не получается продолжить голосовой разговор. Данные ещё не были зафиксированы — попробуйте начать позже.

### Failure after booking

> Основные данные уже сохранены. Дополнительные вопросы сейчас не обязательны — на этом можно закончить.

### TTS failure

Показать текст ответа и кнопку retry audio; не повторять Luna turn, notifier или tool effect. Budget/circuit failure также переводит только audio path в text-only mode.

## 11. Минимальный пример happy path

1. Агент: спрашивает, какой участок воронки важнее.
2. Пользователь: «Теряем заявки ночью, примерно две тысячи в месяц».
3. Агент: связывает 24/7 входящую обработку и квалификацию с pain; задаёт вопрос о текущем процессе.
4. Пользователь: отвечает и спрашивает про CRM.
5. Агент: описывает integration layer без обещания конкретного срока; предлагает demo.
6. Пользователь: соглашается и даёт имя + Telegram.
7. Backend: `booking.created`.
8. Агент: подтверждает сохранение; просит разрешение на три доп. вопроса.
9. Пользователь: отвечает на роль, CRM и срок.
10. Backend: `booking.updated`.
11. Агент: кратко суммирует и завершает.

## 12. Eval rubric для каждой реплики

Оценка 0/1/2 по параметрам:

- удерживает stage goal;
- не повторяет известное;
- соответствует Botamin facts;
- не делает запрещённых обещаний;
- звучит естественно вслух;
- задаёт максимум один основной вопрос;
- правильно распоряжается booking/qualification order;
- корректно реагирует на отказ/interruption.


<div class="page-break"></div>

# 05. API, события и модель данных

## 1. Общие правила контрактов

- Все JSON payloads валидируются Zod на границе.
- Все timestamps — RFC 3339 UTC.
- Все IDs — UUIDv7 или ULID; внешний формат не должен содержать PII.
- Все события содержат `conversationId`, а booking events также `bookingId`.
- Версия контракта передаётся как `v: 1`.
- Ошибки providers не пробрасываются клиенту напрямую.
- Binary WebSocket frames несут client PCM16 input или один полный server MP3 phrase payload; arbitrary provider network chunks никогда не публикуются как playable audio.
- Tool handlers не доступны как публичные HTTP endpoints.

## 2. REST endpoints

### `POST /api/v1/conversations`

Создать сессию.

Request:

```json
{
  "source": "landing",
  "locale": "ru-RU",
  "qualificationEnabled": true,
  "consent": {
    "voiceProcessing": true,
    "contactProcessing": true
  }
}
```

Response `201`:

```json
{
  "conversationId": "01J...",
  "wsUrl": "/ws/v1/conversations/01J...",
  "clientToken": "opaque-one-use-client-token-32-bytes",
  "expiresAt": "2026-07-30T21:30:00Z",
  "clientConfig": {
    "inputSampleRate": 16000,
    "inputEncoding": "pcm16le",
    "chunkMs": 100,
    "outputContentType": "audio/mpeg",
    "outputMode": "complete-phrase-segments"
  }
}
```

Errors: `CONSENT_REQUIRED`, `CAPACITY_EXCEEDED`, `BRAIN_NOT_READY`. Application JSON over 8192 bytes returns the same structured error envelope with HTTP `413`; Bun's transport hard cap is deliberately higher so this contract is not replaced by an unstructured runtime response. Per-source create admission returns structured HTTP `429`.

### `POST /api/v1/conversations/:id/stop`

Идемпотентно завершает сессию. Основной stop идёт по WS; endpoint нужен для unload/fallback.

### `GET /health/live`

Процесс жив. Не проверяет providers.

### `GET /health/ready`

Проверяет:

- DB write/read;
- Codex app-server handshake;
- наличие auth и модели Luna в `model/list`;
- ровно один `OPENROUTER_API_KEY` для обоих voice paths;
- при `STT_PROVIDER=openrouter`: schema-valid audio-input model/`wav`/language, utterance byte/time limits и request timeout/retry limits; readiness не утверждает наличие provider streaming session;
- при `TTS_PROVIDER=openrouter`: schema-valid model/voice/`mp3`, доступность queue/circuit state и разрешённый text-only output startup policy;
- prompt bundle checksum;
- запущенный persisted notification-outbox worker (provider delivery failure itself remains retryable and does not make booking uncommitted);
- возможность принять новую conversation по active/queued concurrency guards.

### Dev-only

`GET /api/dev/conversations/:id` — transcript/events для локальной отладки. Endpoint отсутствует в production build или защищён отдельным token.

## 3. WebSocket protocol

### Handshake

Клиент подключается к `/ws/v1/conversations/:conversationId` и первым JSON frame отправляет:

```json
{
  "v": 1,
  "type": "client.hello",
  "payload": {
    "resumeToken": "opaque-one-use-client-token-32-bytes",
    "audio": {
      "encoding": "pcm16le",
      "sampleRate": 16000,
      "channels": 1,
      "chunkMs": 100
    }
  }
}
```

Server:

```json
{
  "v": 1,
  "type": "session.ready",
  "conversationId": "01J...",
  "seq": 1,
  "at": "2026-07-30T20:17:00.000Z",
  "payload": {
    "state": "GREETING",
    "resumeToken": "opaque-short-lived-token",
    "clientConfig": {
      "inputSampleRate": 16000,
      "inputEncoding": "pcm16le",
      "chunkMs": 100,
      "outputContentType": "audio/mpeg",
      "outputMode": "complete-phrase-segments"
    }
  }
}
```

### Client → server JSON events

| Event | Payload | Назначение |
|---|---|---|
| `client.hello` | audio config, resume token | handshake |
| `audio.commit` | `{}` | закрыть bounded utterance и создать ровно один atomic final-transcription request |
| `playback.started` | `generationId` | метрика |
| `playback.interrupted` | `generationId`, reason | barge-in |
| `session.stop` | reason | корректное завершение |
| `client.ping` | timestamp | keepalive |

Первый `client.hello` обязан предъявить одноразовый `clientToken` из REST response; `session.ready` сразу заменяет его новым resume token. На session допускается один pending hello-кандидат с коротким deadline и один bound socket. Reconnect заменяет bound socket только после полной проверки hello/token; неподтверждённый кандидат его не вытесняет.

После handshake PCM16 audio идёт binary frames без base64. Gateway/utterance assembler ограничивает accumulated duration/bytes и после `audio.commit` кодирует ровно один validated mono PCM16 WAV. Этот WAV передаётся atomic `SttPort`; только OpenRouter adapter выполняет base64 encoding уже готовых WAV bytes. Browser chunks не означают streaming transport до provider.

### Server → client events

| Event | Payload |
|---|---|
| `session.ready` | state/config |
| `state.changed` | from/to/reason; voice UI uses listening/processing states |
| `transcript.final` | turnId/text; единственное STT text event после atomic provider result |
| `assistant.text.delta` | generationId/text |
| `assistant.text.done` | generationId/fullText |
| `audio.segment` | generationId, segmentId, sequence, `contentType=audio/mpeg`, byteLength, `final=true`; immediately followed by one complete binary MP3 payload |
| `assistant.audio.done` | generationId |
| `assistant.interrupted` | generationId |
| `booking.created` | safe booking summary |
| `booking.updated` | qualification status |
| `session.capacity_warning` | optional |
| `error` | safe error object |
| `server.pong` | timestamp |

### Binary framing

Client microphone frames remain PCM16LE and are accumulated only within configured utterance duration/byte bounds until `audio.commit`. Server audio is an atomic phrase-level MP3 payload associated with the preceding `audio.segment` metadata event:

```text
byte 0:     kind (0x01 client PCM16LE, 0x02 server MP3 segment)
bytes 1-8: unsigned sequence, big-endian/network byte order
bytes 9+:  payload (raw PCM16LE or one complete MP3 file)
```

Sequence is a nonnegative JavaScript safe integer (`0..Number.MAX_SAFE_INTEGER`). For `audio.segment`, metadata `byteLength` counts only the MP3 payload at bytes 9+, excluding the 9-byte frame header. The server metadata sequence and raw frame sequence must match, and kind must be `0x02`.

The implementation may use a referenced binary payload instead of adjacency if it preserves the same identity, ordering, canonical frame layout and payload-size contract. It must never expose partial `response.body` chunks as independent MP3 files.

### Ordering

- `seq` монотонно растёт для JSON events в одной conversation.
- один accepted `audio.commit` создаёт не более одного active STT request и одного `transcript.final`; duplicate commits и stale results подавляются.
- audio segments имеют `generationId`, unique `segmentId` и monotonic `sequence`.
- client decodes/plays complete segments in order and ignores segments from an interrupted or obsolete generation.
- одновременно допустимы максимум один playing и один prefetched segment.
- booking events записываются в DB до отправки клиенту.

## 4. Provider-neutral voice contracts

### Atomic SttPort

```ts
export type SttTranscriptionRequest = {
  conversationId: string;
  turnId: string;
  audio: Uint8Array;
  contentType: "audio/wav";
  language: string;
  signal: AbortSignal;
};

export type SttTranscriptionResult = {
  conversationId: string;
  turnId: string;
  text: string;
  final: true;
};

export interface SttPort {
  transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>;
  health(): Promise<"ready" | "degraded" | "unavailable">;
}
```

`SttPort` exposes only atomic `transcribe` and `health` operations with provider-neutral request/result types. The gateway/utterance assembler owns chunked PCM16 transport, duration/byte bounds and creation of exactly one validated WAV. The adapter accepts only already-WAV `audio/wav` bytes, independently validates their format and request bounds, rejects raw PCM, base64-encodes the unchanged WAV, and posts one `input_audio` to `/api/v1/chat/completions`. Only a non-empty validated, current final transcript can reach Luna.

### Atomic TtsPort

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

The adapter validates `2xx`, compatible `audio/mpeg`, non-empty bounded bytes and current `generationId` before returning. OpenRouter types and response objects do not cross `TtsPort`.

### OpenRouter STT failure mapping

| HTTP | Mapping | Retry/behavior |
|---:|---|---|
| 400 | invalid audio/request | no retry; safe input error |
| 401 | missing/invalid shared key | no retry; readiness/config error |
| 402 | insufficient credits | no retry; voice input unavailable |
| 404 | model unavailable/config error | no retry; readiness/config error |
| 413 | utterance/request too large | no retry; enforce local bounds |
| 429 | rate limited | at most one retry; bounded `Retry-After` |
| 500/502/503/524/529 | gateway/upstream | at most one bounded retry |

STT retry repeats only the same transcription request. Abort/stale turn returns no transcript; no STT retry invokes Luna, `create_booking`, `append_booking_qualification` or notifier. Error parsing and telemetry never log Authorization, WAV/base64 bytes, transcript text or PII.

### OpenRouter TTS failure mapping

| HTTP | Mapping | Retry/degradation |
|---:|---|---|
| 400 | invalid request/profile | no retry |
| 401 | key/config error | no retry; open circuit, readiness/config signal |
| 402 | insufficient credits | no retry; open circuit, text-only |
| 403 | policy restriction | no retry by default |
| 404 | model unavailable/config error | no retry; open circuit |
| 413 | chunker/request defect | no retry |
| 429 | rate limited | at most one retry; honor bounded `Retry-After` |
| 500/502/503/524/529 | gateway/upstream | at most one bounded retry |

Non-2xx body is parsed as bounded JSON/text and never forwarded as audio. No retry occurs after abort or after a segment was accepted for playback. Retry repeats only synthesis, not Luna, `create_booking`, `append_booking_qualification` or notifier.

## 5. Tool contracts

### `create_booking`

```ts
const ContactSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("phone"), value: z.string().min(5).max(64) }),
  z.object({ channel: z.literal("email"), value: z.string().email() }),
  z.object({ channel: z.literal("telegram"), value: z.string().min(2).max(128) }),
]);

const CreateBookingInputSchema = z.object({
  conversationId: z.string().min(10),
  idempotencyKey: z.string().min(10).max(128),
  name: z.string().min(1).max(120),
  contacts: z.array(ContactSchema).min(1).max(3),
  company: z.string().max(200).optional(),
  preferredTimeText: z.string().max(500).optional(),
  consentConfirmed: z.literal(true),
});
```

Result:

```ts
type CreateBookingResult = {
  ok: true;
  created: boolean; // false на idempotent replay
  bookingId: string;
  status: "booked";
  createdAt: string;
};
```

### `append_booking_qualification`

```ts
const QualificationPatchSchema = z.object({
  role: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
  companySize: z.string().max(100).optional(),
  monthlyLeadVolume: z.string().max(100).optional(),
  currentChannels: z.array(z.string().max(80)).max(10).optional(),
  crm: z.string().max(120).optional(),
  currentProcess: z.string().max(1000).optional(),
  pains: z.array(z.string().max(300)).max(10).optional(),
  desiredUseCase: z.string().max(500).optional(),
  timeline: z.string().max(200).optional(),
  notes: z.string().max(1500).optional(),
}).strict();

const AppendQualificationInputSchema = z.object({
  bookingId: z.string().min(10),
  idempotencyKey: z.string().min(10).max(128),
  patch: QualificationPatchSchema,
  completion: z.enum(["partial", "complete", "skipped"]).default("partial"),
});
```

Result:

```ts
type AppendQualificationResult = {
  ok: true;
  bookingId: string;
  qualificationStatus: "partial" | "complete" | "skipped";
  updatedFields: string[];
  updatedAt: string;
};
```

## 6. Domain policy до tool execution

```ts
switch (tool.name) {
  case "create_booking":
    assert(state === "COLLECT_BOOKING");
    assert(currentBooking === null || currentBooking.conversationId === conversationId);
    break;
  case "append_booking_qualification":
    assert(["BOOKED", "POST_BOOKING_QUALIFICATION"].includes(state));
    assert(currentBooking?.id === args.bookingId);
    break;
}
```

LLM-provided `conversationId`, `bookingId` и consent сверяются с server-side session; нельзя доверять им как единственному источнику.

## 7. SQLite model

### `conversations`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | ULID/UUIDv7 |
| `status` | text | active/completed/failed/disconnected |
| `stage` | text | state machine stage |
| `codex_thread_id` | text nullable | internal |
| `prompt_version` | text | SHA-256 |
| `source` | text | landing |
| `locale` | text | ru-RU |
| `qualification_enabled` | integer | bool |
| `consent_at` | text | timestamp |
| `started_at` | text | timestamp |
| `ended_at` | text nullable | timestamp |
| `last_error_code` | text nullable | safe code |

### `turns`

- `id` PK;
- `conversation_id` FK;
- `user_text`;
- `assistant_text`;
- `state_before`, `state_after`;
- `audio_commit_at`, `stt_request_at`, `stt_final_at`;
- `brain_started_at`;
- `first_text_delta_at`;
- `first_audio_at`;
- `completed_at`;
- `interrupted`;
- `brain_model`;
- `usage_json` nullable.

### `bookings`

| Column | Constraint |
|---|---|
| `id` | PK |
| `conversation_id` | UNIQUE NOT NULL |
| `status` | CHECK = `booked` in MVP |
| `name` | NOT NULL |
| `contacts_json` | NOT NULL |
| `company` | nullable |
| `preferred_time_text` | nullable |
| `qualification_json` | default `{}` |
| `qualification_status` | none/partial/complete/skipped |
| `created_at`, `updated_at` | timestamps |

### `idempotency_keys`

- `scope`;
- `key`;
- `request_hash`;
- `result_json`;
- `created_at`;
- unique `(scope, key)`.

Если тот же key приходит с другим request hash — `IDEMPOTENCY_CONFLICT`.

### `domain_events`

Append-only audit:

- `id`, `conversation_id`, `booking_id` nullable;
- `type`;
- `payload_json` с редактированными PII;
- `created_at`.

### `notification_outbox`

- event reference;
- notifier kind;
- status pending/sent/failed;
- attempt count;
- next attempt;
- last error.

## 8. Транзакция booking create

```text
BEGIN IMMEDIATE
  lookup idempotency key
  if found: return stored result
  lookup booking by conversation_id
  if found: persist replay key and return same booking
  insert booking
  insert domain_event booking.created
  insert notification_outbox
  persist idempotency result
COMMIT
```

После commit:

1. отправить WS `booking.created`;
2. notifier worker публикует payload;
3. assistant получает safe tool result;
4. только потом orchestrator разрешает qualification stage.

## 9. Notification payloads

### Created

```json
{
  "v": 1,
  "type": "booking.created",
  "eventId": "evt_...",
  "occurredAt": "2026-07-30T20:22:00Z",
  "data": {
    "bookingId": "bkg_...",
    "conversationId": "conv_...",
    "name": "Александр",
    "contacts": [{ "channel": "telegram", "value": "@alex" }],
    "company": "Example LLC",
    "preferredTimeText": "завтра после 15:00",
    "status": "booked",
    "qualificationStatus": "none"
  }
}
```

### Updated

```json
{
  "v": 1,
  "type": "booking.updated",
  "eventId": "evt_...",
  "occurredAt": "2026-07-30T20:24:00Z",
  "data": {
    "bookingId": "bkg_...",
    "qualificationStatus": "partial",
    "qualification": {
      "role": "Head of Sales",
      "monthlyLeadVolume": "около 2000",
      "crm": "amoCRM",
      "pains": ["лиды ждут ночью"]
    }
  }
}
```

Webhook P1 подписывается `HMAC-SHA256(timestamp + '.' + rawBody)` и содержит event ID для deduplication.

## 10. Safe error taxonomy

| Code | Retry | User-facing behavior |
|---|---|---|
| `MIC_PERMISSION_DENIED` | no | инструкция открыть доступ |
| `SESSION_EXPIRED` | new session | перезапуск |
| `CAPACITY_EXCEEDED` | later | сервис временно занят |
| `STT_UNAVAILABLE` | yes | retry/connect message |
| `BRAIN_AUTH_REQUIRED` | admin | user-safe unavailable state |
| `BRAIN_RATE_LIMITED` | later | graceful stop; keep booking |
| `BRAIN_PROTOCOL_ERROR` | yes/fallback | switch envelope or stop |
| `TTS_UNAVAILABLE` | text fallback | показать текст |
| `BOOKING_VALIDATION_FAILED` | user correction | спросить конкретное поле |
| `IDEMPOTENCY_CONFLICT` | admin review | не повторять effect |
| `DB_UNAVAILABLE` | no create | не подтверждать booking |
| `NOTIFIER_FAILED` | async retry | booking всё равно создан |

## 11. Retention

- raw audio: не хранить;
- transcript: `TRANSCRIPT_RETENTION_DAYS`, default 30 дней; startup и hourly runner удаляют bounded batches из `turns` по durable timestamp, не удаляя conversation/booking;
- bookings: до ручного удаления/экспорта и никогда не каскадно из transcript purge;
- events: минимум срок отладки и аудита, configurable;
- Codex thread state: stop/expiry прерывает turn, вызывает `thread/delete`, очищает process-local maps; TTS session budgets также reset;
- backups наследуют срок хранения и шифруются.


<div class="page-break"></div>

# 06. Deployment, security и operations

## 1. Deployment topology

![Deployment](diagrams/05-deployment.svg)

Один `docker-compose.yml`, ровно два application-path сервиса рекомендуются:

1. `app` — Bun server, React static, Codex app-server child process, SQLite access и native HTTPS `fetch` к OpenRouter.
2. `caddy` — TLS termination и WebSocket reverse proxy.

Отдельного voice runtime/container нет. OpenRouter вызывается напрямую из `app` по HTTPS для atomic STT chat completions и complete-segment TTS; один runtime-only key авторизует оба.

Persistent volumes:

- `app-data:/data` — SQLite и backups;
- `codex-home:/codex-home` — `auth.json`, Codex thread/session metadata.

## 2. Compose requirements

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - app-data:/data
      - codex-home:/codex-home
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health/live"]
      interval: 15s
      timeout: 3s
      retries: 5
    expose: ["3000"]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./infra/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    depends_on:
      app:
        condition: service_healthy
```

Это ориентир; финальный compose должен pin-ить image/tool versions.

## 3. Docker image

Multi-stage:

1. build frontend;
2. install server production deps;
3. install pinned Codex CLI binary/version;
4. generate Codex TS/JSON schemas при build или CI;
5. compile prompt bundle в isolated `/app/runtime-brain/AGENTS.md`;
6. runtime image содержит только production assets, migrations, source Markdown prompts и compiled safe runtime bundle.

Не использовать floating `latest` для Codex в production. Версия CLI фиксируется, потому что app-server schemas version-specific. `OPENROUTER_API_KEY` inject-ится только runtime secret/env и отсутствует в build args, layers, image history и rendered Compose evidence.

## 4. Codex subscription auth на VPS

### Bootstrap

После первого deploy:

```bash
docker compose run --rm app codex login --device-auth
docker compose run --rm app codex login status
```

`CODEX_HOME=/codex-home` должен указывать на persistent volume.

### Preflight

Deployment script делает:

1. `codex login status`;
2. старт app-server и handshake;
3. `model/list`, проверка `gpt-5.6-luna`;
4. `thread/start` в `CODEX_CWD` и проверка `instructionSources` на compiled `AGENTS.md`;
5. короткий synthetic turn;
6. проверка `turn/interrupt`;
7. запись/чтение SQLite;
8. проверка prompt bundle checksum.

Если preflight не прошёл, `/health/ready` возвращает 503 и новые voice sessions не создаются.

### Ограничения subscription mode

- `auth.json` — парольоподобный секрет;
- хранить только на trusted private VPS;
- не коммитить, не включать в image/backup без шифрования;
- одна копия auth должна использоваться одной машиной или сериализованным job stream;
- горизонтальное масштабирование с общей personal auth не планируется;
- лимиты подписки и credits могут быть исчерпаны;
- API-key auth остаётся архитектурным fallback, но не включён по умолчанию.
- личная subscription auth считается MVP-оптимизацией, а не production SLA; до публичного коммерческого запуска требуется review применимости плана, capacity и текущих правил провайдера;
- public browser не получает generic Codex execution: backend принимает только ограниченный conversation protocol, применяет rate limits/state policy и запускает brain в изолированном read-only runtime.

## 5. Codex process supervision

- один long-running `codex app-server` child process;
- Bun supervisor перезапускает его с exponential backoff;
- при падении активные turns получают `BRAIN_PROCESS_RESTARTED`;
- thread IDs сохраняются, но resume после restart проверяется contract test;
- stdout — только protocol JSONL, stderr отправляется в structured logs с redaction;
- pending RPC map имеет timeout и cleanup;
- входящие events маршрутизируются по `threadId`/`turnId`;
- при graceful shutdown новые turns не принимаются, текущим даётся короткое drain window.

## 6. Security model

### Browser boundary

- same-origin API/WSS;
- TLS обязателен;
- origin validation;
- short-lived resume token;
- IP/session rate limit;
- ограничение размера JSON и audio frames;
- no provider secrets;
- CSP и secure headers;
- mic permission только после user gesture.

### Codex boundary

- `approvalPolicy: never`;
- максимально ограниченный sandbox/permission profile;
- `cwd` — отдельная runtime directory, не source repository;
- read roots — только isolated `/app/runtime-brain` с compiled `AGENTS.md` и allowlisted knowledge;
- network/command tools блокируются acceptance test;
- разрешены только зарегистрированные booking tools;
- tool args всегда повторно валидируются;
- unexpected tool request отклоняется и логируется.

### Data protection

- raw audio не сохраняется;
- PII redaction в общих логах;
- contact values доступны только booking payload и защищённому storage;
- `.env`, единственный OpenRouter key, webhook secret, Codex auth, WAV/base64 audio и transcript PII не попадают в logs;
- browser bundle и events не содержат OpenRouter key или direct provider URL;
- DB volume и backup с ограниченными permissions;
- privacy/consent copy перед микрофоном;
- deletion runbook по `conversationId`/`bookingId`;
- финальная юридическая формулировка требует отдельной проверки владельцем продукта.

## 7. Observability

### Structured log fields

```json
{
  "level": "info",
  "event": "brain.turn.completed",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "stage": "VALUE",
  "durationMs": 823,
  "firstDeltaMs": 611,
  "model": "gpt-5.6-luna",
  "promptVersion": "sha256:..."
}
```

PII не включается в generic logs.

### Metrics

- active conversations;
- WS reconnect/disconnect;
- audio input bytes/duration;
- `audio.commit` → OpenRouter final transcript latency, WAV duration/bytes, status/retry/stale-turn counts;
- brain queue time, first delta, completion;
- OpenRouter TTS request/completion latency, status, bounded bytes and character usage;
- final transcript → playback первой complete MP3 phrase;
- interrupted/stale segment count, circuit state, budget rejection и text-only degradation;
- booking create/update success/error;
- notifier outbox lag;
- provider error/rate-limit counts;
- Codex auth age/status;
- SQLite file/WAL size.

Для дешёвой VPS P0 может писать metrics JSON в log. P1 — Prometheus endpoint или lightweight collector.

## 8. Health model

| Check | Live | Ready |
|---|---:|---:|
| Bun event loop/process | yes | yes |
| DB | no | read+write |
| prompts | no | checksum/parse |
| Codex process | no | handshake/model/auth |
| OpenRouter STT | no | shared key, model/format/language and utterance/request bounds; no provider-session claim or paid call on every check |
| OpenRouter TTS | no | same shared key, model/voice/format schema, queue/circuit state; no paid call on every check |
| capacity | no | STT request, brain and TTS queues below thresholds |
| notifier | no | outbox worker running; external outage не блокирует booking |

Notifier failure не должен делать app unready, если outbox сохраняет событие. TTS config failure may allow startup only when `TTS_TEXT_ONLY_FALLBACK=true`; readiness must expose degraded state rather than pretending OpenRouter is ready. Healthchecks never spend OpenRouter usage.

## 9. Backup and restore

- SQLite online backup или `VACUUM INTO`, не простой copy активного WAL-файла;
- ежедневный encrypted snapshot;
- retention configurable;
- регулярный restore test в временный файл;
- `codex-home` backup отдельно и только если необходим; auth backup шифруется;
- prompts восстанавливаются из Git/image;
- runbook фиксирует RPO/RTO после выбора хостинга.

## 10. Capacity guard

Первый релиз должен ограничивать concurrency, потому что:

- Codex subscription имеет rolling usage limits;
- одна auth identity — single-host constraint;
- cheap VPS имеет ограниченные CPU/RAM;
- voice providers имеют rate limits.

Механизм:

```text
MAX_ACTIVE_CONVERSATIONS
MAX_ACTIVE_CONVERSATIONS_PER_SOURCE
MAX_CONCURRENT_BRAIN_TURNS
MAX_PENDING_BRAIN_TURNS
BRAIN_QUEUE_TIMEOUT_MS
MAX_CONVERSATION_CREATES_PER_SOURCE
MAX_SESSION_CONNECTIONS_PER_SOURCE
CLIENT_HELLO_TIMEOUT_MS
ABANDONED_SESSION_TIMEOUT_MS
STT_MAX_UTTERANCE_MS
STT_MAX_AUDIO_BYTES
STT_TOTAL_TIMEOUT_MS
TTS_MAX_CONCURRENCY
TTS_PREFETCH_SEGMENTS
TTS_MAX_CHARS_PER_TURN
TTS_MAX_CHARS_PER_SESSION
SESSION_MAX_MINUTES
TURN_TIMEOUT_MS
```

При переполнении новая сессия/turn получает structured `CAPACITY_EXCEEDED`. Committed WAV остаётся bounded in-memory до admission или timeout. Очередь разделена на booked и standard FIFO lanes: booked lane выбирается первой, порядок внутри lane не меняется. Stop/expiry отменяет queued work и является bounded cancellation barrier для STT/brain/TTS/tool events.

Source key берётся из direct peer address. Forwarded IP игнорируется при безопасном default `TRUSTED_PROXY_HOPS=0`; Compose задаёт ровно один trusted Caddy hop. Malformed forwarding chains fail closed. Create/WS attempt windows и active sessions per source дополняют global limits; Origin остаётся дополнительной, но не единственной защитой. REST выдаёт одноразовый first-hello token, pending socket ограничен одним и abandoned REST-created session освобождается раньше общего TTL.

## 11. Failure and degraded modes

| Failure | Поведение |
|---|---|
| Codex auth expired | readiness 503, admin alert; существующая booking не теряется |
| Luna quota/rate limit | очередь с коротким timeout; затем graceful user message |
| OpenRouter STT timeout/down | no transcript, no Luna/tools; discard bounded utterance and show safe retry state |
| OpenRouter STT `400/401/402/404/413` | typed non-retryable input/config/credit error; never fabricate text |
| OpenRouter STT `429`/retryable `5xx` | at most one pure transcription retry; abort/stale result cannot invoke brain/tools |
| OpenRouter TTS `401/402/404` | no retry; safe text-only output mode/circuit, keep text and booking |
| OpenRouter TTS `429`/retryable `5xx` | at most one synthesis-only retry, then text-only/circuit policy |
| TTS timeout, budget or invalid audio | drop audio segment, keep visible text and tool effects; never repeat Luna/tools |
| DB locked/error | не подтверждать booking до commit |
| notifier down | outbox retry; booking считается созданной |
| client disconnect before booking | conversation `disconnected` |
| client disconnect after booking | booking stays; qualification partial/skipped |
| app restart | restore DB; unfinished conversation marked interrupted/expired |

## 12. Basic runbook

### Deploy

```bash
git pull
docker compose build --pull
docker compose run --rm app bun run db:migrate
docker compose up -d
docker compose ps
curl -fsS https://HOST/health/ready
```

### Re-authenticate Codex

```bash
docker compose stop app
docker compose run --rm app codex login --device-auth
docker compose run --rm app codex login status
docker compose up -d app
```

### OpenRouter deploy smoke

After runtime secrets are installed on the target VPS:

```bash
docker compose run --rm app bun run scripts/openrouter-stt-smoke.ts
docker compose run --rm app bun run scripts/openrouter-tts-smoke.ts
```

Both external paid smokes are deploy/manual-only and excluded from default CI. STT uses a bounded Russian WAV fixture, requires one non-empty final transcript and prints only status/latency/byte counts/safe IDs—not audio or text. TTS writes MP3 outside the repository or to an ignored artifact path and requires `2xx`, `audio/mpeg` and non-empty bytes. Both fail safely for missing key and typed provider/config errors. Neither smoke is claimed by this documentation migration.

### Inspect last booking events

```bash
docker compose logs app --since 30m | grep 'booking\.'
```

### Restore

1. stop app;
2. verify backup checksum;
3. restore into a new DB path;
4. run integrity check and migrations;
5. point `DATABASE_URL` to restored file;
6. start and validate `/health/ready`;
7. retain old file until manual confirmation.


<div class="page-break"></div>

# 07. Trade-offs и Architecture Decision Records

## ADR-001. Разделить OpenRouter voice gateway и Codex/Luna brain

**Статус:** accepted.

### Решение

- OpenRouter phrase-level STT: речь → текст;
- Codex app-server + `gpt-5.6-luna` по умолчанию: диалог, policy, tools; model/effort остаются конфигурацией;
- OpenRouter TTS: текст → complete MP3 phrase segments через server-side Bun adapter.

### Почему

- пользователь уже имеет Codex subscription;
- Luna — быстрый и дешёвый вариант в семействе для повторяемых high-volume turns;
- voice provider и brain можно менять независимо;
- backend сохраняет полный контроль над business state.

### Цена решения

- phrase-level STT ждёт конец реплики, WAV upload и inference до появления final transcript, поэтому end-to-end latency выше;
- больше HTTP requests и failure modes;
- нужен sentence chunker и interruption coordination;
- subscription auth требует операционной дисциплины.

### Митигация

chunked browser capture, bounded utterance, short TTS phrases, compact prompt context, low effort, provider adapters and separate commit-to-final/final-to-playback instrumentation.

## ADR-002. Использовать Codex subscription auth на trusted VPS

**Статус:** accepted с риском.

### Плюсы

- использует уже оплаченную подписку/credits;
- Luna доступна через Codex;
- быстрый старт без отдельного API-billing path.

### Минусы

- OpenAI рекомендует API keys для большинства generic automation сценариев;
- auth cache — чувствительный секрет;
- rolling limits не являются гарантированной production capacity;
- одна копия auth — одна машина/сериализованный поток;
- re-auth и изменения продукта могут потребовать участия владельца.

### Guardrails

- single VPS / single app replica;
- persistent encrypted/permissioned `CODEX_HOME`;
- startup preflight и admin alert;
- `BrainPort` позволяет добавить API-key adapter;
- приложение не покупает credits автоматически.

## ADR-003. Не использовать универсальный AI SDK в primary realtime runtime

**Статус:** accepted.

### Рассмотрено

| Вариант | Результат |
|---|---|
| Direct Codex app-server JSON-RPC | выбран для P0: полный доступ к threads, streamed deltas, `turn/interrupt`, `instructionSources` и experimental tools |
| `@openai/codex-sdk` | официальный и удобный для обычных streamed runs, но публичный TS surface не гарантирует обязательный low-level app-server control; официально требует Node 18+, а runtime — Bun |
| Vercel AI SDK | полезен для normalized text/structured output и future API-key adapters; Codex app-server bridge — community provider, а binary voice path всё равно custom |
| LangChain/LangGraph/Mastra | не выбран: deterministic state machine уже решает orchestration, дополнительный graph layer не даёт выигрыша |
| OpenAI Responses API | хороший production fallback, но usage-based и не использует subscription allowance |
| End-to-end speech-to-speech provider | не выбран: текстовый brain и domain/tool policy должны оставаться Codex/Luna и backend-owned |

### Реализация

`BrainPort` изолирует transport. P0 — тонкий typed client к pinned `codex app-server`; protocol schemas проверяются contract tests. Zod используется для собственных domain/API contracts. `@openai/codex-sdk` разрешён только для spike/offline evals или будущей замены adapter после прохождения тех же interrupt/tool/isolation tests.

Подробная матрица — в [`10-ai-library-evaluation.md`](docs/10-ai-library-evaluation.md).

## ADR-004. Dynamic tools — только за feature flag

**Статус:** accepted.

Dynamic tool API Codex app-server экспериментальный. Default может быть `dynamic` после contract test, но `envelope` fallback обязателен. Release не должен зависеть от незамеченного protocol drift.

## ADR-005. Backend-owned state machine

**Статус:** accepted.

Prompt-only state считается недостаточным. LLM может предложить action, но transition и side effects разрешает deterministic policy. Это особенно важно для порядка booking → qualification.

## ADR-006. Prompts в Markdown, без онлайн-редактора

**Статус:** accepted.

Плюсы: Git history, diff, review, простая параллельная работа. Минусы: нет non-technical editor и мгновенной публикации. Для MVP это правильный обмен.

## ADR-007. SQLite + WAL

**Статус:** accepted для single VPS.

Плюсы: минимум ops, транзакции, backup, один volume. Минусы: один writer/host, нет горизонтального scale. Текущий deployment всё равно single-replica из-за subscription auth.

## ADR-008. Один Compose project, modular monolith

**Статус:** accepted.

Приложение логически модульное, но не дробится на services. Caddy может быть вторым контейнером в том же Compose.

## ADR-009. Бронь — внутренняя сущность, не календарь

**Статус:** accepted.

Это сокращает scope и позволяет проверить conversation/tool design. UI и voice copy обязаны не создавать ложного ожидания calendar event.

## ADR-010. Qualification только после booking

**Статус:** accepted, non-negotiable.

Плюсы: меньше потерянных лидов и ясная транзакционная граница. Минусы: booking может быть менее подробно квалифицирована. Этот минус ожидаем и допустим.

## ADR-011. PCM speech output path

**Статус:** rejected for P0 / superseded by ADR-015.

Raw PCM applies only to browser microphone input. P0 speech output uses complete `audio/mpeg` phrase segments; arbitrary network response chunks are not treated as playable files.

## ADR-012. TTS profile and paid usage are configuration facts

**Статус:** superseded by ADR-015.

No free usage allowance is assumed. Model, lowercase voice ID, format and optional speed remain environment configuration. Character telemetry, hard budgets, circuit breaker and text-only degradation protect the demo from uncontrolled paid usage.

## ADR-013. Codex subscription/Luna — MVP optimization, не production entitlement

**Статус:** accepted с release guard.

Используем подписку владельца и `gpt-5.6-luna`, потому что это быстро и снижает прямой variable cost прототипа. При этом Codex account auth предназначен для trusted private automation, а public conversational workload не должен рассматриваться как гарантированный production API/SLA.

Guardrails:

- browser никогда не взаимодействует с Codex напрямую;
- rate limit, bounded queue, session limit и sandbox обязательны;
- до публичного коммерческого запуска проводится plan/terms/capacity review;
- `BrainPort` допускает отдельный API-key adapter;
- exhaustion subscription quota переводит сервис в controlled degraded mode, не повреждая booking data.

## ADR-015 — OpenRouter is the P0 TTS gateway

**Status:** accepted.

Use a TypeScript/Bun adapter with native `fetch` against `POST https://openrouter.ai/api/v1/audio/speech`. Default profile: `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`. Do not use a second TTS gateway, Python sidecar or provider SDK in P0. Keep `TtsPort` provider-neutral and retain text-only degradation.

Consequences and guardrails:

- OpenRouter and its upstream are external paid dependencies; no free tier is assumed.
- One request produces one buffered, validated, complete `audio/mpeg` phrase segment.
- Only server-side native Bun `fetch` is used; no provider SDK is required for P0.
- Model/voice availability and price are runtime facts recorded in release evidence, not permanent documentation constants.
- `401`, `402`, `404`, bounded `429`/retryable `5xx`, circuit breaker, character budgets and text-only behavior follow the contracts in docs 03/05/06.
- Retry repeats only pure synthesis and never repeats Luna or business side effects.

## ADR-016 — OpenRouter is the only P0 voice gateway

**Status:** accepted; Correction 004 authority.

Use one backend-only `OPENROUTER_API_KEY` for both voice paths. After `audio.commit`, the gateway/utterance assembler encodes bounded mono PCM16 into one validated WAV and passes it through atomic provider-neutral `SttPort`. The adapter validates/bounds the already-WAV request, base64-encodes unchanged bytes, and uses native Bun `fetch` to `/api/v1/chat/completions`; the configurable default model is `openai/gpt-audio-mini`. Return one final transcript.

Official evidence documents chat-completions audio input, base64, model-dependent formats and audio-input model filtering. It does not currently document a dedicated realtime STT WebSocket. Therefore browser PCM16 may remain chunked to the backend, while the active provider boundary is one atomic WAV request and one final transcript.

Consequences and guardrails:

- accept extra post-commit upload/inference latency and measure `audio.commit → final transcript` separately;
- bound utterance duration/bytes, WAV/base64 memory, timeouts and retry count;
- abort and suppress stale turns before they can invoke Luna/tools;
- map `400/401/402/404/413/429/5xx` to typed safe errors without key/audio/PII logs;
- default tests use a fake endpoint; paid Russian smoke is opt-in and must be reported only when observed;
- no second voice provider, credential, task path, diagram or source requirement is active.

## Metered voice cost inputs

![OpenRouter STT + OpenRouter TTS metered usage](charts/02-openrouter-stt-tts-cost.png)

The chart deliberately contains no numeric currency estimate. Variable usage depends on measured OpenRouter STT audio usage and OpenRouter TTS input characters multiplied by the current account/model rates and units verified at deployment. The release owner records current pricing evidence and measured volumes; VPS, bandwidth and Codex subscription/credits are accounted separately.

## Capacity envelope Codex subscription

Для планирования:

```text
примерные sessions per rolling window
= available Luna local messages / average brain turns per session
```

При 8 brain turns на conversation даже широкий published range даёт сильно разную capacity. Поэтому:

- не обещать throughput до preflight/load test на конкретном аккаунте;
- записывать turns/session;
- иметь concurrency queue;
- в случае роста трафика включить API-key BrainPort или отдельный production billing path.

## Risk register

| ID | Риск | Вероятность | Влияние | Митигация |
|---|---|---:|---:|---|
| R-01 | subscription quota исчерпана | medium | high | capacity limit, metrics, API fallback interface |
| R-02 | auth refresh/re-login | medium | high | persistent CODEX_HOME, readiness, runbook |
| R-03 | app-server experimental tool drift | medium | high | pin version, generated schemas, envelope fallback |
| R-04 | phrase-level voice latency выше SLO | medium | high | bounded utterances, separate timing, low effort, shorter TTS phrases |
| R-05 | STT неверно распознаёт контакт | medium | high | targeted confirmation, validation |
| R-06 | LLM нарушает booking order | low/medium | high | backend state policy, tests |
| R-07 | duplicate booking on reconnect | medium without guard | high | unique constraint + idempotency |
| R-08 | marketing hallucination | medium | medium/high | allowed claims, evals, source attribution |
| R-09 | PII leak in logs | medium | high | redaction and log tests |
| R-10 | cheap VPS resource pressure | medium | medium | guardrails, metrics, bounded buffers |
| R-11 | OpenRouter STT/TTS model, voice, price or upstream availability changes | medium | medium/high | env profiles, opt-in external smokes, usage telemetry, bounds/circuit, safe degraded modes |
| R-12 | user thinks calendar event exists | medium | medium | explicit copy and payload semantics |

## Revisit triggers

Пересмотреть архитектуру, если:

- одновременно нужно больше одной VPS/реплики;
- Luna subscription становится bottleneck;
- median conversations требуют >12 brain turns;
- OpenRouter model/voice availability or paid rate changes materially;
- p95 latency стабильно >3 s;
- dynamic tools ломаются после upgrade;
- появляется реальная CRM/calendar integration;
- нужен multi-tenant data isolation.


<div class="page-break"></div>

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
- запрещён `append_booking_qualification` до booking;
- `create_booking` разрешён только из collection stage;
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

- one booking per conversation;
- same idempotency key/same payload → same result;
- same key/different payload → conflict;
- qualification patch merges fields;
- empty patch rejected;
- notifier failure не rolls back booking;
- PII redaction.

## 3. Provider contract tests

### Gateway WAV encoder and OpenRouter STT

Default deterministic suites use no external credentials and keep ownership tests separate.

Gateway/utterance-assembler tests prove:

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
- real SQLite transaction + fake notifier;
- booking tool call inside brain turn;
- booking event appears before qualification prompt/audio;
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
7. complete booking;
8. see booked UI;
9. continue/skip qualification;
10. verify backend DB/event payload.

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
17. даёт все данные одной репликой;
18. исправляет контакт.

### Booking invariants

19. retry create;
20. disconnect сразу после create;
21. отказывается от qualification;
22. отвечает только на один qualification вопрос;
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
- one-question guideline;
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

### Product

- [ ] Landing speaks specifically about Botamin.
- [ ] Primary CTA starts voice flow.
- [ ] Agent introduces itself as AI.
- [ ] At least three Botamin use cases are covered.
- [ ] Clear refusal ends conversation correctly.

### Voice

- [ ] Opt-in paid Russian STT smoke returns one final transcript from a bounded, validated WAV.
- [ ] Voice UI exposes exactly one current `transcript.final` for each accepted utterance.
- [ ] Chosen OpenRouter voice is understandable in the target-VPS Russian smoke.
- [ ] Complete `audio/mpeg` phrase segments decode in sequence in Chromium and WebKit.
- [ ] Barge-in stops old playback, clears queue and drops late segments.
- [ ] `401`/`402`/`404`, budget and circuit failures preserve text UX and booking.
- [ ] No TTS retry repeats Luna, notifier or business tools.

### Booking

- [ ] Valid minimal details produce one booking.
- [ ] `booking.created` is printed/pushed before qualification.
- [ ] Duplicate retries return same `bookingId`.
- [ ] Qualification patches the same booking.
- [ ] Skip/disconnect never removes booking.
- [ ] Agent does not claim calendar creation.

### Brain

- [ ] Codex subscription auth preflight passes.
- [ ] `gpt-5.6-luna` is actually selected.
- [ ] Prompts load from Markdown and have a version hash.
- [ ] Dynamic tools or envelope fallback passes contract tests.
- [ ] Shell/network actions are blocked.

### Operations

- [ ] `docker compose up -d` works on a clean VPS.
- [ ] TLS/WSS works.
- [ ] `/health/live` and `/health/ready` are correct.
- [ ] SQLite survives restart.
- [ ] Backup can be restored.
- [ ] No provider keys in frontend bundle/logs.
- [ ] Compose has only app and Caddy in the P0 path, and no TTS sidecar.
- [ ] Runtime OpenRouter secret wiring and target-VPS smoke command are documented.
- [ ] Text-only mode is enabled through env without rebuilding the image.

## 11. Release evidence bundle

Агент, собирающий RC, прикладывает:

- commit SHA;
- compose config without secrets;
- health output;
- schema migration status;
- Codex model/auth preflight result без token;
- target-VPS OpenRouter Russian STT and MP3 smoke statuses, latency, byte counts, safe provider IDs if present and selected model/voice/format;
- evidence timestamps for `audio.commit`, STT request/final result, first Luna delta, TTS request/completion and playback;
- 24+ eval summary;
- latency report;
- duplicate/idempotency test report;
- one redacted `booking.created` и `booking.updated` example;
- known limitations.


<div class="page-break"></div>

# 09. Параллельный план задач для агентов

## 1. Принцип декомпозиции

Работа делится по стабильным интерфейсам, чтобы агенты могли реализовывать куски с fakes до общей интеграции. Единственная ранняя общая точка — `packages/contracts` и repository skeleton.

Не назначать двум агентам одновременное владение одним каталогом. Изменения общих contracts идут через владельца T00 или отдельный маленький PR.

![Task dependencies](diagrams/07-task-dependencies.svg)

![Parallel waves](charts/03-parallel-workstreams.png)

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

- `bun install`, `bun run typecheck`, `bun test` работают;
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

### T40 — Release candidate

**Владелец:** A0 или release integrator  
**Зависимости:** T31, T32.

- all gates green;
- compose clean deploy;
- active docs/tasks/env/agent packets/diagrams/charts/sources contain no stale second voice provider, credential/path or provider-streaming STT instruction and match code;
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

Реальные OpenRouter/Codex tests проходят на VPS/staging с tagged test command.

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

Полный backlog с dependencies, acceptance и outputs находится в [`../tasks/tasks.yaml`](tasks/tasks.yaml).


<div class="page-break"></div>

# 10. Выбор AI-библиотеки и transport для Codex/Luna

## 1. Решение

Для P0 не вводится единый универсальный AI SDK в критический realtime-путь.

- **OpenRouter STT:** native Bun `fetch` к `/api/v1/chat/completions`; gateway/utterance assembler supplies one bounded, validated `audio/wav` request after `audio.commit`, adapter validates and base64-encodes those unchanged WAV bytes as `input_audio`, and returns one final transcript.
- **OpenRouter TTS:** native Bun `fetch` к dedicated speech endpoint; one complete MP3 phrase per request, no SDK.
- **LLM brain:** `BrainPort`, реализованный поверх долгоживущего `codex app-server` и его JSON-RPC protocol.
- **Model:** `gpt-5.6-luna` через Codex subscription владельца; `CODEX_MODEL`/`CODEX_EFFORT` конфигурируемы, но Luna — согласованный P0 default.
- **Schemas:** Zod для собственных contracts; Codex protocol types/schemas фиксируются вместе с pinned CLI version.
- **Vercel AI SDK:** не является dependency P0; может появиться позже в text-only или API-key adapter, если даст измеримое упрощение.
- **`@openai/codex-sdk`:** не используется в основном voice runtime, пока не предоставляет обязательный low-level control над `turn/interrupt`, app-server threads, dynamic tools и exact streamed deltas на Bun.

Итоговая граница позволяет заменить transport без изменения оркестратора:

```ts
export interface BrainPort {
  createThread(conversationId: string): Promise<string>;
  runTurn(input: BrainTurnInput, signal: AbortSignal): AsyncIterable<BrainDelta>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
```

## 2. Почему у задачи необычные требования

Обычная библиотека для `generateText()` недостаточна. Голосовой продавец требует одновременно:

1. входные и выходные stream deltas;
2. первый текстовый delta до завершения всего ответа;
3. немедленный interrupt при barge-in;
4. стабильный thread на всю conversation;
5. tool calls с backend-side policy;
6. subscription authentication, а не только API key;
7. изолированный `cwd`, sandbox и проверяемый `AGENTS.md`;
8. точные provider timestamps для latency SLO;
9. работу в Bun process на дешёвой VPS;
10. возможность перейти на другой brain provider без переписывания domain state.

Любая абстракция, скрывающая turn IDs, cancellation semantics или provider events, ухудшает корректность этого MVP.

## 3. Матрица вариантов

Оценка: `++` хорошо подходит, `+` подходит с оговорками, `−` существенный пробел, `—` не подходит.

| Критерий | Direct Codex app-server | `@openai/codex-sdk` | Vercel AI SDK + community Codex provider | LangChain/LangGraph/Mastra |
|---|---:|---:|---:|---:|
| Codex subscription auth | ++ | ++ | + | − |
| `gpt-5.6-luna` | ++ | ++ | + | − |
| Точные streamed message deltas | ++ | + | + | + |
| `turn/interrupt` для barge-in | ++ | − на текущем публичном TS surface | зависит от community adapter | зависит от custom adapter |
| App-server thread lifecycle | ++ | −/ограниченно | + | − |
| Dynamic tools + protocol fallback | ++ | −/ограниченно | +/experimental | +, но поверх ещё одного слоя |
| `instructionSources` verification | ++ | − | зависит от adapter | − |
| Bun compatibility | ++ через stdio/JSON | требует spike; официально заявлен Node 18+ | обычно совместим, но adapter нужно проверять | требует проверки каждого слоя |
| Voice transport | custom OpenRouter STT/TTS native fetch adapters всё равно нужны | те же custom adapters | те же custom adapters | те же custom adapters |
| Protocol observability | ++ | + | +/− | − |
| Объём собственного кода | средний | низкий | низкий/средний | высокий суммарно |
| Риск abstraction drift | низкий при pinning | средний | высокий для community bridge | высокий |
| Рекомендация для P0 | **да** | нет в критическом пути | нет в критическом пути | нет |

## 4. Разбор вариантов

### 4.1. Direct `codex app-server` JSON-RPC — выбран

Преимущества:

- официальный app-server protocol содержит `thread/start`, `turn/start`, `item/agentMessage/delta` и `turn/interrupt`;
- backend видит реальные `threadId`, `turnId`, completion status и provider errors;
- можно включать experimental dynamic tools только feature flag-ом;
- можно проверять `instructionSources` и фактическую загрузку compiled `AGENTS.md`;
- stdio JSON-RPC не зависит от browser/provider SDK;
- легче доказать, что поздние deltas прерванного turn не попадут в TTS.

Цена:

- нужно написать process supervisor, pending request map, event router и schema contract tests;
- protocol version необходимо pin-ить и проверять на upgrade;
- часть app-server API experimental.

Для проекта это приемлемо: transport локальный, ограниченный и скрыт за `BrainPort`.

### 4.2. Официальный `@openai/codex-sdk`

Плюсы:

- официальный TypeScript package;
- поддерживает start/resume thread, buffered run, streaming events и structured output;
- снижает объём кода для обычных Codex jobs.

Почему не выбран для voice runtime:

- официальный surface ориентирован прежде всего на coding-focused Codex threads;
- публичный TypeScript API уже даёт `runStreamed()`, но не гарантирует полный app-server control, который нужен для `turn/interrupt`, dynamic tools и `instructionSources`;
- документация указывает Node.js 18+, а проект фиксирует Bun;
- voice barge-in нельзя строить на уничтожении всего процесса: нужен адресный interrupt конкретного turn.

Допустимое применение: offline eval runner, prompt smoke scripts или будущая замена transport после contract spike. Он не должен протечь за границу `BrainPort`.

### 4.3. Vercel AI SDK

Плюсы:

- хороший TypeScript API для text generation, structured output, tools, UI streaming и multi-provider fallback;
- имеет общие transcription/realtime abstractions, но они не заменяют проверенный OpenRouter audio-input chat-completions contract;
- существует community provider для Codex app-server.

Почему не выбран как spine:

- Codex app-server integration является community provider, а не официальным OpenAI provider;
- binary microphone transport, phrase-level MP3 playback, cancellation и generation IDs всё равно остаются custom;
- дополнительный normalized event layer может скрыть provider-specific cancellation/status детали;
- задача не требует типичного React chat hook или model switching в каждом turn.

Возможное P1-применение:

- text-only fallback UI;
- отдельный API-key `BrainPort`;
- offline summarization/evals;
- provider fallback после появления production traffic.

### 4.4. LangChain, LangGraph, Mastra и аналогичные orchestration frameworks

Не используются. Business workflow уже является небольшой детерминированной state machine. Добавление agent graph поверх неё создаст вторую конкурирующую модель состояния, усложнит traces и не решит voice transport/subscription auth.

## 5. Обязательный adapter contract

Независимо от конкретной библиотеки, brain implementation проходит один набор тестов:

| ID | Проверка | Критерий |
|---|---|---|
| B-01 | Auth/model preflight | subscription auth валиден, `gpt-5.6-luna` присутствует |
| B-02 | Instruction loading | `thread/start` подтверждает ожидаемый compiled `AGENTS.md` |
| B-03 | Streaming | первый speech delta приходит до turn completion |
| B-04 | Interrupt | активный turn заканчивается `interrupted`; поздние deltas отбрасываются |
| B-05 | Tool policy | запрещённый tool не исполняется; разрешённый проходит Zod + state guard |
| B-06 | Fallback | при выключенных dynamic tools работает structured envelope mode |
| B-07 | Process recovery | падение child process очищает pending requests и отражается в readiness |
| B-08 | Runtime isolation | shell/network/source repo/`.env` недоступны модели |
| B-09 | Bun | suite проходит внутри production Bun image |
| B-10 | Protocol drift | несовместимое обновление CLI ломает CI contract test, а не production silently |

## 6. Package policy

Предлагаемый минимум:

```json
{
  "dependencies": {
    "hono": "<pinned>",
    "zod": "<pinned>",
    "drizzle-orm": "<pinned>"
  },
  "devDependencies": {
    "@openai/codex-sdk": "<optional-pinned-for-spikes-or-evals>"
  }
}
```

Правила:

- production не зависит от floating versions;
- Codex CLI version и generated schemas меняются одним отдельным PR;
- `@openai/codex-sdk` не импортируется из domain/orchestrator packages;
- OpenRouter-specific types не импортируются из shared contracts;
- OpenRouter STT and TTS transports do not add an SDK; native Bun `fetch` is the P0 decision;
- provider adapter обязан маппить ошибки в собственный стабильный `BrainError`/`VoiceError` union.

## 7. Влияние Codex subscription на продукт

Использование личной подписки — сознательный MVP trade-off, а не production SLA:

- экономит отдельный API budget и позволяет использовать Luna;
- требует trusted private VPS и защищённого persistent `CODEX_HOME`;
- concurrency и rolling limits принадлежат подписке, а не нашему приложению;
- public website не получает прямой доступ к Codex: каждый запрос проходит rate limit, state policy и sandbox;
- перед публичным коммерческим запуском владелец должен подтвердить применимость условий плана и реальную capacity;
- `BrainPort` заранее допускает API-key/provider adapter без изменения воронки, booking domain и UI.

## 8. Финальный вывод

Для этого MVP лучшая «AI-библиотека» — не универсальный framework, а узкая внутренняя abstraction:

```text
ConversationOrchestrator
        │
        ▼
     BrainPort
        │
        └── P0: Codex app-server JSON-RPC + gpt-5.6-luna + subscription auth

VoiceOrchestrator
        ├── SttPort: gateway-produced validated audio/wav → OpenRouter native Bun fetch → final transcript
        └── TtsPort: OpenRouter native Bun fetch → complete audio/mpeg phrase segment
```

Это минимизирует latency и magic, сохраняет barge-in, делает booking/qualification проверяемыми и оставляет путь к замене провайдера. Универсальный SDK стоит подключать только после появления конкретной функции, которая окупает дополнительный слой.


<div class="page-break"></div>

# Источники

Дата доступа: 31 июля 2026.

## Botamin

- Официальный сайт: https://botamin.ru/
- Публичная Telegram-лента кейсов: https://t.me/s/GPT_for_sales
- Исходная Notion-ссылка, недоступная на момент работы: https://uprosti.notion.site/conversation-designer

## OpenRouter voice — официальная документация

- Multimodal audio input/output guide: https://openrouter.ai/docs/guides/overview/multimodal/audio
- Audio-input model endpoint evidence for `openai/gpt-audio-mini`: https://openrouter.ai/api/v1/models/openai/gpt-audio-mini/endpoints
- Audio-input model discovery: https://openrouter.ai/api/v1/models?input_modalities=audio

Проверенные факты для STT: audio input идёт через `/api/v1/chat/completions` как base64 `input_audio`; format указывается в request и зависит от модели; каталог можно фильтровать по audio input. Endpoint evidence на дату доступа содержит `audio` в `input_modalities` для configurable default `openai/gpt-audio-mini`. В активных evidence нет документированного dedicated realtime STT WebSocket, поэтому P0 использует atomic phrase-level WAV request и final transcript only.

### TTS

- TTS guide: https://openrouter.ai/docs/guides/overview/multimodal/tts
- Create speech API: https://openrouter.ai/docs/api/api-reference/tts/create-speech
- Speech-output model discovery: https://openrouter.ai/api/v1/models?output_modalities=speech
- Filtered models page: https://openrouter.ai/models?input_modalities=text&output_modalities=speech
- P0 model page: https://openrouter.ai/x-ai/grok-voice-tts-1.0
- Authentication: https://openrouter.ai/docs/api_reference/authentication
- Errors and debugging: https://openrouter.ai/docs/api_reference/errors-and-debugging
- App attribution: https://openrouter.ai/docs/app-attribution

OpenRouter TTS is paid usage; no free tier is assumed. Default release candidate profile is `x-ai/grok-voice-tts-1.0` / `eve` / `mp3`, but availability, voices and prices are runtime facts verified before release. P0 transport is backend-only native Bun `fetch` to `/api/v1/audio/speech`.

## OpenAI Codex — официальная документация

- Codex app-server: https://developers.openai.com/codex/app-server
- Authentication: https://developers.openai.com/codex/auth
- Trusted CI/CD account auth: https://developers.openai.com/codex/auth/ci-cd-auth
- Codex models: https://developers.openai.com/codex/models
- Codex pricing/limits: https://developers.openai.com/codex/pricing
- Developer commands / device auth: https://developers.openai.com/codex/developer-commands
- Codex SDK: https://developers.openai.com/codex/codex-sdk
- AGENTS.md instructions: https://developers.openai.com/codex/agent-configuration/agents-md

Критичные выводы: ChatGPT sign-in поддерживает subscription access; app-server предоставляет JSON-RPC, threads, streamed agent deltas и interrupt; Luna запускается как `gpt-5.6-luna`; dynamic tools — experimental; account-auth automation рекомендуется только на trusted private infrastructure и с одной машиной/сериализованным использованием auth copy.

## AI SDK candidates

- Official Codex TypeScript SDK: https://developers.openai.com/codex/codex-sdk
- Official Codex TypeScript SDK source/README: https://github.com/openai/codex/tree/main/sdk/typescript
- Vercel AI SDK overview: https://ai-sdk.dev/
- Vercel AI SDK community Codex app-server provider: https://ai-sdk.dev/providers/community-providers/codex-app-server

Вывод: официальный TS SDK удобен для `run`/`runStreamed`, но документированный surface уже, чем app-server protocol; community Codex bridge не принимается как критическая dependency. Для P0 выбран direct app-server adapter, скрытый за `BrainPort`.
