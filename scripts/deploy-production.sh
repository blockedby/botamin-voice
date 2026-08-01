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
if grep -Eq 'Bearer [A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}' "$config_file"; then
  printf '%s\n' "Refusing deploy: rendered Compose config appears to contain a credential." >&2
  exit 1
fi

docker compose build --pull
scripts/assert-image-content.sh "${APP_IMAGE:-botamin-voice:local}"
if ! docker compose run --rm -e AUTO_MIGRATE=false app codex login status >/dev/null; then
  printf '%s\n' "Codex device auth is absent or invalid. Run scripts/device-auth.sh, then retry." >&2
  exit 1
fi

docker compose run --rm -e AUTO_MIGRATE=false app bun /app/ops/db.js migrate
docker compose up -d

if ! READY_MAX_ATTEMPTS=60 READY_INTERVAL_SECONDS=2 \
  scripts/wait-ready.sh "https://$site_address/health/ready"; then
  docker compose ps >&2
  docker compose logs --tail=100 app caddy >&2
  printf '%s\n' "Production readiness failed; deployment remains unhealthy." >&2
  exit 1
fi

run_paid_smoke() {
  kind="$1"
  label="$2"
  flag="$3"
  case "$flag" in
    true)
      # The image guard emits an explicit integration failure before Bun execution.
      docker compose run --rm -e AUTO_MIGRATE=false app \
        /app/scripts/run-openrouter-smoke.sh "$kind"
      ;;
    false)
      printf '%s\n' "OpenRouter $label paid smoke skipped; set RUN_OPENROUTER_${label}_SMOKE=true only after approval." >&2
      ;;
    *)
      printf '%s\n' "RUN_OPENROUTER_${label}_SMOKE must be true or false." >&2
      exit 64
      ;;
  esac
}

run_paid_smoke stt STT "${RUN_OPENROUTER_STT_SMOKE:-false}"
run_paid_smoke tts TTS "${RUN_OPENROUTER_TTS_SMOKE:-false}"

docker compose ps
