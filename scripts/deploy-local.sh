#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 0600 .env
  printf '%s\n' "Created mode-0600 .env from .env.example; fill OPENROUTER_API_KEY, then retry." >&2
fi

bun scripts/materialize-compose-secrets.ts
compose_secret_dir="$(pwd -P)/.runtime/secrets"
export OPENROUTER_API_KEY_FILE="$compose_secret_dir/openrouter_api_key"
export WEBHOOK_URL_FILE="$compose_secret_dir/webhook_url"
export WEBHOOK_SIGNING_SECRET_FILE="$compose_secret_dir/webhook_signing_secret"

config_file="$(mktemp)"
cleanup() {
  rm -f "$config_file"
}
interrupted() {
  cleanup
  trap - EXIT HUP INT TERM
  exit 130
}
trap cleanup EXIT
trap interrupted HUP INT TERM
docker compose config > "$config_file"

# A rendered config may name a secret, but must never contain common token values.
if grep -Eq 'Bearer [A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}' "$config_file"; then
  printf '%s\n' "Refusing deploy: rendered Compose config appears to contain a credential." >&2
  exit 1
fi

docker compose build --pull
scripts/assert-image-content.sh "${APP_IMAGE:-botamin-voice:local}"

# Never race a live SQLite writer with a schema migration. Protect the current
# database first, then let Compose's 30-second grace period drain/stop the app.
if docker compose ps --status running --services app | grep -qx app; then
  docker compose exec -T app bun /app/ops/db.js backup
  docker compose stop --timeout 30 app
elif docker compose run --rm --no-deps --entrypoint sh app -c '[ -f /data/app.db ]'; then
  # Preserve an existing stopped database too; AUTO_MIGRATE=false prevents this
  # one-off backup container from changing its schema.
  docker compose run --rm --no-deps --entrypoint bun -e AUTO_MIGRATE=false \
    app /app/ops/db.js backup
fi

# Compose does not detect a changed file-secret inode at the same source path.
# Recreate only app unconditionally. Its normal entrypoint applies migrations
# before server startup; readiness proves the migrated application came up.
AUTO_MIGRATE=true docker compose up -d --no-deps --force-recreate app
docker compose up -d caddy

if ! READY_MAX_ATTEMPTS="${LOCAL_READY_MAX_ATTEMPTS:-30}" \
  READY_INTERVAL_SECONDS="${LOCAL_READY_INTERVAL_SECONDS:-1}" \
  scripts/wait-ready.sh "${LOCAL_READY_URL:-http://localhost:${HTTP_PORT:-5173}/health/ready}"; then
  docker compose ps >&2
  docker compose logs --tail=100 app caddy >&2
  printf '%s\n' "Local readiness did not become available." >&2
  exit 1
fi

docker compose exec -T app bun /app/ops/db.js verify-rc4
docker compose ps
printf '%s\n' "Local HTTP is ready at http://localhost:${HTTP_PORT:-5173}."
printf '%s\n' "The paid OpenRouter smoke was not run."
