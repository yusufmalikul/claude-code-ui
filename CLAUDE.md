# local-claude

Local web UI wrapping the `claude` CLI. Fastify server + vanilla JS frontend + SQLite for sessions/messages.

## Layout

- `server.js` — Fastify app, REST + WebSocket. Owns the `running` map (one in-flight run per session) and the `clients` set for broadcast.
- `claude-adapter.js` — `spawnClaude({...})` runs one turn of `claude --print --output-format stream-json --input-format stream-json` and dispatches typed callbacks (`onToken`, `onTool`, `onToolResult`, `onState`, `onSession`). Returns `{ child, done, cancel }`.
- `session-manager.js` — thin sqlite wrapper. Sessions have `id`, `title`, `cwd`, `claude_id` (the CLI session id used for `--resume`), timestamps. Messages are JSON-stringified in the `content` column.
- `db.js` / `schema.sql` — SQLite open + schema.
- `public/app.js` — single-file frontend. Talks to `/ws` for streaming and `/api/sessions` for CRUD.
- `claude-history.js` — reads transcripts from `~/.claude/projects/<slug>/<sessionId>.jsonl`. Exposes `listProjects()`, `listSessionsForSlug(slug)`, `readTranscript(slug, id)`. The project folder slug is the cwd with `/` and `.` replaced by `-`; since that mapping isn't reversible, we recover the true `cwd` by peeking the first transcript line.

## Session lifecycle

1. Client sends `{ type: 'new_session' }` (no title → server uses placeholder `"New chat"`).
2. First `send_message` spawns `claude` via `spawnClaude`. `onSession` captures the CLI's session id and persists it as `claude_id`; subsequent turns pass it as `--resume` for context continuity.
3. After the first turn completes, `maybeAutoTitle` runs a separate one-shot `claude --print` invocation to summarize the exchange into a 3-6 word title, then renames the session if it's still the placeholder. Failures are silent.
4. Rename/delete go through REST (`PATCH`/`DELETE /api/sessions/:id`) and broadcast `session_list`.

## Importing existing Claude Code sessions

- UI: sidebar ↓ button opens a modal listing sessions from `~/.claude/projects/`. Defaults to the current cwd; "Show all projects" toggles the filter.
- `POST /api/history/import` with `{ slug, ids }` reads each transcript via `readTranscript`, then calls `sessions.importSession({ ..., claudeId, messages })`. The CLI's session id is stored in `claude_id` so the next `send_message` resumes via `--resume` exactly like a native session.
- Idempotent: import checks `findByClaudeId` before inserting, and the UI marks already-imported sessions as disabled.
- The transcript parser groups assistant text + `tool_use` blocks into one `{ role: 'assistant', content: { text, tool_calls } }` row matching what the live runtime writes, and folds `tool_result` blocks (which appear in the JSONL as synthetic user messages) back into the preceding assistant's `tool_calls[].result`. Sidechain entries are skipped.

## Auto-titling notes

- Placeholder string is `AUTO_TITLE_PLACEHOLDER = 'New chat'` in `server.js`. The title generator only fires while the session still has that exact title — if the user renamed it mid-flight, we skip.
- The title prompt is a separate `claude` subprocess (no `--resume`, no stream-json) with a 30s timeout. It's a fresh context, not part of the user's chat session, so it doesn't cost session tokens.
- The very first session created at boot (when DB is empty) is still hardcoded to `'main'` — that one isn't auto-titled.

## Conventions

- Don't add Claude/Anthropic attribution to commits or PR bodies (per user's global instruction).
- Frontend has no build step — edit `public/app.js` directly.
- Server uses `app.log` (pino) for logging; prefer that over `console.log`.
