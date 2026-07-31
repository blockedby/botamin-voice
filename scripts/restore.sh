#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

backup="${1:-}"
case "$backup" in
  /data/backups/*.db) ;;
  *)
    printf '%s\n' "Usage: scripts/restore.sh /data/backups/BACKUP.db" >&2
    exit 64
    ;;
esac

app_stopped=false
restart_on_failure() {
  if [ "$app_stopped" = "true" ]; then
    printf '%s\n' "Restore failed; restarting the previous app container." >&2
    docker compose start app >/dev/null 2>&1 || true
  fi
}
trap restart_on_failure EXIT
trap 'exit 130' HUP INT TERM

printf '%s\n' "Stopping the app before the atomic restore..." >&2
docker compose stop app
app_stopped=true
docker compose run --rm \
  -e AUTO_MIGRATE=false \
  -e BOTAMIN_RESTORE_CONFIRMED=true \
  app bun /app/ops/db.js restore "$backup"
docker compose up -d app
app_stopped=false
trap - EXIT HUP INT TERM

printf '%s\n' "Restore completed. The previous database was retained as a pre-restore backup." >&2
