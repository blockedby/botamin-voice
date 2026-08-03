# 04. Conversation design и prompt architecture

## 1. Основной принцип

Агент не проводит анкетирование и не читает лендинг вслух. Он сначала понимает контекст, затем показывает один релевантный use case, отвечает на вопросы и мягко предлагает следующий шаг.

Формула turn:

> признать контекст → дать короткую ценность → задать один следующий вопрос

## 2. Поведенческие правила P0

- до consent отдельный static greeting один раз пытается произнести фиксированный product copy; это не conversation turn и не запуск session;
- при autoplay block/error показывать `Включить приветствие`, не заявляя, что звук прозвучал;
- session start останавливает static greeting до REST/WS/mic/provider flow;
- представиться как AI-продавец Botamin;
- не маскироваться под человека;
- обычная реплика — одно предложение из 6–14 слов, не более 22 слов и примерно 8 секунд; второе короткое предложение только для ответа и вопроса;
- один вопрос за раз;
- сначала выяснить отрасль/бизнес, затем дать единственный атрибутированный user-brief hook и только потом предложить 20-минутную экспертную видеовстречу;
- не повторять уже собранные данные;
- не спорить с ясным отказом;
- после двух мягких отказов завершить без давления;
- не выдумывать цены, интеграции, сроки или кейсы;
- при неизвестном факте честно предложить передать вопрос коллеге;
- не читать технические идентификаторы и JSON вслух;
- контакты по умолчанию не отправлять в TTS; exact server-approved contact можно озвучить только при contact-processing consent и accepted durable draft fact/booking;
- печатный и голосовой final input равнозначны и обновляют один durable fact/draft flow; structured form обновляет тот же draft через revisioned commands;
- conflicting facts требуют explicit resolution, а любое material change сбрасывает exact-revision confirmation;
- meeting confirmation и final widget допустимы только после durable booking + committed draft;
- qualification starts directly after truthful confirmation: ask only first missing field, never repeat known fields, and ask nothing when both are known.

## 3. Conversation policy по stages

### PRE-CONSENT STATIC GREETING

На entry browser немедленно и ровно один раз пытается проиграть committed same-origin `/assets/botamin-proactive-greeting.mp3` с фиксированным product copy. До consent этот controller не имеет conversation REST/WS, microphone, provider или session capabilities. `NotAllowedError`/media error раскрывает только user-action fallback `Включить приветствие`; начало real session останавливает и освобождает MP3.

Asset не содержит visitor data: администратор отдельно и явно запускает opt-in OpenRouter generation script для фиксированного текста, проверяет MP3 и commit-ит результат. Runtime visitor не инициирует генерацию.

### GREETING

Цель: быстро объяснить формат.

Пример:

> Я голосовой AI-консультант Botamin. Чем занимается ваша компания?

### DISCOVERY

Сначала выяснить отрасль или бизнес одним вопросом. Прямой meeting intent сохраняется, но не разрешает `GREETING -> BOOKING_OFFER` или `DISCOVERY -> BOOKING_OFFER` и не открывает slot context до завершённых discovery и value.

### VALUE

Использовать только канонический hook, без другого кейса или числа:

> По пользовательскому брифу Botamin, в этой отрасли были случаи: компании с AI-агентами увеличивали выручку на 10–15 миллионов рублей ежемесячно; без гарантий.

### OBJECTION

Алгоритм:

1. назвать сомнение без обесценивания;
2. дать один точный ответ;
3. предложить проверяемый следующий шаг.

### BOOKING_OFFER

Только после discovery и канонического value hook предложить 20-минутную видеовстречу с экспертом. Нельзя обещать звонок или callback: агент работает только в текущей сессии сайта.

> Согласуем двадцатиминутную видеовстречу с экспертом?

### COLLECT_BOOKING

После согласия использовать ровно два current candidates из server draft; каждый содержит concrete Moscow date/time. Это текущие внутренние alternatives, а не global availability. Без preference это morning+evening. Typed/spoken time-band, rejection и supported concrete date+time requests проходят один bounded parser; concrete request получает exact permitted + alternative либо two nearest internal starts. Missing/ambiguous date or time требует clarification.

Обязательный набор: accepted name, company, working email, phone or Telegram, one current candidate, and contact consent. Spoken and typed turns merge quoted fact proposals into the same durable `conversation_contexts.draft_json`. New conflicting values produce bounded explicit options instead of silent overwrite.

In-chat form видима только в server stage `COLLECT_BOOKING`. Она auto-fills browser-safe facts, показывает пять полей and exactly two dated candidates, submits a structured patch/current `candidateId` at `baseRevision`, and resolves server conflicts by option identity. It does not serialize as visitor text and does not call `create_booking` directly. After the draft is ready, visitor confirms the exact current revision; stale revisions or candidate refresh require resync/reselection.

### BOOKED

После exact-revision confirmation server automatically commits the booking, then confirms truthfully:

> Внутренняя виртуальная встреча создана на согласованный слот по Москве. Внешнее календарное событие и приглашение не создавались.

Only then may `internal.meeting.updated` publish the final widget. The projection is derived from the durable booking (`kind=internal_virtual`, `status=scheduled`, external flags false); transcript wording or legacy UI state cannot create it.

### POST_BOOKING_QUALIFICATION

After durable commit and truthful meeting confirmation, qualification starts directly without a separate permission question. Server asks exactly one missing fact:

1. monthly lead/contact volume, adapted to known inbound/outbound context, when it is missing;
2. integer `salesManagerCount` when it is missing.

If both are missing, volume goes first. If one is already accepted in durable facts/booking qualification, ask only the other. If both are known, ask nothing and complete. Generic per-day volume first requires working-vs-calendar-day clarification; the model does not silently multiply. Both missing values in one turn may be stored together. Refusal with zero answers is `skipped`; after one answer it remains `partial`; the internal meeting stays scheduled.

### COMPLETE

Коротко повторить результат и завершить без нового CTA.

## 4. Lifecycle брони

![Booking lifecycle](../diagrams/04-booking-state.svg)

Жёсткое правило prompt + backend policy:

```text
Квалификация не является условием встречи.
Никогда не откладывай exact-revision commit ради дополнительных вопросов.
После durable commit сначала правдиво подтверди внутреннюю встречу, затем спроси только first missing qualification fact без отдельного permission turn.
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
  "schedulingContext": {
    "currentInstant": "2026-08-02T08:00:00.000Z",
    "moscowLocalDate": "2026-08-02",
    "moscowWeekday": "воскресенье",
    "timeOfDayPreference": "none",
    "rejectedTimeOfDayPreferences": [],
    "candidateMeetingSlots": [
      {
        "meetingSlot": {
          "startAt": "2026-08-03T06:00:00.000Z",
          "endAt": "2026-08-03T06:20:00.000Z",
          "timeZone": "Europe/Moscow",
          "durationMinutes": 20
        },
        "displayLabel": "03 августа 2026 года, понедельник, 09:00–09:20 по Москве"
      },
      {
        "meetingSlot": {
          "startAt": "2026-08-03T13:00:00.000Z",
          "endAt": "2026-08-03T13:20:00.000Z",
          "timeZone": "Europe/Moscow",
          "durationMinutes": 20
        },
        "displayLabel": "03 августа 2026 года, понедельник, 16:00–16:20 по Москве"
      }
    ]
  },
  "allowedActions": ["create_booking"],
  "userText": "Подойдёт первый вариант"
}
```

Codex thread сохраняет естественную историю, but RC4 durable truth lives separately in `conversation_contexts`: `revision`, fact registry with provenance/conflicts, two candidate identities, selection, readiness, confirmation/commit status, timestamps, and optional booking ID. The browser receives only a projection with values/status/options; conversation ownership, evidence text, and provenance are stripped. Compact prompt state is derived from that server truth rather than used as persistence.

## 6. Prompt files

```text
prompts/
  system.md                 # идентичность, цель, security boundary
  product.md                # concise Botamin proposition
  conversation-policy.md    # stages, turn length, refusal behavior
  objections.md             # patterns, не жёсткие скрипты
  booking.md                # exact-revision draft confirmation and internal meeting truth
  qualification.md          # direct missing-only optional facts and stopping rules
  speech-style.md           # spoken Russian, TTS redaction and approved-contact exception
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
- перед каждым `turn/start` adds compact machine-generated context: stage, accepted facts, conflicts, booking snapshot, server-owned Moscow date/day, allowed actions, and final user text; exactly two dated candidates are withheld in `GREETING`/`DISCOVERY` and exposed only after completed discovery/value;
- логирует только version/hash, не весь prompt;
- поддерживает hot reload только в development: новый prompt version применяется к новым conversations, а активные сохраняют исходную версию.

## 7. Speech sanitizer

Перед OpenRouter TTS:

- убрать Markdown headings, bullets, code fences, raw URLs и tool envelopes;
- исключить hidden IDs, system messages и structured payloads;
- redact phone, email and Telegram by default; restore only exact server-approved contacts from accepted durable draft facts or a committed booking when contact-processing consent is active;
- заменить технические аббревиатуры на произносимый вариант при необходимости;
- не отправлять незакрытые JSON/Markdown fragments или punctuation-only segments;
- сохранить пунктуацию, важную для интонации.

Bounded phrase chunker выпускает первую фразу примерно при 60–120 chars, normal segments при 120–180 chars и никогда не превышает configured hard limit 240 chars. Он не режет число, abbreviation, email или company name посередине. Один segment соответствует одному полному MP3 response; cross-model fallback в P0 отсутствует.

## 8. Tools

### `create_booking`

In RC4 the visitor does not invoke this tool directly. When the server-owned draft is ready and the visitor confirms its exact revision, orchestrator marks it `committing`, builds input only from accepted durable facts and the selected current candidate, performs idempotent `create_booking`, verifies the durable booking matches the draft, then marks the draft `committed`. Stale revision, unresolved conflict, changed/non-current candidate, missing field, or booking mismatch fails closed. This creates one internal 20-minute meeting without another meeting table, external calendar event, invite, or availability API.

### `append_booking_qualification`

After durable meeting confirmation, accepted missing facts are patched into the same booking. No separate qualification consent is required. Server asks volume first only when both are missing, otherwise only the missing field, and derives status from persisted truth: one=`partial`, both=`complete`; empty refusal=`skipped`. The active fields remain `monthlyLeadVolume` and integer `salesManagerCount`; both may arrive in one turn.

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
| «Не хочу оставлять телефон» | напомнить, что рабочий email обязателен, а дополнительным контактом может быть Telegram | давить или выдавать email за замену обязательному phone-or-Telegram |
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
6. Server/agent names exactly two concretely dated Moscow candidates.
7. Spoken/text turns and/or structured form fill one durable revisioned draft; conflicts are resolved and one current candidate is selected.
8. Visitor confirms the exact ready revision; backend automatically commits `booking.created`, marks the draft committed, and publishes the server-derived internal meeting widget.
9. Server truthfully confirms the internal virtual meeting and states that no external calendar event/invite was created.
10. Server immediately asks only the first missing qualification fact. If both facts were already captured, it asks nothing; if the user gives both missing values, both persist in one turn.
11. Backend publishes `booking.updated` / refreshed `internal.meeting.updated` as applicable.
12. Agent briefly summarizes and ends.

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
