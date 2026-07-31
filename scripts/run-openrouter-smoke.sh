#!/bin/sh
set -eu

kind="${1:-}"
app_root="${BOTAMIN_APP_ROOT:-/app}"
case "$kind" in
  stt) script="$app_root/scripts/openrouter-stt-smoke.ts" ;;
  tts) script="$app_root/scripts/openrouter-tts-smoke.ts" ;;
  *)
    printf '%s\n' "Usage: run-openrouter-smoke.sh stt|tts" >&2
    exit 64
    ;;
esac

if [ ! -f "$script" ]; then
  printf '%s\n' "OpenRouter $kind smoke integration is missing from this image; integrate the A2 provider smoke entrypoint before paid smoke." >&2
  exit 69
fi

# This command is intentionally paid and opt-in. Never print provider secrets.
exec bun run "$script"
