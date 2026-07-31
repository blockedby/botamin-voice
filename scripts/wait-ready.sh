#!/bin/sh
set -eu

url="${1:-}"
if [ -z "$url" ]; then
  printf '%s\n' "Usage: scripts/wait-ready.sh READY_URL" >&2
  exit 64
fi

attempts="${READY_MAX_ATTEMPTS:-30}"
interval="${READY_INTERVAL_SECONDS:-2}"
request_timeout="${READY_REQUEST_TIMEOUT_SECONDS:-3}"
for value in "$attempts" "$interval" "$request_timeout"; do
  case "$value" in
    ''|*[!0-9]*)
      printf '%s\n' "Readiness bounds must be non-negative integers." >&2
      exit 64
      ;;
  esac
done
if [ "$attempts" -lt 1 ] || [ "$request_timeout" -lt 1 ]; then
  printf '%s\n' "Readiness attempts and request timeout must be at least 1." >&2
  exit 64
fi

attempt=1
while [ "$attempt" -le "$attempts" ]; do
  if curl --fail --silent --show-error --max-time "$request_timeout" "$url" >/dev/null; then
    exit 0
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    sleep "$interval"
  fi
  attempt=$((attempt + 1))
done

printf '%s\n' "Readiness did not become available after $attempts bounded attempts." >&2
exit 1
