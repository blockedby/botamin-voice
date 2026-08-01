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
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
# Compose does not detect a changed file-secret inode at the same source path.
# Recreate only app unconditionally, then let Compose start/update Caddy if needed.
docker compose up -d --no-deps --force-recreate app
docker compose up -d caddy

if ! READY_MAX_ATTEMPTS="${LOCAL_READY_MAX_ATTEMPTS:-30}" \
  READY_INTERVAL_SECONDS="${LOCAL_READY_INTERVAL_SECONDS:-1}" \
  scripts/wait-ready.sh "${LOCAL_READY_URL:-http://localhost:${HTTP_PORT:-5173}/health/ready}"; then
  docker compose ps >&2
  docker compose logs --tail=100 app caddy >&2
  printf '%s\n' "Local readiness did not become available." >&2
  exit 1
fi

docker compose ps
printf '%s\n' "Local HTTP is ready at http://localhost:${HTTP_PORT:-5173}."
printf '%s\n' "The paid OpenRouter smoke was not run."
