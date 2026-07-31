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

if [ -n "$backup" ]; then
  # Reject a substituted backup before stopping or touching the active database.
  docker compose run --rm --no-deps --entrypoint bun app \
    /app/ops/db.js verify-backup "$backup" >/dev/null
fi

if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker pull "$image"
fi

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
  # Use the current trusted ops image to verify again and perform the DB swap.
  docker compose run --rm --no-deps --entrypoint bun \
    -e BOTAMIN_RESTORE_CONFIRMED=true \
    app /app/ops/db.js restore "$backup"
fi

export APP_IMAGE="$image"
docker compose run --rm --no-deps -e AUTO_MIGRATE=false \
  app bun /app/ops/db.js migrate
docker compose up -d --no-build
app_stopped=false
trap - EXIT HUP INT TERM

health_url="${ROLLBACK_READY_URL:-http://localhost:${HTTP_PORT:-5173}/health/ready}"
if ! READY_MAX_ATTEMPTS="${ROLLBACK_READY_MAX_ATTEMPTS:-30}" \
  READY_INTERVAL_SECONDS="${ROLLBACK_READY_INTERVAL_SECONDS:-2}" \
  scripts/wait-ready.sh "$health_url"; then
  docker compose ps >&2
  docker compose logs --tail=100 app caddy >&2
  printf '%s\n' "Rollback image started but readiness verification failed; rollback is not successful." >&2
  exit 1
fi

printf '%s\n' "Rollback is ready on image $image. Export APP_IMAGE=$image for later Compose invocations."
