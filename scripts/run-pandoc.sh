#!/usr/bin/env bash
set -euo pipefail

PANDOC_VERSION="3.10.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v pandoc >/dev/null 2>&1 && [[ "$(pandoc --version | head -n 1)" == "pandoc $PANDOC_VERSION" ]]; then
  exec pandoc "$@"
fi

if command -v docker >/dev/null 2>&1; then
  exec docker run --rm \
    --user "$(id -u):$(id -g)" \
    --volume "$ROOT:$ROOT" \
    --workdir "$ROOT" \
    "pandoc/core:$PANDOC_VERSION" "$@"
fi

printf 'Pandoc %s is required (local binary or Docker).\n' "$PANDOC_VERSION" >&2
exit 1
