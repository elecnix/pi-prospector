# pi-prospector

Incremental session indexing and proposal generation for the [Pi coding agent](https://github.com/earendil-works/pi).

pi-prospector reads your Pi session transcripts, indexes them into a local SQLite database, and uses an LLM to propose improvements to your prompts, skills, and configuration — without applying them. You decide what to develop.

## How it works

```
Pi sessions (~/.pi/agent/sessions/)
        │
        ▼
┌─────────────────────┐
│  prospect sync       │  ← Incremental. Only new lines are processed.
│  (no LLM, fast)     │  Detects forks. Deduplicates shared message trees.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  sessions.db        │  ← All session data, messages, and proposals
│  (SQLite + FTS5)    │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  prospect analyze    │  ← Runs an LLM over unprocessed sessions.
│  (uses Pi provider)  │  Generates proposals. Does NOT edit any files.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  proposals table     │  ← status: new / accepted / rejected
│  in sessions.db      │  Each proposal records when it was made.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Pi tool: prospect   │  ← Your coding agent lists proposals, accepts
│  /prospect command   │     or rejects them, requests syncs, checks stats.
└─────────────────────┘
```

## Install

```bash
pi install git:github:nicolas-marchildon/pi-prospector
```

Requires pi with an LLM API key configured for at least one provider. You choose which model to use for analysis.

## Commands

### `/prospect sync`

Index session files into the database. No LLM is called. Fast and cheap.

- Scans `~/.pi/agent/sessions/` for new or modified `.jsonl` files
- Parses each file line-by-line, starting from the last line previously processed (incremental)
- Detects sessions that forked from another session via the `parentSession` header — shared message trees are stored once, not duplicated
- Tracks a cursor per session file: `{session_id, last_line, last_modified}`
- Re-indexes a file only if its modification time has changed since the last sync

Run this as often as you like. It's idempotent and incremental.

### `/prospect analyze [--limit N] [--model provider/model]`

Run an LLM over sessions that have been synced but not yet analyzed. Generates proposals and inserts them into the database.

- Processes sessions in chronological order (oldest first) by default
- `--limit N`: only analyze N sessions (default: all unprocessed)
- `--model provider/model`: which Pi provider model to use (default: the model from `~/.pi/agent/prospector.json`, falls back to the current session model)
- Calls the Pi AI library (`@earendil-works/pi-ai`) directly — no subprocess, no extra session
- Each proposal records `created_at` so you can tell whether a session segment predates or postdates a given recommendation
- Analyze is incremental: it processes new or changed sessions regardless of whether past proposals from those sessions were accepted, rejected, or applied. The indexer and the analyzer are independent — sync always indexes new data, analyze always generates proposals from unprocessed data
- Proposals are never auto-applied. They sit in the database with status `new` until you decide

### `/prospect stats`

Print a summary of the database:

- Total sessions indexed
- Total messages (user + assistant) and tool responses
- Number of messages processed by the LLM
- Number of proposals by status (new / accepted / rejected)

### `/prospect proposals [--status new|accepted|rejected]`

List proposals from the database, optionally filtered by status.

Each proposal shows:
- **ID** — unique identifier
- **Target** — what this proposal suggests changing (e.g. `AGENTS.md § Tool usage`, `skill/debug-typescript-errors`)
- **Severity** — `friction` | `correction` | `waste` | `suggestion`
- **Summary** — one-line description of the proposed change
- **Created** — when the proposal was generated
- **Session** — which session triggered it
- **Status** — `new`, `accepted`, or `rejected`

### `/prospect accept <id>`

Mark a proposal as accepted. This does **not** apply the proposal — it only updates the status. You then ask your Pi coding agent to implement it.

### `/prospect reject <id>`

Mark a proposal as rejected.

## Pi tool: `prospect`

When installed, pi-prospector registers a `prospect` tool that the Pi coding agent can call during sessions:

| Action | What it does |
|--------|-------------|
| `sync` | Index new/modified sessions into the database |
| `stats` | Return sync and proposal statistics |
| `list_proposals` | List proposals, optionally filtered by status |
| `accept` | Mark a proposal as accepted |
| `reject` | Mark a proposal as rejected |
| `analyze` | Run the LLM over unprocessed sessions |

This lets you say things like "show me new proposals" or "sync my sessions and check stats" directly in a Pi conversation.

## What gets analyzed

pi-prospector reads **only what is inside Pi session files**. It does not read Pi configuration files, `AGENTS.md`, skill files, or any other artifact directly. The session file contains:

- User messages (what you said)
- Assistant messages (what the agent said, including thinking)
- Tool calls and tool results (what the agent did)
- Compaction summaries (what was retained after context compression)
- Model changes and thinking level changes

The system prompt is not stored in session files and is not captured in v1.

## Timestamps

Each proposal records `created_at`. Each session message has a `timestamp`. These are stored in the database in case you want to correlate proposals with session activity later. v1 does nothing with this information beyond storing it.

## Fork deduplication

Pi sessions are stored as trees. When you branch a session with `/tree`, the new session file has a `parentSession` header pointing to the original. Messages before the branch point are shared.

During sync, pi-prospector:

1. Reads the `parentSession` header from each session file
2. Resolves the parent session file
3. Stores shared messages once, tagged with the original session
4. Marks the forked session as starting from the branch point

This means analyzing a forked session only processes the **new** messages after the fork — not the entire conversation history again.

## Configuration

Create `~/.pi/agent/prospector.json`:

```json
{
  "model": "openrouter/deepseek-v4-flash",
  "dbPath": "~/.pi/agent/prospector.db"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `model` | *(current session model)* | Provider and model to use for analysis, in `provider/model` format. Must be a model Pi has an API key for. Cheaper models like `openrouter/deepseek-v4-flash` or `gemma4:26b` work well for analysis. Override per-run with `--model`. |
| `dbPath` | `~/.pi/agent/prospector.db` | Path to the SQLite database |

The model must correspond to a provider Pi already has credentials for (configured via `/login` or API keys). Any model Pi supports works — pick based on cost vs. quality. For backfill, a cheap model is recommended.



## License

MIT