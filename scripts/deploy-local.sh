#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 0600 .env
  printf '%s\n' "Created .env from .env.example (provider keys remain blank)." >&2
fi

config_file="$(mktemp)"
trap 'rm -f "$config_file"' EXIT HUP INT TERM
docker compose config > "$config_file"

# A rendered config may name a secret, but must never contain common token values.
if grep -Eq 'Bearer [A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}' "$config_file"; then
  printf '%s\n' "Refusing deploy: rendered Compose config appears to contain a credential." >&2
  exit 1
fi

docker compose build --pull
docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
docker compose up -d

attempt=0
until curl -fsS "${LOCAL_HEALTH_URL:-http://localhost:${HTTP_PORT:-5173}/health/live}" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker compose ps >&2
    docker compose logs --tail=100 app caddy >&2
    printf '%s\n' "Local liveness did not become available." >&2
    exit 1
  fi
  sleep 1
done

docker compose ps
printf '%s\n' "Local HTTP is live at http://localhost:${HTTP_PORT:-5173}."
printf '%s\n' "The paid OpenRouter smoke was not run."
