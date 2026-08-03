#!/bin/sh
set -eu

umask 077

log() {
  printf '%s\n' "botamin-entrypoint: $*" >&2
}

load_secret() {
  variable="$1"
  path="$2"
  if [ -r "$path" ]; then
    value="$(cat "$path")"
    if [ -n "$value" ]; then
      export "$variable=$value"
    else
      unset "$variable" 2>/dev/null || true
    fi
  fi
}

require_uint() {
  variable="$1"
  minimum="$2"
  maximum="$3"
  eval "value=\${$variable:-}"
  case "$value" in
    ''|*[!0-9]*)
      log "$variable must be an integer between $minimum and $maximum"
      exit 64
      ;;
  esac
  if [ "$value" -lt "$minimum" ] || [ "$value" -gt "$maximum" ]; then
    log "$variable must be between $minimum and $maximum"
    exit 64
  fi
}

load_secret OPENROUTER_API_KEY /run/secrets/openrouter_api_key
load_secret WEBHOOK_SIGNING_SECRET /run/secrets/webhook_signing_secret
load_secret WEBHOOK_URL /run/secrets/webhook_url

require_uint CODEX_MAX_CONCURRENT_TURNS 1 32
require_uint MAX_ACTIVE_CONVERSATIONS 1 100
require_uint MAX_ACTIVE_CONVERSATIONS_PER_SOURCE 1 100
require_uint MAX_CONCURRENT_BRAIN_TURNS 1 32
require_uint MAX_PENDING_BRAIN_TURNS 0 256
require_uint BRAIN_QUEUE_TIMEOUT_MS 250 300000
require_uint SESSION_MAX_MINUTES 1 120
require_uint SESSION_STOP_DRAIN_MS 100 30000
require_uint TRUSTED_PROXY_HOPS 0 3
require_uint ADMISSION_WINDOW_MS 1000 600000
require_uint MAX_CONVERSATION_CREATES_PER_SOURCE 1 1000
require_uint MAX_SESSION_CONNECTIONS_PER_SOURCE 1 2000
require_uint CLIENT_HELLO_TIMEOUT_MS 250 5000
require_uint ABANDONED_SESSION_TIMEOUT_MS 1000 60000
require_uint TRANSCRIPT_RETENTION_DAYS 1 3650
require_uint WEBHOOK_TIMEOUT_MS 100 30000
require_uint STT_CONNECT_TIMEOUT_MS 100 60000
require_uint STT_TOTAL_TIMEOUT_MS 100 120000
require_uint STT_MAX_RETRIES 0 1
require_uint STT_RETRY_BASE_MS 0 10000
require_uint STT_MAX_UTTERANCE_MS 100 120000
require_uint STT_MAX_AUDIO_BYTES 3244 10000000
require_uint TTS_MAX_CONCURRENCY 1 16
require_uint TTS_PREFETCH_SEGMENTS 0 4
require_uint TTS_MAX_CHARS_PER_SEGMENT 1 1000
require_uint TTS_MAX_CHARS_PER_TURN 1 20000
require_uint TTS_MAX_CHARS_PER_SESSION 1 100000
require_uint TURN_TIMEOUT_MS 1000 300000

if [ "$MAX_ACTIVE_CONVERSATIONS_PER_SOURCE" -gt "$MAX_ACTIVE_CONVERSATIONS" ]; then
  log "MAX_ACTIVE_CONVERSATIONS_PER_SOURCE cannot exceed MAX_ACTIVE_CONVERSATIONS"
  exit 64
fi
if [ "$CLIENT_HELLO_TIMEOUT_MS" -gt "$ABANDONED_SESSION_TIMEOUT_MS" ]; then
  log "CLIENT_HELLO_TIMEOUT_MS cannot exceed ABANDONED_SESSION_TIMEOUT_MS"
  exit 64
fi
if [ "$MAX_CONCURRENT_BRAIN_TURNS" -gt "$MAX_ACTIVE_CONVERSATIONS" ]; then
  log "MAX_CONCURRENT_BRAIN_TURNS cannot exceed MAX_ACTIVE_CONVERSATIONS"
  exit 64
fi
if [ "$CODEX_MAX_CONCURRENT_TURNS" -ne "$MAX_CONCURRENT_BRAIN_TURNS" ]; then
  log "CODEX_MAX_CONCURRENT_TURNS must equal MAX_CONCURRENT_BRAIN_TURNS"
  exit 64
fi
if [ "$TTS_MAX_CHARS_PER_SEGMENT" -gt "$TTS_MAX_CHARS_PER_TURN" ] || \
   [ "$TTS_MAX_CHARS_PER_TURN" -gt "$TTS_MAX_CHARS_PER_SESSION" ]; then
  log "TTS character guards must satisfy segment <= turn <= session"
  exit 64
fi
if [ "$STT_CONNECT_TIMEOUT_MS" -gt "$STT_TOTAL_TIMEOUT_MS" ]; then
  log "STT_CONNECT_TIMEOUT_MS cannot exceed STT_TOTAL_TIMEOUT_MS"
  exit 64
fi

case "${AUTO_MIGRATE:-}" in
  true|false) ;;
  *)
    log "AUTO_MIGRATE must be true or false"
    exit 64
    ;;
esac
case "${CODEX_TOOL_MODE:-}" in
  envelope) ;;
  *)
    log "CODEX_TOOL_MODE must be envelope in the production runtime"
    exit 64
    ;;
esac
case "${STT_TEXT_ONLY_INPUT_FALLBACK:-}" in
  true|false) ;;
  *)
    log "STT_TEXT_ONLY_INPUT_FALLBACK must be true or false"
    exit 64
    ;;
esac
case "${TTS_TEXT_ONLY_FALLBACK:-}" in
  true|false) ;;
  *)
    log "TTS_TEXT_ONLY_FALLBACK must be true or false"
    exit 64
    ;;
esac
case "${NOTIFIER:-}" in
  console) ;;
  webhook)
    if [ -z "${WEBHOOK_URL:-}" ] || [ -z "${WEBHOOK_SIGNING_SECRET:-}" ]; then
      log "WEBHOOK_URL and WEBHOOK_SIGNING_SECRET are required for NOTIFIER=webhook"
      exit 64
    fi
    ;;
  *)
    log "NOTIFIER must be console or webhook"
    exit 64
    ;;
esac

if [ "${STT_PROVIDER:-}" != "openrouter" ] || [ "${TTS_PROVIDER:-}" != "openrouter" ]; then
  log "STT_PROVIDER and TTS_PROVIDER must both be openrouter; no second voice provider is supported"
  exit 64
fi
if [ "${OPENROUTER_STT_AUDIO_FORMAT:-}" != "wav" ]; then
  log "OPENROUTER_STT_AUDIO_FORMAT must be wav"
  exit 64
fi
if [ -z "${OPENROUTER_STT_MODEL:-}" ] || [ -z "${OPENROUTER_STT_LANGUAGE:-}" ]; then
  log "OpenRouter STT model and language must be configured"
  exit 64
fi
case "${OPENROUTER_TTS_PROFILE:-xai_mp3}" in
  xai_mp3)
    if [ "${OPENROUTER_TTS_MODEL:-x-ai/grok-voice-tts-1.0}" != "x-ai/grok-voice-tts-1.0" ] || \
       [ "${OPENROUTER_TTS_VOICE:-eve}" != "eve" ] || \
       [ "${OPENROUTER_TTS_RESPONSE_FORMAT:-mp3}" != "mp3" ]; then
      log "OPENROUTER_TTS_PROFILE=xai_mp3 requires the exact xAI model, eve voice, and mp3 format"
      exit 64
    fi
    ;;
  gemini_3_1_pcm)
    if [ "${OPENROUTER_TTS_MODEL:-}" != "google/gemini-3.1-flash-tts-preview" ] || \
       [ "${OPENROUTER_TTS_RESPONSE_FORMAT:-}" != "pcm" ] || \
       [ -n "${OPENROUTER_TTS_SPEED:-}" ]; then
      log "OPENROUTER_TTS_PROFILE=gemini_3_1_pcm requires the exact Gemini model, pcm format, and no speed override"
      exit 64
    fi
    case "${OPENROUTER_TTS_VOICE:-}" in
      Zephyr|Puck|Charon|Kore|Fenrir|Leda|Orus|Aoede|Callirrhoe|Autonoe|Enceladus|Iapetus|Umbriel|Algieba|Despina|Erinome|Algenib|Rasalgethi|Laomedeia|Achernar|Alnilam|Schedar|Gacrux|Pulcherrima|Achird|Zubenelgenubi|Vindemiatrix|Sadachbia|Sadaltager|Sulafat) ;;
      *)
        log "OPENROUTER_TTS_VOICE is outside the case-sensitive Gemini release snapshot"
        exit 64
        ;;
    esac
    ;;
  *)
    log "OPENROUTER_TTS_PROFILE must be xai_mp3 or gemini_3_1_pcm"
    exit 64
    ;;
esac
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  if [ "$TTS_TEXT_ONLY_FALLBACK" = "true" ]; then
    log "OpenRouter key is absent; voice is degraded, STT does not substitute typed input, and TTS uses text-only output fallback"
  else
    log "OpenRouter key is required when text-only output fallback is disabled"
    exit 78
  fi
fi

for directory in /data /data/backups /codex-home /app/runtime; do
  if [ ! -d "$directory" ] || [ ! -w "$directory" ]; then
    log "$directory must exist and be writable by uid $(id -u)"
    exit 73
  fi
done
chmod 0700 /data /data/backups /codex-home

runtime_dir="${PROMPT_RUNTIME_DIR:-/app/runtime/brain}"
source_root="${PROMPT_SOURCE_ROOT:-/app/prompt-source}"
rm -rf "$runtime_dir"
metadata="$(bun /app/prompt-compiler/cli.js \
  --source-root "$source_root" \
  --runtime-dir "$runtime_dir")"
printf '%s\n' "$metadata" > /tmp/prompt-bundle.json

if [ "$(find "$runtime_dir" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -ne 1 ] || \
   [ ! -f "$runtime_dir/AGENTS.md" ] || \
   [ -L "$runtime_dir/AGENTS.md" ]; then
  log "runtime brain must contain only a regular AGENTS.md"
  exit 70
fi
if ! cmp -s "$runtime_dir/AGENTS.md" /app/runtime-brain-image/AGENTS.md; then
  log "runtime prompt bundle differs from the image build artifact"
  exit 70
fi
log "prompt bundle compiled and verified before startup"

if [ "${AUTO_MIGRATE:-true}" = "true" ]; then
  bun /app/ops/db.js migrate
fi

exec "$@"
