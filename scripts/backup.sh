#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

compose_secret_dir="$(pwd -P)/.runtime/secrets"
owner="$(id -u)"
if [ -L .runtime ] || [ -L .runtime/secrets ] || \
   [ "$(stat -c '%a:%u:%F' "$compose_secret_dir" 2>/dev/null || true)" != "700:$owner:directory" ]; then
  printf '%s\n' "Unsafe or missing deployed Compose secret directory; redeploy before running backup." >&2
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

destination="${1:-}"
if [ -n "$destination" ]; then
  case "$destination" in
    /data/backups/*) ;;
    *)
      printf '%s\n' "Container backup path must be under /data/backups." >&2
      exit 64
      ;;
  esac
  docker compose exec -T app bun /app/ops/db.js backup "$destination"
else
  docker compose exec -T app bun /app/ops/db.js backup
fi
