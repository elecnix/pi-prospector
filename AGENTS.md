# pi-prospector

## Start here: read DESIGN.md first

Before writing or reviewing any code in this repo, read **`DESIGN.md`** at the
repository root. It is the single source of truth for *what this system is* and
*why it is shaped the way it is* — and it will save you from the most expensive
mistakes you can make here.

This is not an ordinary codebase. It is an **append-only analysis graph** with
idempotent, recipe-addressed nodes, typed-edge relationships, scan-based
incremental recomputation, and versioned lineage. Those are load-bearing
invariants, not stylistic preferences: a change that looks harmless in isolation
(mutating a node, hiding a relationship outside the edge table, leaving identity
out of the recipe, tracking progress in side state) can quietly break
traceability or idempotency across the whole system. DESIGN.md tells you which
invariants must hold and gives you a checklist for evaluating any change against
them.

It also fixes a **ubiquitous language** — precise, one-meaning definitions for
every core concept (session, pair, analysis node, node/edge kinds, recipe and
input hash, scan, unit status, run modes, lineage, model tiers, proposal
lifecycle). Use exactly these words with exactly these meanings in code, commits,
comments, and discussion. When you and the code agree on vocabulary, you stop
guessing what `stale`, `revises`, or `consumes` mean and start reasoning
correctly the first time. If you reach for a concept the glossary doesn't name,
define it there before you build it.

In short: a few minutes in DESIGN.md is the difference between contributing
*with* the architecture and accidentally fighting it. Read it, then come back
for the operational rules below.

## Session data safety

`~/.pi/agent/sessions/` is read-only. Never write, delete, or move session files. Before running sync for the first time, back up your sessions manually (e.g. `tar czf ~/prospector-backup/sessions-$(date +%Y%m%d).tgz ~/.pi/agent/sessions/`). pi-prospector does not create this backup for you.

No personal session content in source code, tests, git history, or CI artifacts. Test fixtures must be hand-written synthetic JSONL with no real user data.

## Type safety

TypeBox for all data shapes. No bare `interface` or `type` declarations. Every shape is a `Type.Object({...})` schema, types derived via `Static<typeof Schema>`. This includes session entries, database rows, CLI params, LLM responses, and config.

## Testing

- Unit tests: pure functions, no deps. Mock nothing.
- Component tests: real SQLite (temp file), fixture JSONL files, mocked LLM calls. Test full sync→analyze→proposal flows end-to-end.
- No evals in v1. LLM quality is subjective; tests verify structure, not proposal quality.
- Runner: `node:test` + `node:assert`. No test frameworks.
- Fixtures in `tests/fixtures/`. Hand-written, deterministic, version-controlled. No real session data — synthetic only.

## Integration tests (tmux + real Pi)

Run the latest pi-coding-agent inside tmux, send `/prospect` commands, capture text screenshots, upload as GH Actions artifacts. This exercises the real extension loaded into a real Pi session.

- `test/integration/run-screenshots.js` — orchestrates tmux session, sends commands, captures screenshots
- Uses the latest pi from npm (auto-installed in CI)
- Each screenshot is a `.txt` file from `tmux capture-pane`
- Scenarios: extension loads, `/prospect sync`, `/prospect stats`, `/prospect proposals`, `/prospect analyze` (mocked LLM), accept/reject
- No real API keys — mock the LLM provider via a local HTTP server

## CI

GitHub Actions on every push. Node 22 (matches Pi's minimum) and 24 (current). Three jobs:

1. `test` — `npm test` (unit + component, mocked LLM)
2. `integration-test` — tmux screenshots with real Pi + mocked LLM
3. Screenshots uploaded as artifacts, retained 30 days

## Code organization

- `src/sync/` — session scanning and parsing (no LLM)
- `src/db/` — all SQL lives in `db/queries.ts` only. Migrations in `db/schema.ts`.
- `src/analyze/` — LLM prompt in `analyze/prompt.ts` only. Response parsing in `analyze/parser.ts`.
- `src/commands/` — Pi slash commands and tool registration
- `src/types.ts` — shared TypeBox schemas

## Code style

- ESM, strict TypeScript, `noUncheckedIndexedAccess`. No `any`.
- Errors thrown with messages, no silent catches.
- Commit messages: `scope: short imperative`, e.g. `sync: parse compactionSummary entries`.
