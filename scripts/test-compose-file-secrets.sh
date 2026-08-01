#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

image="${COMPOSE_SECRET_SMOKE_IMAGE:-botamin-voice:local}"
temporary_directory="$(mktemp -d)"
project="botamin-file-secret-smoke-$$"
first_value="compose-secret-rotation-first-$$"
second_value="compose-secret-rotation-second-$$"
command_output="$temporary_directory/compose-output.log"
cleanup() {
  docker compose -p "$project" -f "$temporary_directory/compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM
chmod 0700 "$temporary_directory"
mkdir "$temporary_directory/state"
chmod 0700 "$temporary_directory/state"
printf '%s' "$first_value" > "$temporary_directory/probe"
chmod 0600 "$temporary_directory/probe"
first_source_inode="$(stat -c '%i' "$temporary_directory/probe")"

cat > "$temporary_directory/compose.yml" <<EOF
services:
  app:
    image: $image
    user: "$(id -u):$(id -g)"
    read_only: true
    entrypoint: ["/bin/sh", "-c"]
    command:
      - "cp /run/secrets/probe /state/mounted && stat -c %i /run/secrets/probe > /state/mounted-inode && sleep 30"
    volumes:
      - ./state:/state
    secrets:
      - probe
secrets:
  probe:
    file: ./probe
EOF

wait_for_mount() {
  attempt=0
  until [ -f "$temporary_directory/state/mounted" ] && [ -f "$temporary_directory/state/mounted-inode" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      printf '%s\n' "Disposable Compose service did not mount its secret in time." >&2
      exit 1
    fi
    sleep 1
  done
}

# This is the same up shape used by deployment wrappers: app alone is forcibly
# recreated so a changed source inode is remounted, without forcing dependents.
docker compose -p "$project" -f "$temporary_directory/compose.yml" config > "$temporary_directory/rendered.yml"
docker compose -p "$project" -f "$temporary_directory/compose.yml" up -d --pull never --no-deps --force-recreate app >"$command_output" 2>&1
wait_for_mount
cmp -s "$temporary_directory/probe" "$temporary_directory/state/mounted"
first_mounted_inode="$(cat "$temporary_directory/state/mounted-inode")"

printf '%s' "$second_value" > "$temporary_directory/probe.next"
chmod 0600 "$temporary_directory/probe.next"
mv "$temporary_directory/probe.next" "$temporary_directory/probe"
second_source_inode="$(stat -c '%i' "$temporary_directory/probe")"
test "$first_source_inode" != "$second_source_inode"
rm -f "$temporary_directory/state/mounted" "$temporary_directory/state/mounted-inode"
docker compose -p "$project" -f "$temporary_directory/compose.yml" up -d --pull never --no-deps --force-recreate app >>"$command_output" 2>&1
wait_for_mount
cmp -s "$temporary_directory/probe" "$temporary_directory/state/mounted"
second_mounted_inode="$(cat "$temporary_directory/state/mounted-inode")"
test "$first_mounted_inode" != "$second_mounted_inode"

if grep -Fq "$first_value" "$temporary_directory/rendered.yml" "$command_output" || \
   grep -Fq "$second_value" "$temporary_directory/rendered.yml" "$command_output"; then
  printf '%s\n' "Compose secret rotation leaked a probe value." >&2
  exit 1
fi

printf '%s\n' "Compose force-recreated a read-only service and mounted the rotated file-secret inode and value without logging either value."
