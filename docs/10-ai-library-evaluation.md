# 10. Выбор AI-библиотеки и transport для Codex/Luna

## 1. Решение

Для P0 не вводится единый универсальный AI SDK в критический realtime-путь.

- **xAI STT/TTS:** тонкие typed WebSocket adapters по официальному streaming protocol.
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
| xAI binary voice WSS | custom adapter всё равно нужен | custom adapter всё равно нужен | custom adapter всё равно нужен | custom adapter всё равно нужен |
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
- есть официальный xAI language provider и общий transcription/realtime API;
- существует community provider для Codex app-server.

Почему не выбран как spine:

- Codex app-server integration является community provider, а не официальным OpenAI provider;
- binary microphone/TTS transport, playback cancellation и generation IDs всё равно остаются custom;
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
- xAI-specific types не импортируются из shared contracts;
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
        ├── XaiSttPort: native streaming WSS
        └── XaiTtsPort: native streaming WSS
```

Это минимизирует latency и magic, сохраняет barge-in, делает booking/qualification проверяемыми и оставляет путь к замене провайдера. Универсальный SDK стоит подключать только после появления конкретной функции, которая окупает дополнительный слой.
