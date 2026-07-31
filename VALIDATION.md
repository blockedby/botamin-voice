# Validation report

**Дата:** 30 июля 2026  
**Результат:** passed

Пакет проверен перед передачей агентам:

- локальные Markdown-ссылки разрешаются;
- task graph не содержит циклов и неизвестных dependencies;
- все merge gates ссылаются на существующие задачи;
- SVG корректно парсятся;
- standalone HTML содержит встроенные схемы и графики;
- обязательные booking/Luna/qualification contracts присутствуют;
- базовый secret scan не обнаружил ключей или auth tokens.

```text
VALIDATION NOTES
- 15 tasks; dependency graph is acyclic
- 8 agent packets
- 7 SVG diagrams
- 3 PNG charts
- HTML embeds 3 raster images and 7 inline SVGs
- 37 Markdown files

ALL VALIDATIONS PASSED
```

Воспроизведение:

```bash
./scripts/build-spec.sh
python ./scripts/validate-spec.py
```
