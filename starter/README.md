# Starter prompt bundle

Это не финальный production prompt, а начальная структура для T01/T20.

1. Скопировать `prompts/` и `knowledge/` в корень рабочего repository.
2. Зафиксировать порядок сборки и обязательные headings в prompt compiler.
3. Компилировать bundle в isolated `/app/runtime-brain/AGENTS.md`.
4. Копировать в runtime directory только allowlisted knowledge; не монтировать туда source repository, `.env` или database.
5. Вычислять SHA-256 `promptVersion`; сохранять его в conversation record.
6. Числовые case claims проверять по источникам перед релизом.
