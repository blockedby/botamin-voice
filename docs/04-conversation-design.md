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
- одна реплика обычно 1–3 коротких предложения;
- один вопрос за раз;
- умеренно проактивно предложить demo/встречу не позднее ответа на второй discovery-вопрос;
- не повторять уже собранные данные;
- не спорить с ясным отказом;
- после двух мягких отказов завершить без давления;
- не выдумывать цены, интеграции, сроки или кейсы;
- при неизвестном факте честно предложить передать вопрос коллеге;
- не читать технические идентификаторы и JSON вслух;
- контакт повторять для подтверждения только при низкой уверенности STT;
- печатный и голосовой final input равнозначны по смыслу и проходят один state/tool flow;
- booking confirmation произносить только после committed tool success;
- после confirmation задать точно `Можно задать два коротких вопроса?` и не считать booking action envelope согласием;
- qualification начинается только после отдельного явного согласия: server спрашивает leads, затем manager count, по одному; completion только при обоих.

## 3. Conversation policy по stages

### PRE-CONSENT STATIC GREETING

На entry browser немедленно и ровно один раз пытается проиграть committed same-origin `/assets/botamin-proactive-greeting.mp3` с фиксированным product copy. До consent этот controller не имеет conversation REST/WS, microphone, provider или session capabilities. `NotAllowedError`/media error раскрывает только user-action fallback `Включить приветствие`; начало real session останавливает и освобождает MP3.

Asset не содержит visitor data: администратор отдельно и явно запускает opt-in OpenRouter generation script для фиксированного текста, проверяет MP3 и commit-ит результат. Runtime visitor не инициирует генерацию.

### GREETING

Цель: быстро объяснить формат.

Пример:

> Здравствуйте! Я голосовой AI-продавец Botamin. Могу за пару минут разобрать, где у вас теряются лиды, и показать подходящий сценарий. Что сейчас важнее: входящие заявки, недозвоны или холодная база?

### DISCOVERY

Найти роль/сценарий и основной bottleneck. Задавать по одному вопросу и не более двух discovery-вопросов до краткого мягкого предложения demo/встречи. Если intent очевиден раньше, переходить к value/offer без анкеты.

### VALUE

Структура:

1. пересказать pain одной фразой;
2. описать релевантный workflow Botamin;
3. привести один case claim с атрибуцией, если помогает;
4. проверить интерес.

Число 10–15 млн ₽ в месяц допустимо только в точной атрибуции: это сообщение пользовательского брифа Botamin о прошлых результатах компаний, без независимой проверки, гарантии, прогноза или обещания собеседнику.

### OBJECTION

Алгоритм:

1. назвать сомнение без обесценивания;
2. дать один точный ответ;
3. предложить проверяемый следующий шаг.

### BOOKING_OFFER

Не говорить «давайте созвонимся» без value bridge.

> Похоже, у вас есть конкретный сценарий для пилота. Могу зафиксировать короткую демонстрацию с коллегой, чтобы он пришёл уже с вариантом процесса. Записать?

### COLLECT_BOOKING

После согласия назвать ровно два `schedulingContext.candidateMeetingSlots` по их server-generated `displayLabel`. Это две текущие внутренние альтернативы, а не вся глобальная доступность. Не вычислять и не переформатировать дату, день недели, время или доступность.

Без предпочтения server даёт один morning и один evening candidate. Явная typed/spoken русская формулировка про утро, день, вторую половину дня или вечер обновляет context и даёт два in-band варианта примерно в часе друг от друга; при занятости server переносит пару на следующий подходящий будний день. Явный отказ от части дня исключает эту часть. Все варианты: 20 минут, будни, не сегодня, starts 09:00–17:00 по Москве.

Обязательный набор:

1. имя;
2. компания;
3. рабочий email;
4. телефон или Telegram;
5. один выбранный structured 20-minute `Europe/Moscow` candidate;
6. server-confirmed consent.

Если пользователь дал несколько полей одной spoken или typed репликой, не переспрашивать их по одному. In-chat form показывается только по server stage `COLLECT_BOOKING`, валидирует четыре пользовательских поля и передаёт их как обычный typed turn; она не вызывает tool и не подтверждает бронь.

### BOOKED

После `create_booking`:

> Всё получила и зафиксировала. Календарная встреча пока не создана: коллега свяжется по указанному контакту. Можно задать два коротких вопроса?

Последнее предложение — точный consent-вопрос current server contract. Формулировку про отсутствие календаря можно сделать менее технической только вместе с изменением server-authored contract/tests; нельзя утверждать, что external event уже создан.

### POST_BOOKING_QUALIFICATION

Только после committed booking, user-facing confirmation и точного consent-вопроса `Можно задать два коротких вопроса?` отдельное явное согласие открывает qualification. Server, а не модель, детерминированно задаёт по одному:

1. `Сколько входящих лидов приходит за месяц?` → `monthlyLeadVolume`;
2. `Сколько менеджеров по продажам работает в вашей команде?` → integer `salesManagerCount`.

В обычном ходе второй вопрос появляется только после первого ответа. Если пользователь сразу сообщает оба значения, сохранить оба и завершить. `complete` разрешён только при обоих полях; отказ без ответов даёт `skipped`, после одного — сохраняет `partial`. Оба поля необязательны для уже committed booking, которая всегда остаётся `booked`. Другие поля расширенной legacy schema не входят в текущий conversational flow.

### COMPLETE

Коротко повторить результат и завершить без нового CTA.

## 4. Lifecycle брони

![Booking lifecycle](../diagrams/04-booking-state.svg)

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
- перед каждым `turn/start` одинаково разбирает typed/spoken preference/rejection и добавляет compact machine-generated context envelope: stage, known facts, booking snapshot, server-owned current Moscow date/day, preference state, ровно два structured/labeled current candidates, allowed actions и финальный текст пользователя;
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

- stage равен `COLLECT_BOOKING` и пользователь согласился;
- известны имя и компания;
- есть валидный рабочий email и телефон или Telegram;
- выбран один из ровно двух candidates активного server context;
- consent подтверждён server-side.

Backend сверяет выбранный `meetingSlot` с обоими active candidates и отклоняет любой non-candidate/stale/occupied slot. Tuple не означает exhaustive availability: preference/rejection refresh заменяет обе текущие альтернативы. Это внутренняя 20-minute бронь без external calendar event, invitation или availability API.

### `append_booking_qualification`

LLM вызывает только после committed `bookingId`, user-facing confirmation и отдельного explicit qualification consent. Server задаёт monthly leads первым и manager count вторым, а status выводит из фактически сохранённых полей, не из заявления модели: one=`partial`, both=`complete`; empty refusal=`skipped`. Текущий flow патчит только `monthlyLeadVolume` и integer `salesManagerCount`; оба значения одной репликой разрешены.

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
6. Агент: называет ровно два server-supplied Moscow candidates.
7. Пользователь: typed form/репликой даёт имя, компанию, рабочий email, Telegram и выбирает первый slot; consent уже подтверждён server context.
8. Backend: валидирует candidate и commit-ит `booking.created` без внешнего календарного события.
9. Server-authored confirmation: подтверждает внутреннюю бронь и точно спрашивает `Можно задать два коротких вопроса?`.
10. Пользователь: явно соглашается; server задаёт вопрос про месячный объём входящих лидов. Пользователь может сразу сообщить и целое число менеджеров продаж, тогда оба поля сохраняются за один turn.
11. Backend: `booking.updated`.
12. Агент: кратко суммирует и завершает.

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
