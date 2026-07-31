#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
image="${1:-${APP_IMAGE:-botamin-voice:local}}"

config_file="$(mktemp)"
history_file="$(mktemp)"
trap 'rm -f "$config_file" "$history_file"' EXIT HUP INT TERM

docker image inspect --format '{{json .Config.Env}}' "$image" > "$config_file"
docker history --no-trunc --format '{{.CreatedBy}}' "$image" > "$history_file"

retired_root="X""AI"
retired_key="${retired_root}_API_KEY"
retired_prefix="${retired_root}_STT_"
if grep -Eq "(^|[=[:space:]])(OPENROUTER_API_KEY|${retired_key})=" "$config_file" "$history_file"; then
  printf '%s\n' "Image config/history contains a provider credential assignment." >&2
  exit 1
fi
if grep -Eq "${retired_key}|${retired_prefix}" "$config_file" "$history_file"; then
  printf '%s\n' "Image config/history contains a retired voice-provider namespace." >&2
  exit 1
fi

docker run --rm --entrypoint sh "$image" -eu -c '
  test -f /app/apps/server/dist/index.js
  test -f /app/ops/db.js
  test -x /app/scripts/run-openrouter-smoke.sh
  test -x /app/scripts/wait-ready.sh
  test -x /usr/local/bin/botamin-entrypoint
  test ! -e /run/secrets/openrouter_api_key
  test ! -e /codex-home/auth.json
'

for kind in stt tts; do
  source_path="scripts/openrouter-${kind}-smoke.ts"
  image_path="/app/$source_path"
  if [ -f "$source_path" ]; then
    docker run --rm --entrypoint sh "$image" -eu -c 'test -r "$1"' sh "$image_path"
  else
    if docker run --rm --entrypoint sh "$image" -eu -c 'test -e "$1"' sh "$image_path"; then
      printf '%s\n' "Image unexpectedly contains $image_path while the source integration is absent." >&2
      exit 1
    fi
    printf '%s\n' "OpenRouter $kind provider smoke source is not integrated yet; deploy smoke will fail explicitly." >&2
  fi
done

printf '%s\n' "Image content, config, and history assertions passed for $image."
