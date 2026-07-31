#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

image="${1:-}"
backup="${2:-}"
if [ -z "$image" ]; then
  printf '%s\n' "Usage: scripts/rollback.sh IMAGE_TAG [/data/backups/BACKUP.db]" >&2
  exit 64
fi
if [ -n "$backup" ]; then
  case "$backup" in
    /data/backups/*.db) ;;
    *)
      printf '%s\n' "Rollback backup must be under /data/backups and end in .db." >&2
      exit 64
      ;;
  esac
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker pull "$image"
fi

export APP_IMAGE="$image"
app_stopped=false
restart_on_failure() {
  if [ "$app_stopped" = "true" ]; then
    printf '%s\n' "Rollback failed before replacement; restarting the previous app container." >&2
    docker compose start app >/dev/null 2>&1 || true
  fi
}
trap restart_on_failure EXIT
trap 'exit 130' HUP INT TERM

docker compose stop app
app_stopped=true

if [ -n "$backup" ]; then
  docker compose run --rm --no-deps \
    -e AUTO_MIGRATE=false \
    -e BOTAMIN_RESTORE_CONFIRMED=true \
    app bun /app/ops/db.js restore "$backup"
fi

docker compose run --rm --no-deps -e AUTO_MIGRATE=false \
  app bun /app/ops/db.js migrate
docker compose up -d --no-build
app_stopped=false
trap - EXIT HUP INT TERM

health_url="${ROLLBACK_HEALTH_URL:-http://localhost:${HTTP_PORT:-5173}/health/live}"
attempt=0
until curl -fsS "$health_url" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker compose ps >&2
    printf '%s\n' "Rollback image started but health verification failed." >&2
    exit 1
  fi
  sleep 2
done

printf '%s\n' "Rollback is healthy on image $image. Export APP_IMAGE=$image for later Compose invocations."
