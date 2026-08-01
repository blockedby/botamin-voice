# 00. Scope, допущения и терминология

## 1. Цель MVP

Продемонстрировать работающий вертикальный срез AI-продавца Botamin:

> посетитель открывает лендинг, начинает голосовой или печатный разговор, получает релевантную презентацию продукта, отвечает максимум на два discovery-вопроса до мягкого предложения следующего шага, выбирает один из двух внутренних слотов и передаёт обязательные booking-данные, после чего backend фиксирует бронь и опционально обогащает её ограниченной квалификацией.

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
- phrase-level STT на русском: chunked PCM16 до backend, максимум 60 секунд на реплику и 2,000,000 bytes на WAV request после `audio.commit`, final transcript only;
- provider-neutral final typed turns через `visitor.text.submit`, семантически равнозначные spoken turns;
- sample-derived circular countdown для активной записи;
- текстовое рассуждение и ответ через GPT-5.6 Luna в Codex;
- phrase-level TTS через полные MP3-сегменты, запускаемый до завершения полного ответа;
- interruption/barge-in на базовом уровне;
- управляемая state machine разговора;
- product knowledge из Botamin-сайта и Telegram-кейсов;
- создание внутренней брони на одном из двух server-supplied structured 20-minute Moscow slots;
- необязательная квалификация после брони и отдельного согласия, только по monthly inbound leads и integer sales-manager count;
- SQLite persistence;
- console notifier и интерфейс для webhook/push;
- transcript/event audit;
- local-first Docker Compose, health checks and backup; VPS TLS/WSS is a later deployment gate;
- тесты контрактов, компонентов, E2E и conversation evals.

## 4. Вне scope

- визуальный conversation builder;
- prompt CMS, роли и авторизация редакторов;
- реальный Google Calendar, Calendly или CRM;
- внешняя проверка календарной доступности; внутренний scheduler только исключает уже committed start times;
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
| Deployment | local-first Compose project on one trusted machine; app + Caddy only. One target VPS with TLS/WSS is the later production-shaped gate |
| Raw audio retention | выключено |
| Utterance bounds | 60 секунд; WAV cap 2,000,000 bytes; countdown по принятым PCM16 samples и stricter server ceiling |
| Typed input | финальный `visitor.text.submit`, тот же semantic turn pipeline, что и speech |
| Booking | имя, компания, рабочий email, телефон или Telegram, consent и один из ровно двух server-supplied 20-minute `Europe/Moscow` slots |
| Qualification | включаемая опция, только после committed booking, confirmation и consent; monthly inbound leads + integer `salesManagerCount` |

## 6. Допущения, которые агенты не должны превращать в блокеры

- Для новой брони обязательны имя, компания, рабочий email, телефон или Telegram, consent и выбранный server-supplied slot.
- Backend владеет текущей московской датой/днём и выдаёт ровно два структурированных кандидата: будни, не сегодня, 20 минут, старты по сетке с 09:00 до 17:00 `Europe/Moscow`. Это внутреннее резервирование без внешнего календаря или availability API.
- Логотипы, точная типографика и brand book могут быть заменены аккуратным нейтральным стилем.
- Console output является достаточным handoff для P0.
- Если subscription auth временно недоступен, сервис показывает понятный degraded state; автоматический переход на платный API не включается без конфигурации.
- Числовые кейсы на лендинге используются только с подписью источника и без обещания повторить результат.

## 7. Термины

- **Conversation** — одна пользовательская voice/typed сессия.
- **Turn** — одна завершённая spoken или typed реплика пользователя и следующий ответ агента.
- **Booking** — внутренняя запись о согласованном следующем шаге, не календарное событие.
- **Qualification** — необязательные сведения, добавляемые к уже существующей брони.
- **BrainPort** — внутренний интерфейс текстового LLM-мозга.
- **VoicePort** — provider-neutral внутренние `SttPort` и `TtsPort`: один STT request принимает bounded `audio/wav` и возвращает один final transcript; один TTS request возвращает один полный `audio/mpeg` phrase segment.
- **Barge-in** — пользователь начинает говорить во время ответа агента.
- **Tool** — строго валидируемая backend-операция с доменным эффектом.
- **Luna** — модель `gpt-5.6-luna`, доступная через Codex.
