---
SECTION_ID: plans.visual-composition-skill-and-showcase-video
TYPE: note
---

# Plan: visual-composition skill + showcase video

STATUS: in_progress

Goal: добавить скилл `visual_composition` в каталог проекта и снять по нему видеопрезентацию 60–120 сек через `motion_create_skill_showcase_video`.

## Steps

1. [x] Cody: создать `skills/visual_composition/SKILL.md` + `description.md` по спеке `create_skill` (frontmatter, alias = имя папки), тело — предоставленный текст скилла без потерь. DoD: скилл читается через `ToolGetTemplateContent('visual_composition')` и виден в `ToolGetTemplates`. Готово: файлы созданы (SKILL.md 223 строки + description.md), `ToolGetTemplateContent('visual_composition')` возвращает полный контент (main + description). В `ToolGetTemplates('tools: designer')` скилл появится после refresh каталога шаблонов (память грузится при старте; `refresh_templates()` перечитывает `skills/`).
2. [*] Sonic: по `motion_create_skill_showcase_video` собрать ролик 60–120 сек из `skills/visual_composition/SKILL.md`. DoD: MP4 H.264 1080p 16:9 + skill brief + cue sheet, все факты из SKILL.md.
   - BLOCKER: Sonic возвращает `Internal error in RAG` на 4 попытках (2 fresh + 2 resume). Ждём восстановления агента.
3. [ ] Many: принять результат, обновить план, отчитаться PO.

## Notes

- Alias/папка: `visual_composition` (lowercase + underscore, как требует спека).
- Никаких выдуманных фактов о скилле в ролике — только то, что есть в SKILL.md.
