#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

compose_secret_dir="$(pwd -P)/.runtime/secrets"
owner="$(id -u)"
if [ -L .runtime ] || [ -L .runtime/secrets ] || \
   [ "$(stat -c '%a:%u:%F' "$compose_secret_dir" 2>/dev/null || true)" != "700:$owner:directory" ]; then
  printf '%s\n' "Unsafe or missing deployed Compose secret directory; redeploy before running restore." >&2
  exit 1
fi
for secret_file in openrouter_api_key webhook_url webhook_signing_secret; do
  secret_path="$compose_secret_dir/$secret_file"
  if [ -L "$secret_path" ] || \
     [ "$(stat -c '%a:%u:%h:%F' "$secret_path" 2>/dev/null || true)" != "600:$owner:1:regular file" ]; then
    printf '%s\n' "Missing or unsafe deployed Compose secret files; run scripts/deploy-local.sh or scripts/deploy-production.sh first." >&2
    exit 1
  fi
done
export OPENROUTER_API_KEY_FILE="$compose_secret_dir/openrouter_api_key"
export WEBHOOK_URL_FILE="$compose_secret_dir/webhook_url"
export WEBHOOK_SIGNING_SECRET_FILE="$compose_secret_dir/webhook_signing_secret"

backup="${1:-}"
case "$backup" in
  /data/backups/*.db) ;;
  *)
    printf '%s\n' "Usage: scripts/restore.sh /data/backups/BACKUP.db" >&2
    exit 64
    ;;
esac

# Verify the protected digest and SQLite integrity while the active app is still running.
# The restore command verifies again after stop to close the ordinary TOCTOU window.
docker compose run --rm --no-deps --entrypoint bun app \
  /app/ops/db.js verify-backup "$backup" >/dev/null

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
docker compose run --rm --no-deps --entrypoint bun \
  -e BOTAMIN_RESTORE_CONFIRMED=true \
  app /app/ops/db.js restore "$backup"
docker compose up -d app
app_stopped=false

ready_url="${RESTORE_READY_URL:-http://localhost:${HTTP_PORT:-5173}/health/ready}"
if ! READY_MAX_ATTEMPTS="${RESTORE_READY_MAX_ATTEMPTS:-30}" \
  READY_INTERVAL_SECONDS="${RESTORE_READY_INTERVAL_SECONDS:-2}" \
  scripts/wait-ready.sh "$ready_url"; then
  docker compose ps >&2
  docker compose logs --tail=100 app caddy >&2
  printf '%s\n' "Restore database swap finished, but application readiness failed; restore is not successful." >&2
  exit 1
fi

trap - EXIT HUP INT TERM
printf '%s\n' "Restore completed and application readiness passed. The previous database was retained as a protected pre-restore backup." >&2
