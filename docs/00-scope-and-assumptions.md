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
- local-first Docker Compose, health checks and backup; VPS TLS/WSS is a later deployment gate;
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
| Deployment | local-first Compose project on one trusted machine; app + Caddy only. One target VPS with TLS/WSS is the later production-shaped gate |
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
