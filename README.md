# Botamin Voice Sales Agent — техническая спецификация

> **AI agents:** unpack the archive and begin with [`AGENT_START_HERE.md`](AGENT_START_HERE.md).


**Версия:** 0.2  
**Дата:** 30 июля 2026  
**Статус:** согласованная основа для передачи агентам-разработчикам

## Одним абзацем

Нужно сделать full-stack сайт Botamin с браузерным голосовым AI-продавцом. Пользователь говорит в микрофон, xAI Streaming STT превращает речь в текст, Codex app-server с моделью `gpt-5.6-luna` формирует решение и реплику, xAI Streaming TTS озвучивает ответ. Агент продаёт конкретный продукт Botamin, обрабатывает вопросы и возражения, **сначала** создаёт внутреннюю бронь через backend-tool, а **затем опционально** дополняет эту же бронь квалификацией. Реальный календарь или CRM не подключаются. Промпты и knowledge base хранятся в Markdown и компилируются в изолированный runtime `AGENTS.md`. Всё поднимается одним `docker compose` на одной дешёвой VPS.

## Локальная настройка доступов

```bash
cp .env.example .env
```

1. **xAI:** создайте аккаунт и API key по [официальному quickstart](https://docs.x.ai/developers/quickstart), при необходимости пополните баланс, затем запишите ключ в `.env` как `XAI_API_KEY=...`.
2. **Codex subscription:** выполните вход через ChatGPT, без OpenAI API key:

   ```bash
   export CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/botamin-voice/codex-home"
   mkdir -p "$CODEX_HOME"
   codex login --device-auth
   codex login status
   ```

Укажите этот абсолютный `CODEX_HOME` в `.env`. Для локальной версии `NOTIFIER=console`; webhook-поля можно оставить пустыми. Не коммитьте `.env` или Codex credentials.

## Неподвижные инварианты

1. `booking.created` происходит до постквалификации.
2. После создания брони отказ, обрыв связи или ошибка квалификации не отменяют бронь.
3. Повторный `create_booking` возвращает ту же бронь, а не создаёт дубль.
4. Ключи xAI и Codex credentials никогда не попадают в браузер.
5. В production не хранится сырое аудио, если это отдельно не включено.
6. Агент не утверждает, что встреча добавлена в календарь: в MVP календарной интеграции нет.
7. Онлайн-редактор сценариев и промптов отсутствует.
8. Основной LLM-мозг — Codex subscription + GPT-5.6 Luna; xAI используется для STT/TTS.
9. Voice ID и стоимость TTS не зашиты в логику: `iris`/`eve` сравниваются smoke-test, а предполагаемый бесплатный allowance проверяется на аккаунте.
10. Универсальный AI SDK не является частью критического realtime-path: brain и voice скрыты за собственными ports; P0 Codex transport — direct app-server JSON-RPC.

## С чего начинать агентам

1. [`docs/00-scope-and-assumptions.md`](docs/00-scope-and-assumptions.md) — границы.
2. [`docs/03-system-architecture.md`](docs/03-system-architecture.md) — архитектура и интерфейсы.
3. [`docs/05-api-events-data.md`](docs/05-api-events-data.md) — контракты.
4. [`docs/10-ai-library-evaluation.md`](docs/10-ai-library-evaluation.md) — почему выбран direct app-server transport, а не универсальный AI SDK.
5. [`docs/09-agent-task-plan.md`](docs/09-agent-task-plan.md) и [`tasks/tasks.yaml`](tasks/tasks.yaml) — параллельный план.
6. [`docs/08-testing-and-acceptance.md`](docs/08-testing-and-acceptance.md) — Definition of Done.

## Состав пакета

| Файл | Назначение |
|---|---|
| `docs/01-product-requirements.md` | продуктовые и нефункциональные требования |
| `docs/02-botamin-research-and-funnel.md` | отдельное исследование Botamin и воронка |
| `docs/03-system-architecture.md` | компоненты, voice pipeline, Codex/Luna |
| `docs/04-conversation-design.md` | сценарий разговора, prompts, guardrails |
| `docs/05-api-events-data.md` | REST/WS events, tools, схема данных |
| `docs/06-deployment-security-operations.md` | Docker, VPS, auth, security, runbook |
| `docs/07-tradeoffs-and-adrs.md` | принятые trade-offs и риски |
| `docs/08-testing-and-acceptance.md` | тесты, evals и release gates |
| `docs/09-agent-task-plan.md` | задачи, зависимости и merge-порядок |
| `docs/10-ai-library-evaluation.md` | сравнение Codex SDK, app-server, Vercel AI SDK и orchestration frameworks |
| `tasks/agents/*.md` | готовые задания отдельным агентам |
| `starter/prompts/*.md` | стартовые prompt-файлы |
| `diagrams/*.svg` | схемы архитектуры и state machines |
| `charts/*.png` | latency, стоимость и параллелизация |
| `FULL_SPEC.md` / `technical-spec.html` | собранная спецификация |
| `VALIDATION.md` | отчёт о проверке ссылок, task graph, схем и standalone HTML |
| `scripts/build-spec.sh` / `scripts/validate-spec.py` | воспроизводимая сборка и валидация пакета |

## Ограничение исходника

Страница Notion `uprosti.notion.site/conversation-designer` на момент подготовки возвращала ошибку, поэтому пакет основан на согласованной с заказчиком трактовке в текущем диалоге, а не на дословном экспорте Notion. Это ограничение не блокирует разработку, но при появлении экспорта стоит сделать короткий gap review.
