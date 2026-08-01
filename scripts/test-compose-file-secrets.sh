#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

image="${COMPOSE_SECRET_SMOKE_IMAGE:-botamin-voice:local}"
temporary_directory="$(mktemp -d)"
project="botamin-file-secret-smoke-$$"
cleanup() {
  docker compose -p "$project" -f "$temporary_directory/compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM
chmod 0700 "$temporary_directory"
printf '%s' 'compose-file-source-smoke' > "$temporary_directory/probe"
chmod 0600 "$temporary_directory/probe"

cat > "$temporary_directory/compose.yml" <<EOF
services:
  app:
    image: $image
    user: "$(id -u):$(id -g)"
    read_only: true
    entrypoint: ["/bin/sh", "-c"]
    command: ["test -s /run/secrets/probe && sleep 30"]
    secrets:
      - probe
secrets:
  probe:
    file: ./probe
EOF

docker compose -p "$project" -f "$temporary_directory/compose.yml" config > "$temporary_directory/rendered.yml"
if grep -Fq 'compose-file-source-smoke' "$temporary_directory/rendered.yml"; then
  printf '%s\n' "Rendered Compose config leaked the probe value." >&2
  exit 1
fi
docker compose -p "$project" -f "$temporary_directory/compose.yml" up -d --pull never
sleep 1
test "$(docker compose -p "$project" -f "$temporary_directory/compose.yml" ps --status running --services)" = "app"
printf '%s\n' "Compose mounted a file-backed secret into a running read-only service."
