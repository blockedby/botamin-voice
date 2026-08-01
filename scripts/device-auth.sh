#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

# Device auth does not use provider/webhook credentials and remains available
# before .env is configured.
export OPENROUTER_API_KEY_FILE=/dev/null
export WEBHOOK_URL_FILE=/dev/null
export WEBHOOK_SIGNING_SECRET_FILE=/dev/null

docker compose build app
docker compose run --rm -e AUTO_MIGRATE=false app codex login --device-auth
docker compose run --rm -e AUTO_MIGRATE=false app codex login status
printf '%s\n' "Codex auth is stored only in the persistent CODEX_HOME volume."
