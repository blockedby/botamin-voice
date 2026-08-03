# Protected owner dialogue export

Dialogue export is an executable, manual owner action for local debugging. It is the documented exception to the normal no-transcript-artifact rule: the application never exports automatically and does not add duplicate runtime storage. The source remains the existing SQLite `turns` rows, whose default 30-day retention remains DB-owned.

## Compose command (default)

Run from the repository root while the local Compose `app` service is running:

```bash
bun run dialogues:export
```

The source defaults to `--source compose` regardless of any generic `DATABASE_URL` loaded from the root `.env`. The wrapper always uses `docker compose exec -T app` and the running app container's named-volume database at `/data/app.db`; it never redirects Compose export to a host SQLite path.

The default conversation selector is latest by completion timestamp, falling back to start timestamp. The optional conversation selectors are mutually exclusive:

```bash
bun run dialogues:export --conversation <ULID-or-UUIDv7>
bun run dialogues:export --limit 10   # latest 10; range 1..100
bun run dialogues:export --all        # all retained; fails above 100
```

`--source compose` may be written explicitly. `--database` is invalid with Compose.

## Explicit direct command

Direct SQLite access is never inferred from `DATABASE_URL`. It requires `--source direct` and exactly one dedicated database input:

```bash
bun run dialogues:export --source direct --database /absolute/path/to/app.db

# Alternative dedicated environment input; an absolute path or file URL is required.
BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL=file:/absolute/path/to/app.db \
  bun run dialogues:export --source direct
```

Relative paths, a missing direct database input, duplicate source/database arguments, a direct database argument combined with `BOTAMIN_DIALOGUE_EXPORT_DATABASE_URL`, and conflicting conversation selectors fail validation. Generic `DATABASE_URL` is ignored by the owner wrapper.

## Bounds and failure behavior

The Compose child has a 30-second deadline. Stdout and stderr are captured with separate byte bounds; neither is relayed. On timeout, oversized output, malformed output, or another failure, the wrapper terminates the detached Compose process group, escalates when needed, and waits only for a bounded cleanup interval. The reader streams its bounded result and creates no container export temp file. Host output starts only after a complete, validated result has arrived, and atomic-write failures remove the mode-`0600` host temp file.

Success prints only aggregate status, conversation/turn counts, and the generated path. A missing container, DB, or conversation; malformed DB; invalid arguments; timeout; or size bound fails without a partial export and without transcript-bearing errors. Exports are capped at 100 conversations, 16 MiB of source transcript text, and 20 MiB of rendered Markdown.

## Minimal output and privacy

Files are atomically created under the gitignored `.runtime/dialogues/` directory:

- directory mode: `0700`;
- file mode: `0600`;
- filename: export timestamp plus random suffix, with no conversation ID or visitor data;
- content: only role-labelled `Вы` and `Botamin` text from `turns`, grouped under generated dialogue/turn headings that are not persisted values;
- Markdown headings, fences, blockquotes, unordered/ordered/task lists, thematic breaks, HTML-like blocks, inline syntax, unsafe indentation, and non-printing/control characters from transcript text are neutralized while preserving readable text.

The export does **not** render conversation or turn IDs, timestamps, status, stage, completion/interruption fields, source, locale, consent, Codex thread IDs, model names, prompts, raw audio/base64, credentials, provider request/response bodies, contacts stored outside transcript text, booking data, resume tokens, tool payloads, domain events, logs, or usage metadata. Ordering columns may be read internally solely to preserve latest/limit/all and turn ordering.

The transcript itself can naturally contain visitor PII. Restrict host and Docker access, do not attach an export to tickets or commits, and delete it when the debugging need ends. Database retention does not delete exported files, and deleting an export does not perform privacy deletion in SQLite; each is a separate owner responsibility.
