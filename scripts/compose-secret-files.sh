#!/bin/sh
# Validate already-materialized Compose secret sources and export their paths.
# This file is sourced by recovery wrappers after they cd to the repository root.

compose_secret_operation="${compose_secret_operation:-operation}"
compose_secret_dir="$(pwd -P)/.runtime/secrets"
compose_secret_owner="$(id -u)"

for compose_secret_directory in .runtime .runtime/secrets; do
  if [ -L "$compose_secret_directory" ] || [ ! -d "$compose_secret_directory" ] || \
     [ "$(stat -c '%a:%u' "$compose_secret_directory" 2>/dev/null || true)" != "700:$compose_secret_owner" ]; then
    printf '%s\n' "Unsafe or missing deployed Compose secret directory; redeploy before running $compose_secret_operation." >&2
    exit 1
  fi
done

for compose_secret_file in openrouter_api_key webhook_url webhook_signing_secret; do
  compose_secret_path="$compose_secret_dir/$compose_secret_file"
  if [ -L "$compose_secret_path" ] || [ ! -f "$compose_secret_path" ] || \
     [ "$(stat -c '%a:%u:%h' "$compose_secret_path" 2>/dev/null || true)" != "600:$compose_secret_owner:1" ]; then
    printf '%s\n' "Missing or unsafe deployed Compose secret files; run scripts/deploy-local.sh or scripts/deploy-production.sh first." >&2
    exit 1
  fi
done

if [ ! -s "$compose_secret_dir/openrouter_api_key" ] || \
   ! LC_ALL=C grep -q '[^[:space:]]' "$compose_secret_dir/openrouter_api_key"; then
  printf '%s\n' "The deployed OPENROUTER_API_KEY file must be nonblank; redeploy before running $compose_secret_operation." >&2
  exit 1
fi

export OPENROUTER_API_KEY_FILE="$compose_secret_dir/openrouter_api_key"
export WEBHOOK_URL_FILE="$compose_secret_dir/webhook_url"
export WEBHOOK_SIGNING_SECRET_FILE="$compose_secret_dir/webhook_signing_secret"

unset compose_secret_directory compose_secret_file compose_secret_path
unset compose_secret_owner compose_secret_operation
