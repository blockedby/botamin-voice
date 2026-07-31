#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  printf '%s\n' "Missing .env; copy .env.example and configure production values." >&2
  exit 1
fi

# Compose reads app/provider values from .env. Routing/image controls are explicit
# shell environment so .env.example stays identical to the application matrix.
site_address="${SITE_ADDRESS:-}"
app_origin="$(awk -F= '$1 == "APP_ORIGIN" { sub(/^[^=]*=/, ""); print; exit }' .env)"
if [ -z "$site_address" ] || [ "$site_address" = ":80" ]; then
  printf '%s\n' "Export SITE_ADDRESS with the production DNS name." >&2
  exit 1
fi
if [ "$app_origin" != "https://$site_address" ]; then
  printf '%s\n' "APP_ORIGIN must equal https://SITE_ADDRESS for production." >&2
  exit 1
fi

config_file="$(mktemp)"
trap 'rm -f "$config_file"' EXIT HUP INT TERM
docker compose config > "$config_file"
if grep -Eq 'Bearer [A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}' "$config_file"; then
  printf '%s\n' "Refusing deploy: rendered Compose config appears to contain a credential." >&2
  exit 1
fi

docker compose build --pull
if ! docker compose run --rm -e AUTO_MIGRATE=false app codex login status >/dev/null; then
  printf '%s\n' "Codex device auth is absent or invalid. Run scripts/device-auth.sh, then retry." >&2
  exit 1
fi

docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
docker compose up -d

attempt=0
until curl -fsS "https://$site_address/health/ready" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    docker compose ps >&2
    docker compose logs --tail=100 app caddy >&2
    printf '%s\n' "Production readiness failed; deployment remains unhealthy." >&2
    exit 1
  fi
  sleep 2
done

if [ "${RUN_OPENROUTER_SMOKE:-false}" = "true" ]; then
  # This is the only automatic path that may invoke the paid external smoke.
  docker compose run --rm -e AUTO_MIGRATE=false app \
    bun run scripts/openrouter-tts-smoke.ts
else
  printf '%s\n' "OpenRouter paid smoke skipped. Re-run with RUN_OPENROUTER_SMOKE=true after approval." >&2
fi

docker compose ps
