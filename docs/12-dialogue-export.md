# Protected owner dialogue export

Dialogue export is a manual, explicit owner action for local debugging. It is the documented exception to the normal no-transcript-artifact rule: the application never exports automatically and does not add duplicate runtime storage. The source remains the existing SQLite `turns` rows, whose default 30-day retention remains DB-owned.

## Command

Run from the repository root while the local Compose app is running:

```bash
bun run dialogues:export
```

The default is the latest conversation by completion timestamp, falling back to its start timestamp. Optional, mutually exclusive selectors are:

```bash
bun run dialogues:export --conversation <ULID-or-UUIDv7>
bun run dialogues:export --limit 10   # latest 10; range 1..100
bun run dialogues:export --all        # all retained, but fails if more than 100 exist
```

For direct Bun development, set `DATABASE_URL` to a plain local SQLite file URL/path and run the same command. If `DATABASE_URL` is unset, the wrapper executes the read-only reader inside the running Compose `app` container so it can access the named-volume DB. Reader output is captured by the wrapper and is not relayed to the terminal or Docker logs.

Success prints only aggregate status, conversation/turn counts, and the generated path. A missing container/DB/conversation, malformed DB, invalid selector, or size bound fails without a partial export. Exports are capped at 100 conversations, 16 MiB of source transcript text, and 20 MiB of rendered Markdown.

## Output and privacy

Files are atomically created under the gitignored `.runtime/dialogues/` directory:

- directory mode: `0700`;
- file mode: `0600`;
- filename: export timestamp plus random suffix, with no conversation ID or visitor data;
- content: UTC and Europe/Moscow timestamps, status, stage transitions, complete/interrupted flags, and only visitor/Botamin text from `turns`;
- Markdown syntax/fences and non-printing controls are escaped for readable, non-injecting output.

The export does **not** include raw audio/base64, credentials, provider request/response bodies, Codex thread IDs, contacts stored outside transcript text, booking or internal IDs, resume tokens, prompts, tool payloads, domain events, logs, model names, or usage metadata.

The transcript itself can naturally contain visitor PII. Restrict host and Docker access, do not attach an export to tickets or commits, and delete it when the debugging need ends. Database retention does not delete exported files, and deleting an export does not perform privacy deletion in SQLite; each is a separate owner responsibility.
