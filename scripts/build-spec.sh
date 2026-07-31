#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/FULL_SPEC.md"

cat > "$OUT" <<'HEADER'
---
title: "Botamin Voice Sales Agent — техническая спецификация"
subtitle: "React + Bun + xAI Voice + Codex subscription / GPT-5.6 Luna"
author: "Architecture & delivery handoff"
date: "30 июля 2026"
lang: ru-RU
---

# Botamin Voice Sales Agent — техническая спецификация

**Версия:** 0.2  
**Статус:** основа для передачи агентам-разработчикам  
**Deployment target:** одна trusted VPS, один Docker Compose  
**Runtime split:** xAI Streaming STT/TTS + Codex app-server / `gpt-5.6-luna`

> Ключевой инвариант: внутренняя бронь создаётся до любой опциональной квалификации. После `booking.created` отказ, обрыв или ошибка квалификации не отменяют и не удаляют лид.

## Карта пакета

Эта сводная версия объединяет scope, PRD, исследование Botamin, архитектуру, conversation design, API/data contracts, deployment/security, ADR, тестирование, сравнение AI-библиотек и parallel delivery plan. Machine-readable backlog и отдельные задания агентам находятся в `tasks/`.

<div class="page-break"></div>

HEADER

for file in "$ROOT"/docs/*.md "$ROOT/sources.md"; do
  printf '\n\n<div class="page-break"></div>\n\n' >> "$OUT"
  # Docs live one level below root, so normalize their asset links in the assembled root file.
  sed \
    -e 's#](../diagrams/#](diagrams/#g' \
    -e 's#](../charts/#](charts/#g' \
    -e 's#](../tasks/#](tasks/#g' \
    -e 's#](10-ai-library-evaluation.md)#](docs/10-ai-library-evaluation.md)#g' \
    "$file" >> "$OUT"
done

pandoc "$OUT" \
  --standalone \
  --toc \
  --toc-depth=3 \
  --embed-resources \
  --resource-path="$ROOT" \
  --css="$ROOT/style.css" \
  --metadata title="Botamin Voice Sales Agent — техническая спецификация" \
  -o "$ROOT/technical-spec.html"

printf 'Built %s and %s\n' "$OUT" "$ROOT/technical-spec.html"
