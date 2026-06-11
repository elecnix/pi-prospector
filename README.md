# pi-prospector

Incremental session analysis and proposal generation for the [Pi coding agent](https://github.com/earendil-works/pi).

pi-prospector reads your Pi session transcripts, indexes them into a local SQLite database, and builds an **append-only analysis graph** over them — measuring every turn deterministically and using an LLM only where the signal warrants it. From that graph it surfaces concrete, deduplicated proposals to improve your prompts, skills, and configuration. It never applies them. You decide what to develop.

pi-prospector is a Pi **extension**: it has no standalone CLI. Everything runs through slash commands and a `prospect` tool inside a Pi session.

## How it works

```
Pi sessions (~/.pi/agent/sessions/)
        │
        ▼
┌──────────────────────┐
│  /prospect-sync      │  ← Incremental, no LLM. Only new lines are parsed.
│  (fast, cheap)       │    Detects forks; shared message trees stored once.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  prospector.db       │  ← Sessions, messages (+FTS), the analysis graph,
│  (SQLite + FTS5)     │    and proposals.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  /prospect-analyze   │  ← Builds the analysis graph incrementally:
│                      │
│  turn-pair-core      │    1. Score every turn — deterministic, no LLM.
│        │             │
│        ▼             │
│  turn-pair-llm       │    2. Classify only high-signal turns — cheap tier.
│        │             │
│        ▼             │
│  session-overview    │    3. Synthesise → materialise proposals.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  proposals table     │  ← status: open / applied / rejected / duplicate.
│  in prospector.db    │    Each links back to the node that justifies it.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  Pi tool: prospect   │  ← Your agent lists proposals, accepts or rejects
│  /prospect-* commands│    them, requests syncs, checks stats.
└──────────────────────┘
```

The analysis graph is **append-only and incremental**. Each node records the exact *recipe* that produced it (which analyzer, at which version, under which config, over which inputs), so re-running analysis recomputes only what is genuinely out of date and never repeats expensive LLM work that is still current. See [`DESIGN.md`](./DESIGN.md) for the full model.

## Install

```bash
pi install git:github.com/v2nic/pi-prospector
```

Requires Pi with an LLM API key configured for at least one provider. You choose which models analysis uses (see [Configuration](#configuration)); the deterministic layer needs no model at all.

> **Back up your sessions first.** pi-prospector treats `~/.pi/agent/sessions/` as read-only and never writes to it, but it does not make a backup for you. Run something like `tar czf ~/prospector-backup/sessions-$(date +%Y%m%d).tgz ~/.pi/agent/sessions/` before your first sync.

## Commands

### `/prospect-sync`

Index session files into the database. No LLM is called. Fast and cheap.

- Scans `~/.pi/agent/sessions/` for new or modified `.jsonl` files
- Parses each file line-by-line, starting from the last line previously processed (incremental)
- Detects sessions that forked from another via the `parentSession` header — shared message trees are stored once, not duplicated
- Tracks a cursor per session file (`{session_id, last_line, last_modified}`) and re-indexes a file only when its modification time changes

Run it as often as you like. It's idempotent and incremental.

### `/prospect-analyze [--revise <reasons>] [--limit N] [--session ID] [--analyzer ID] [--model provider/model]`

Build the analysis graph over synced sessions and materialise proposals. By default it does the cheapest useful thing: it **fills only missing work**. Nodes that are already current are skipped; nodes that are out of date are left alone unless you ask for them with `--revise`.

- `--revise major|minor|config|all` — also recompute *stale* nodes, selected by **why** they are stale:
  - `major` — the analyzer shipped a significant new version
  - `minor` — a small analyzer version bump (`minor` implies `major`)
  - `config` — *your* setup changed (a threshold, a prompt override, the tier→model mapping, or a model pin — including the resolved model)
  - `all` — every reason; combinable as a list, e.g. `--revise minor,config`

  Reasons only *select* which out-of-date nodes a run touches. A selected node is always recomputed to the **current recipe in full** (latest version, latest config, latest resolved model), and the new node is linked to its predecessor by a `revises` edge so lineage stays navigable. A plain fill scans only not-yet-analysed sessions; any `--revise` reason re-scans every session so stale work can be found.
- `--limit N` — cap how many sessions are scanned
- `--session ID` — analyse a single session
- `--analyzer ID` — run a single analyzer (`turn-pair-core`, `turn-pair-llm`, or `session-overview`) and its dependencies
- `--model provider/model` — pin **every** model tier to one concrete model for this run. Because the resolved model is part of a node's identity, a pinned run produces its own nodes; switching back to the normal mapping marks them stale (reason `config`).

Proposals are never auto-applied. They sit in the database with status `open` until you accept or reject them.

### `/prospect-stats`

Print a summary of the database: sessions indexed, messages and tool results, sessions analysed, proposals by status (`open`/`applied`/`rejected`/`duplicate`), and analysis-graph totals (nodes, edges, runs, and a breakdown of nodes by kind).

### `/prospect-proposals [status]`

List proposals, optionally filtered by status (`open`, `applied`, `rejected`, `duplicate`). Each row shows its status, severity, target, title, and summary.

- **Target** — what the proposal suggests changing (a category and optional path, e.g. a standing instruction file or a skill)
- **Severity** — the nature of the signal: `friction` | `correction` | `waste` | `suggestion`
- **Status** — `open`, `applied`, `rejected`, or `duplicate`

### `/prospect-accept <id>`

Mark an open proposal as `applied`. This does **not** apply the change — it only updates the status. You then ask your Pi coding agent to implement it.

### `/prospect-reject <id>`

Mark an open proposal as `rejected`.

## Pi tool: `prospect`

When installed, pi-prospector registers a `prospect` tool the Pi coding agent can call during a session:

| Action | What it does |
|--------|-------------|
| `sync` | Index new/modified sessions into the database |
| `stats` | Return sync and proposal statistics |
| `list_proposals` | List proposals, optionally filtered by status |
| `accept` | Mark a proposal as applied |
| `reject` | Mark a proposal as rejected |

This lets you say things like "show me open proposals" or "sync my sessions and check stats" directly in a Pi conversation. (Analysis itself runs through `/prospect-analyze`, not the tool, because it can be long-running and cost money.)

## What gets analyzed

pi-prospector reads **only what is inside Pi session files**. It does not read Pi configuration files, `AGENTS.md`, skill files, or any other artifact directly. A session file contains:

- User messages (what you said)
- Assistant messages (what the agent said, including thinking)
- Tool calls and tool results (what the agent did)
- Compaction summaries (what was retained after context compression)
- Model changes and thinking-level changes

The unit of analysis is a **turn** — one round of work, segmented at the same boundaries Pi uses (a user or `bashExecution` message, or a `branch_summary`/`custom_message` entry). The deterministic layer scores every turn; only high-signal turns are sent to the LLM. The system prompt is not stored in session files and is not captured.

## Fork deduplication

Pi sessions are stored as trees. When you branch a session with `/tree`, the new session file carries a `parentSession` header pointing to the original, and messages before the branch point are shared. During sync, pi-prospector reads that header, resolves the parent, stores shared messages once, and marks the forked session as starting from the branch point — so analysing a fork only processes the **new** messages after the branch.

## Configuration

Create `~/.pi/agent/prospector.json` (all fields optional):

```json
{
  "dbPath": "~/.pi/agent/prospector.db",
  "modelTiers": {
    "cheap": "anthropic/claude-haiku-4-5",
    "mid": "anthropic/claude-sonnet-4-5",
    "expensive": "anthropic/claude-opus-4-1"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `dbPath` | `~/.pi/agent/prospector.db` | Path to the SQLite database. A leading `~` is expanded. |
| `modelTiers` | Claude haiku-4-5 / sonnet-4-5 / opus-4-1 | Maps the abstract tiers analyzers request (`cheap`/`mid`/`expensive`) to concrete `provider/model` strings. Each must be a model Pi has credentials for. Override every tier for a single run with `--model`. |

Analyzers ask for a **tier**, not a model, so you tune cost vs. quality in one place. The resolved model is part of a node's identity: change the mapping and the affected nodes become stale (reason `config`), recomputed when you next run `--revise config`. All model access goes through Pi's own provider system — pick any model Pi supports (configured via `/login` or API keys). The deterministic `turn-pair-core` layer needs no model and always runs.

The following environment variables override paths and are mainly for testing: `PROSPECTOR_DB_PATH`, `PROSPECTOR_SESSIONS_DIR`, `PROSPECTOR_CONFIG`.

## Design

[`DESIGN.md`](./DESIGN.md) is the canonical description of the system: the ubiquitous language, the append-only graph, recipe-based identity and idempotency, versioned lineage, the reach of a run, and the deterministic-first layering. Read it before changing analysis behaviour.

## License

MIT
