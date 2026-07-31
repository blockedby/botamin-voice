#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

docker compose build app
docker compose run --rm -e AUTO_MIGRATE=false app codex login --device-auth
docker compose run --rm -e AUTO_MIGRATE=false app codex login status
printf '%s\n' "Codex auth is stored only in the persistent CODEX_HOME volume."
