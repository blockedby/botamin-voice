# syntax=docker/dockerfile:1.7

ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

FROM ${BUN_IMAGE} AS codex
ARG CODEX_CLI_VERSION=0.146.0
ENV BUN_INSTALL=/opt/codex
RUN bun add --global "@openai/codex@${CODEX_CLI_VERSION}" \
    && test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}" \
    && mkdir -p /tmp/codex-schema/ts /tmp/codex-schema/json \
    && codex app-server generate-ts --experimental --out /tmp/codex-schema/ts \
    && codex app-server generate-json-schema --experimental --out /tmp/codex-schema/json \
    && test "$(find /tmp/codex-schema/ts -type f | wc -l | tr -d ' ')" -gt 0 \
    && test "$(find /tmp/codex-schema/json -type f | wc -l | tr -d ' ')" -gt 0 \
    && rm -rf /tmp/codex-schema

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/prompt-compiler/package.json packages/prompt-compiler/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY apps ./apps
COPY packages ./packages
COPY prompts ./prompts
COPY knowledge ./knowledge
COPY drizzle ./drizzle
COPY infra/ops ./infra/ops
RUN bun run build \
    && bun build ./infra/ops/db.ts --outdir ./dist/ops --target bun \
    && mkdir -p /opt/runtime-check \
    && bun ./packages/prompt-compiler/dist/src/cli.js \
       --source-root /app \
       --runtime-dir /opt/runtime-check \
       > /tmp/prompt-bundle.json \
    && test "$(find /opt/runtime-check -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -eq 1 \
    && test -f /opt/runtime-check/AGENTS.md \
    && test "$(stat -c '%a' /opt/runtime-check/AGENTS.md)" = "444"

FROM ${BUN_IMAGE} AS runtime
ARG CODEX_CLI_VERSION=0.146.0
LABEL org.opencontainers.image.title="Botamin Voice" \
      org.opencontainers.image.description="Local-first Botamin Bun application with pinned Codex CLI" \
      org.opencontainers.image.version="0.4-demo" \
      io.botamin.bun.version="1.3.14" \
      io.botamin.codex.version="${CODEX_CLI_VERSION}"

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/bun \
    CODEX_HOME=/codex-home \
    CODEX_CWD=/app/runtime/brain \
    DATABASE_URL=file:/data/app.db \
    MIGRATIONS_DIR=/app/drizzle \
    PROMPT_SOURCE_ROOT=/app/prompt-source \
    PROMPT_RUNTIME_DIR=/app/runtime/brain \
    PATH=/usr/local/bin:/usr/local/bun-node-fallback-bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app
RUN mkdir -p \
      /app/apps/server/dist \
      /app/apps/web/dist \
      /app/prompt-compiler \
      /app/prompt-source/prompts \
      /app/prompt-source/knowledge \
      /app/runtime-brain-image \
      /codex-home \
      /data/backups \
    && chown -R bun:bun /app /codex-home /data \
    && chmod 0700 /codex-home /data /data/backups

COPY --from=codex /opt/codex /opt/codex
RUN ln -s /opt/codex/install/global/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
COPY --from=build --chown=bun:bun /app/apps/server/dist/ /app/apps/server/dist/
COPY --from=build --chown=bun:bun /app/apps/web/dist/ /app/apps/web/dist/
COPY --from=build --chown=bun:bun /app/packages/prompt-compiler/dist/src/ /app/prompt-compiler/
COPY --from=build --chown=bun:bun /app/prompts/ /app/prompt-source/prompts/
COPY --from=build --chown=bun:bun /app/knowledge/ /app/prompt-source/knowledge/
COPY --from=build --chown=bun:bun /app/drizzle/ /app/drizzle/
COPY --from=build --chown=bun:bun /app/dist/ops/ /app/ops/
COPY --from=build --chown=bun:bun /opt/runtime-check/AGENTS.md /app/runtime-brain-image/AGENTS.md
COPY --chown=bun:bun infra/entrypoint.sh /usr/local/bin/botamin-entrypoint
RUN chmod 0555 /usr/local/bin/botamin-entrypoint \
    && find /app/prompt-source /app/drizzle -type d -exec chmod 0555 {} + \
    && find /app/prompt-source /app/drizzle -type f -exec chmod 0444 {} + \
    && chmod 0444 /app/runtime-brain-image/AGENTS.md

USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/botamin-entrypoint"]
CMD ["bun", "/app/apps/server/dist/index.js"]
