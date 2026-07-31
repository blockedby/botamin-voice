#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

destination="${1:-}"
if [ -n "$destination" ]; then
  case "$destination" in
    /data/backups/*) ;;
    *)
      printf '%s\n' "Container backup path must be under /data/backups." >&2
      exit 64
      ;;
  esac
  docker compose exec -T app bun /app/ops/db.js backup "$destination"
else
  docker compose exec -T app bun /app/ops/db.js backup
fi
