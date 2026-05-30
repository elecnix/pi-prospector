# pi-prospector Analyzer Framework — Final Design

## 1. Overview

The analyzer framework extends pi-prospector's session index with an **append-only analysis graph** grafted onto the conversation tree. Every analysis artifact is versioned, idempotent, and traceable back to the exact analyzer code, prompt, and configuration that produced it. Proposals are materialized from analysis nodes into a fast-access table for user review and deduplication.

### Core principles

1. **Append-on-write** — analysis nodes are never mutated. New analyzer versions or config changes produce new nodes; old ones persist for auditability and meta-analysis.
2. **Grafted graph** — analysis nodes attach to conversation messages and to each other via explicit edges, not only parent-child tree links.
3. **Idempotent** — re-running an analyzer with the same recipe on the same sources produces no new nodes. Crash recovery picks up where it left off.
4. **Incremental** — cursors track progress per (analyzer, version, config, session). Only new messages get analyzed.
5. **Versioned provenance** — every node traces back to the exact analyzer version, prompt version, config version, and run that produced it.
6. **Dependency-scoped visibility** — an analyzer sees only its own nodes, conversation data, and nodes from explicitly declared dependencies.
7. **Deterministic first, LLM optional** — every analyzer produces a deterministic baseline. LLM enrichment is a separate pass on flagged artifacts.

```
Conversation graph (read-only, synced from Pi sessions):
  msg_1 → msg_2 → msg_3 → [compactionSummary] → msg_4 → msg_5

Analysis graph (append-only, produced by analyzers):
  msg_1 ←── turn-pair node (metric, deterministic)
  msg_3 ←── turn-pair node (metric + classification, deterministic + LLM)
  session ←── session-compact node (summary + proposals, depends on turn-pair)
  session ←── session-compact node ──┐
                                       ├── proposal node (materialized into proposals table)
  turn-pair node ─────────────────────┘
```

---

## 2. Data model

### 2.1 Entity-relationship overview

```
analyzer_defs                  analyzer_config_versions
  │                              │
  │ 1:N                          │ 1:N
  ▼                              ▼
analyzer_versions              (referenced by analysis_runs and analysis_nodes)
  │
  │ N:N via prompt_version_edges
  ▼
prompt_versions ────────────── analysis_runs
                                │
                                │ 1:N
                                ▼
                             analysis_nodes ────── analysis_edges
                                │                        │
                                │ 1:1 (optional)         │ outbound edges from each node
                                ▼                        │
                             proposals               inbound edges to each node
                                                        │
                                                        │ also edges to:
                                                        │   - messages (conversation anchor)
                                                        │   - prompt_versions (provenance)
                                                        │   - config_versions (provenance)
```

### 2.2 Table definitions

#### `analyzer_defs` — stable logical identity

One row per analyzer, regardless of version. Never deleted.

```sql
CREATE TABLE IF NOT EXISTS analyzer_defs (
    id              TEXT PRIMARY KEY,       -- e.g. 'turn-pair-core', 'session-compact-v1'
    label           TEXT NOT NULL,           -- human-readable: 'Per-Turn Sentiment & Friction'
    description     TEXT,                  -- what this analyzer does
    anchor_span     TEXT NOT NULL,          -- 'pair' | 'segment' | 'full_session'
    dependencies    TEXT NOT NULL DEFAULT '[]',  -- JSON array of analyzer_def ids
    created_at      TEXT NOT NULL
);
```

#### `analyzer_versions` — one row per code release

```sql
CREATE TABLE IF NOT EXISTS analyzer_versions (
    analyzer_id         TEXT NOT NULL,
    version_id          TEXT NOT NULL,       -- commit SHA or semver
    implementation_kind TEXT NOT NULL,       -- 'deterministic' | 'in_process_llm' | 'pi_subagent'
    code_ref            TEXT,               -- git commit, npm version, or extension path
    created_at          TEXT NOT NULL,
    PRIMARY KEY (analyzer_id, version_id),
    FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
);
```

#### `prompt_versions` — immutable prompt store

Content-addressed. Multiple analyzers can share identical prompts.

```sql
CREATE TABLE IF NOT EXISTS prompt_versions (
    id              TEXT PRIMARY KEY,       -- content hash (first 16 hex chars of SHA-256)
    content         TEXT NOT NULL,           -- full prompt text
    content_hash    TEXT NOT NULL UNIQUE,   -- full SHA-256 for verification
    role            TEXT,                   -- 'classify' | 'map' | 'reduce' | 'verify' | null for single-prompt
    created_at      TEXT NOT NULL
);
```

#### `analyzer_config_versions` — immutable config/parameter store

```sql
CREATE TABLE IF NOT EXISTS analyzer_config_versions (
    id              TEXT PRIMARY KEY,       -- config hash or UUID
    analyzer_id     TEXT NOT NULL,
    config_json     TEXT NOT NULL,          -- e.g. {"cheap_model": "anthropic/haiku-3", "friction_threshold": 0.5, "max_chunk_tokens": 4000}
    config_hash     TEXT NOT NULL UNIQUE,   -- SHA-256 of config_json
    label           TEXT,                   -- 'default', 'sensitive', 'aggressive'
    created_at      TEXT NOT NULL,
    FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
);
```

#### `analysis_runs` — execution provenance

One row per attempted execution of an analyzer on a session. This table is missing from the earlier drafts and is essential for debugging, cost tracking, and crash recovery.

```sql
CREATE TABLE IF NOT EXISTS analysis_runs (
    id                  TEXT PRIMARY KEY,
    analyzer_id         TEXT NOT NULL,
    analyzer_version_id TEXT NOT NULL,
    config_version_id   TEXT NOT NULL,
    session_id          TEXT NOT NULL,

    status              TEXT NOT NULL DEFAULT 'planned',  -- 'planned' | 'running' | 'ok' | 'error' | 'partial'
    prompt_bundle_hash  TEXT NOT NULL,     -- hash of all prompt_version_ids used in this run
    started_at          TEXT NOT NULL,
    finished_at         TEXT,
    model_spec          TEXT,              -- resolved model string, e.g. 'anthropic/claude-sonnet-4-5'
    cost_usd            REAL DEFAULT 0,
    tokens_used         INTEGER DEFAULT 0,
    nodes_produced      INTEGER DEFAULT 0,
    nodes_skipped       INTEGER DEFAULT 0,
    error_message       TEXT,

    FOREIGN KEY (analyzer_id, analyzer_version_id) REFERENCES analyzer_versions(analyzer_id, version_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON analysis_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON analysis_runs(status);
```

#### `analysis_nodes` — append-only artifact store

Every analysis artifact ever produced. No `UPDATE` or `DELETE` after insert.

```sql
CREATE TABLE IF NOT EXISTS analysis_nodes (
    id                  TEXT PRIMARY KEY,       -- UUID v7 (time-sortable)
    session_id          TEXT NOT NULL,

    analyzer_id         TEXT NOT NULL,
    analyzer_version_id TEXT NOT NULL,
    config_version_id   TEXT NOT NULL,
    run_id              TEXT NOT NULL,

    node_kind           TEXT NOT NULL,          -- 'metric' | 'classification' | 'summary' | 'proposal' | 'error'
    anchor_kind         TEXT NOT NULL,          -- 'message' | 'pair' | 'segment' | 'session' | 'analysis_node' | 'none'

    content_json        TEXT NOT NULL,          -- structured artifact payload (arbitrary JSON per node_kind)
    source_set_hash     TEXT NOT NULL,          -- idempotency: SHA-256 of sorted source refs

    created_at          TEXT NOT NULL,

    -- LLM metadata (NULL for deterministic nodes)
    model_used          TEXT,
    cost_usd            REAL DEFAULT 0,
    tokens_used         INTEGER DEFAULT 0,
    duration_ms         INTEGER,

    FOREIGN KEY (run_id) REFERENCES analysis_runs(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON analysis_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_analyzer ON analysis_nodes(analyzer_id, analyzer_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON analysis_nodes(node_kind);
CREATE INDEX IF NOT EXISTS idx_nodes_idempotency ON analysis_nodes(analyzer_id, analyzer_version_id, config_version_id, source_set_hash);
```

`content_json` is a flat JSON object whose schema depends on `node_kind` and `analyzer_id`. Examples are in §3.

#### `analysis_edges` — explicit graph relationships

The single table that makes this a real graph, not just a tree.

```sql
CREATE TABLE IF NOT EXISTS analysis_edges (
    from_node_id    TEXT NOT NULL,           -- the analysis_node that has this relationship
    to_ref_kind     TEXT NOT NULL,           -- 'message' | 'analysis_node' | 'session' | 'prompt_version' | 'config_version'
    to_ref_id       TEXT NOT NULL,           -- id of the referenced entity
    edge_kind       TEXT NOT NULL,           -- see edge kind taxonomy below
    ordinal         INTEGER DEFAULT 0,      -- ordering within same (from_node, edge_kind)
    PRIMARY KEY (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal),
    FOREIGN KEY (from_node_id) REFERENCES analysis_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_edges_to ON analysis_edges(to_ref_kind, to_ref_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON analysis_edges(edge_kind);
```

**Edge kind taxonomy:**

| Edge kind | Meaning | from | to |
|-----------|---------|------|----|
| `anchors` | This node is about this conversation entity | analysis_node | message, session, analysis_node |
| `consumes` | This node used this as input | analysis_node | analysis_node, message |
| `uses_prompt` | This run used this prompt version | analysis_node | prompt_version |
| `emits` | This node produced this proposal | analysis_node | (proposal extracted from content) |

Navigation examples:

```sql
-- From a proposal, find all analysis that contributed to it
WITH RECURSIVE provenance AS (
    SELECT from_node_id, edge_kind FROM analysis_edges
    WHERE to_ref_kind = 'proposal' AND to_ref_id = ?
    UNION ALL
    SELECT e.from_node_id, e.edge_kind FROM analysis_edges e
    JOIN provenance p ON e.to_ref_kind = 'analysis_node' AND e.to_ref_id = p.from_node_id
)
SELECT DISTINCT * FROM provenance;

-- From a message, find all analysis anchored to it
SELECT an.* FROM analysis_nodes an
JOIN analysis_edges e ON e.from_node_id = an.id
WHERE e.edge_kind = 'anchors' AND e.to_ref_kind = 'message' AND e.to_ref_id = ?;

-- What conversation messages influenced a session-level summary?
SELECT e.to_ref_id FROM analysis_edges e
WHERE e.from_node_id = ? AND e.edge_kind = 'consumes' AND e.to_ref_kind = 'message';
```

#### `analysis_progress` — incremental cursor per (analyzer, version, config, session)

```sql
CREATE TABLE IF NOT EXISTS analysis_progress (
    analyzer_id         TEXT NOT NULL,
    analyzer_version_id TEXT NOT NULL,
    config_version_id   TEXT NOT NULL,
    session_id          TEXT NOT NULL,

    cursor_json         TEXT,               -- analyzer-defined: {"last_message_rowid": 452, "last_pair_index": 17}
    last_run_id         TEXT,
    status              TEXT NOT NULL,       -- 'ok' | 'in_progress' | 'error' | 'needs_rerun'
    error_message       TEXT,
    updated_at          TEXT NOT NULL,

    PRIMARY KEY (analyzer_id, analyzer_version_id, config_version_id, session_id)
);
```

#### `proposals` — fast-access materialized view

Derived from `analysis_nodes` where `node_kind = 'proposal'`. Kept in sync by the framework after each run.

```sql
CREATE TABLE IF NOT EXISTS proposals (
    id                  TEXT PRIMARY KEY,
    analysis_node_id    TEXT NOT NULL UNIQUE,  -- 1:1 with the source analysis node

    session_id          TEXT NOT NULL,
    analyzer_id         TEXT NOT NULL,

    target_type         TEXT NOT NULL,    -- 'agents_md' | 'system_md' | 'skill' | 'extension_prompt' | 'tool_output' | 'repo_doc' | 'config'
    target_path         TEXT,             -- e.g. '~/.pi/agent/AGENTS.md' or 'skills/agent-retro/SKILL.md'
    title               TEXT NOT NULL,
    summary             TEXT NOT NULL,
    detail              TEXT,             -- proposed edit text or detailed explanation
    evidence_json       TEXT,             -- JSON array of message/node references and excerpts
    confidence          REAL,            -- 0.0–1.0
    severity            TEXT,             -- 'friction' | 'correction' | 'waste' | 'suggestion' | 'insight'
    dedup_key           TEXT,             -- hash of (target_type, target_path, severity, normalized summary)

    status              TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'accepted' | 'applied' | 'rejected' | 'duplicate'
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    FOREIGN KEY (analysis_node_id) REFERENCES analysis_nodes(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_target ON proposals(target_type, target_path);
CREATE INDEX IF NOT EXISTS idx_proposals_dedup ON proposals(dedup_key);
CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
```

Deduplication: when a new proposal node is materialized, the framework checks if an existing `open` proposal has the same `dedup_key`. If so, it increments an occurrence count in `detail` and marks the new one as `duplicate`.

---

## 3. Analyzer interface

### 3.1 TypeScript types

```typescript
// ── Analyzer definition ──

interface AnalyzerDef {
    id: string;                   // 'turn-pair-core', 'session-compact-v1'
    label: string;
    description: string;
    anchorSpan: 'pair' | 'segment' | 'full_session';
    dependencies: string[];       // analyzer_def ids this analyzer can see
}

interface AnalyzerVersion {
    analyzerId: string;
    versionId: string;            // commit SHA or semver
    implementationKind: 'deterministic' | 'in_process_llm' | 'pi_subagent';
    codeRef?: string;
}

interface PromptVersion {
    id: string;                   // content hash prefix
    content: string;
    contentHash: string;          // full SHA-256
    role?: string;                // 'classify' | 'map' | 'reduce' | 'verify'
}

interface AnalyzerConfig {
    id: string;                   // config hash or UUID
    analyzerId: string;
    configJson: Record<string, unknown>;
    configHash: string;
    label?: string;
}

// ── Analysis units (what an analyzer processes) ──

interface AnalysisUnit {
    /** Source references this unit consumes */
    sources: SourceRef[];
    /** Precomputed hash for idempotency */
    sourceSetHash: string;
    /** Analyzer-specific metadata */
    meta?: Record<string, unknown>;
}

interface SourceRef {
    kind: 'message' | 'analysis_node' | 'session';
    id: string;
}

// ── Analysis result (what an analyzer produces) ──

interface AnalysisResult {
    /** The node content — varies by analyzer and node_kind */
    contentJson: Record<string, unknown>;
    /** The node kind */
    nodeKind: 'metric' | 'classification' | 'summary' | 'proposal' | 'error';
    /** What this node anchors to */
    anchorKind: 'message' | 'pair' | 'segment' | 'session' | 'analysis_node' | 'none';
    /** Anchor reference id (if single anchor) */
    anchorRef?: string;
    /** Edges this node should have */
    edges: Array<{
        toRefKind: SourceRef['kind'] | 'prompt_version' | 'config_version';
        toRefId: string;
        edgeKind: 'anchors' | 'consumes' | 'uses_prompt';
        ordinal?: number;
    }>;
    /** LLM metadata (null for deterministic) */
    modelUsed?: string;
    costUsd?: number;
    tokensUsed?: number;
    durationMs?: number;
}

// ── Analyzer lifecycle ──

interface Analyzer {
    /** Stable identity */
    def: AnalyzerDef;
    /** Current version */
    version: AnalyzerVersion;
    /** Prompts this analyzer uses, keyed by role */
    prompts: Record<string, PromptVersion>;
    /** Default config */
    defaultConfig: AnalyzerConfig;

    /**
     * Determine which analysis units need to be produced for a session.
     * The framework filters out units that already have nodes for the current
     * recipe (idempotency), so plan() should return ALL candidate units,
     * including ones that may already exist.
     */
    plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]>;

    /**
     * Produce one analysis node for a single unit of work.
     * The framework handles: run creation, node insertion, edge creation,
     * idempotency, error recording.
     */
    analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult>;
}

// ── Contexts provided by the framework ──

interface AnalyzerPlanContext {
    sessionId: string;
    /** All messages in this session, ordered by rowid */
    messages: MessageRow[];
    /** All existing analysis_nodes for this session */
    allNodes: AnalysisNodeRow[];
    /** This analyzer's own previous nodes for this session */
    ownNodes: AnalysisNodeRow[];
    /** Nodes from declared dependencies, keyed by analyzer_id */
    dependencyNodes: Record<string, AnalysisNodeRow[]>;
    /** Current progress cursor (if any) */
    progress: ProgressRow | null;
    /** Database for direct queries */
    db: Database;
}

interface AnalyzerRunContext {
    /** Read a message by ID */
    getMessage(id: string): MessageRow | undefined;
    /** Read a dependency node by ID */
    getNode(id: string): AnalysisNodeRow | undefined;
    /** Query dependency nodes by analyzer_id */
    getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
    /** Invoke an LLM (abstraction over pi-ai or subshell) */
    llm(request: LLMRequest): Promise<LLMResponse>;
    /** The run this analyze() call belongs to */
    run: RunRow;
    /** The config for this run */
    config: AnalyzerConfig;
    /** Pre-resolved prompt texts, keyed by role */
    prompts: Record<string, string>;
}
```

### 3.2 Framework execution flow

```
runAnalyzer(analyzer, sessionId, config)

  1. Resolve analyzer version, prompts, config
  2. Store prompts in prompt_versions (INSERT OR IGNORE)
  3. Store config in analyzer_config_versions (INSERT OR IGNORE)
  4. Compute prompt_bundle_hash = SHA-256(sorted prompt_version_ids)
  5. Create an analysis_run row (status = 'running')

  6. analyzer.plan(ctx) → AnalysisUnit[]
  7. For each unit:
     a. Compute source_set_hash = SHA-256(sorted source refs)
     b. Check idempotency:
        SELECT id FROM analysis_nodes
        WHERE analyzer_id = ? AND analyzer_version_id = ?
          AND config_version_id = ? AND source_set_hash = ?
     c. If exists → skip (already computed), increment nodes_skipped
     d. If not → call analyzer.analyze(unit, runCtx)
     e. INSERT INTO analysis_nodes
     f. INSERT INTO analysis_edges for each edge in result.edges
     g. If node_kind = 'proposal' → upsert into proposals table
     h. Increment nodes_produced

  8. Update analysis_run (status = 'ok' or 'error', cost, tokens, etc.)
  9. Update analysis_progress (cursor, status)

  10. Return { runId, nodes_produced, nodes_skipped, cost_usd }
```

### 3.3 Crash recovery

If the process crashes between steps 6 and 8:

- `analysis_run.status` stays `'running'` — the framework detects this on next invocation
- `analysis_progress` may be stale — but `analysis_nodes` already inserted are still valid
- Re-running the same session with the same (analyzer, version, config) will:
  - Create a new `analysis_run`
  - Skip already-existing nodes (idempotency check in step 7b)
  - Only produce the missing nodes
  - Update progress to current state

No data corruption, no duplicate work.

---

## 4. Idempotency model

### 4.1 Recipe

A node's recipe uniquely determines it:

```
recipe = analyzer_id + analyzer_version_id + config_version_id + source_set_hash
```

Where `source_set_hash = SHA-256(sorted(canonical source refs))`.

### 4.2 Source set hash computation

```typescript
function computeSourceSetHash(sources: SourceRef[]): string {
    const canonical = sources
        .map(s => `${s.kind}:${s.id}`)
        .sort()
        .join('|');
    return sha256(canonical).slice(0, 32);  // 16 hex chars is sufficient
}
```

### 4.3 When does a new recipe get created?

| What changes | Effect on recipe | Effect on existing nodes |
|---|---|---|
| Analyzer code updated (new `version_id`) | New recipe → new nodes | Old nodes remain, queries filter by latest version |
| Config parameters changed (new `config_version_id`) | New recipe → new nodes | Old nodes remain |
| Prompt text changed (new `prompt_version_id`) | Prompt is part of config → new recipe | Old nodes remain |
| Model changed | No recipe change (model is not in recipe) | Same nodes are valid; model is metadata on `analysis_run` |
| New messages synced | New source refs → new source_set_hash for those units | Old units keep their hash, new units get analyzed |
| Analyzer re-run with same recipe | Idempotency check finds existing node → skip | No new nodes |

---

## 5. Isolation model

### 5.1 Visibility rule

An analyzer with `def.id = X` and `def.dependencies = ["A", "B"]` can see:

1. **Conversation data** — all messages and sessions (always readable)
2. **Own nodes** — `analysis_nodes WHERE analyzer_id = X`
3. **Dependency nodes** — `analysis_nodes WHERE analyzer_id IN ('A', 'B')`

It CANNOT see:
- Nodes from analyzer `C` (not in dependencies)
- Nodes from other versions of itself (only current version)
- Internal state of dependency analyzers (only their output nodes)

### 5.2 Enforcement

The framework enforces this in two places:

1. **`AnalyzerPlanContext`** — `dependencyNodes` only includes declared dependencies
2. **`AnalyzerRunContext`** — `getDependencyNodes(analyzerId)` validates against declared dependencies

If an analyzer is later run as a Pi sub-agent, the tool wrappers filter `analysis_nodes` queries by the same visibility rules.

---

## 6. Analyzer 1: `turn-pair-core`

### 6.1 Identity

```
id:             "turn-pair-core"
label:          "Per-Turn Sentiment & Friction"
anchor_span:    "pair"
dependencies:   []
```

### 6.2 Scope

A single user message + the assistant response(s) that follow, up to the next user message. This is the minimal analysis unit.

### 6.3 What it does (deterministic — always runs, no LLM)

| Property | Type | Source |
|---|---|---|
| `user_msg_length` | integer | `len(user_msg.content_text)` |
| `assistant_msg_length` | integer | `len(assistant_msg.content_text)` |
| `has_thinking` | boolean | `assistant_msg.content_thinking != null` |
| `thinking_length` | integer | `len(assistant_msg.content_thinking) \|\| 0` |
| `correction_detected` | boolean | regex match on user message |
| `correction_patterns` | string[] | which patterns matched |
| `correction_type` | string \| null | `'explicit' \| 'implicit' \| 'repetition' \| null` |
| `tool_count` | integer | number of tool calls in assistant response |
| `tool_names` | string[] | names of tools called |
| `tool_failure_count` | integer | tool results with `is_error = true` |
| `tool_failure_details` | object[] | `[{tool_name, error_preview}]` |
| `tool_waste_bytes` | integer | bytes of tool results never referenced in subsequent text |
| `retry_detected` | boolean | same tool called 2+ times on same target |
| `elapsed_seconds` | float \| null | time between user and assistant timestamps |
| `model` | string \| null | model that produced assistant response |
| `usage_input_tokens` | integer \| null | from assistant response |
| `usage_output_tokens` | integer \| null | from assistant response |
| `stop_reason` | string \| null | from assistant response |
| `is_compaction_boundary` | boolean | true if any message in the pair is a compactionSummary |

**Correction detection patterns (deterministic, no LLM):**

```typescript
const CORRECTION_STRONG: RegExp[] = [
    /\bno[,.\s]/i,
    /\bnot (that|like|quite|exactly)\b/i,
    /\bwrong\b/i,
    /\bactually[,.\s]/i,
    /\bI (said|told|mentioned|asked)\b/i,
    /\bdon'?t (do|use|run|write|create)\b/i,
    /\b(should|need|must) (be|use|have)\b/i,
    /\b(instead|rather)\b/i,
    /\bthat'?s not (right|correct|what I)\b/i,
];

const CORRECTION_WEAK: RegExp[] = [
    /\bwait\b/i,
    /\bhm+\b/i,
    /\b(still|yet)\b/i,
];

const CORRECTION_NEGATIVE: RegExp[] = [
    /\bno worries\b/i,
    /\blooks? good\b/i,
    /\bthat'?s (great|fine|correct|right|perfect)\b/i,
    /\b(thanks|thank you)\b/i,
];
```

### 6.4 What it does (LLM enrichment — optional, on demand)

Run only on pairs where `correction_detected = true` or `elapsed_seconds > 60`.

| Property | Type | Source |
|---|---|---|
| `sentiment` | string | LLM: `'positive' \| 'neutral' \| 'negative' \| 'frustrated'` |
| `friction_type` | string \| null | LLM: `'misunderstanding' \| 'tool_failure' \| 'wrong_approach' \| 'slow_response' \| 'missing_context' \| 'incorrect_output' \| null` |
| `friction_summary` | string \| null | LLM: 1–2 sentence description |
| `user_intent` | string | LLM: what the user was trying to accomplish |
| `quality_score` | integer | LLM: 1–5 |

**Prompt** (stored in `prompt_versions`):

```
You analyze a single exchange between a user and an AI coding agent.

USER MESSAGE:
{user_text}

AGENT RESPONSE:
{assistant_text}

{tool_results_section}

Classify this exchange. Respond with JSON only:
{
  "sentiment": "positive" | "neutral" | "negative" | "frustrated",
  "friction_type": "misunderstanding" | "tool_failure" | "wrong_approach" | "slow_response" | "missing_context" | "incorrect_output" | null,
  "friction_summary": "<1-2 sentence description, or null>",
  "user_intent": "<1 sentence: what the user was trying to accomplish>",
  "quality_score": <1-5: how well the assistant served the user's intent>
}
```

### 6.5 Plan logic

```typescript
plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
    const units: AnalysisUnit[] = [];
    const messages = ctx.messages;

    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'user') continue;

        // Find the assistant response and any tool results
        let j = i + 1;
        while (j < messages.length && messages[j].role !== 'user') j++;
        if (j <= i) continue;  // no response found

        const sources: SourceRef[] = [
            { kind: 'message', id: messages[i].id },  // user
        ];

        // Include all messages between user message i and next user message
        for (let k = i; k < j && k < messages.length; k++) {
            sources.push({ kind: 'message', id: messages[k].id });
        }

        units.push({ sources, sourceSetHash: computeSourceSetHash(sources) });
    }

    return units;
}
```

### 6.6 Parallelism

Each pair is independent. The framework can run `analyze()` calls concurrently with a configurable concurrency limit (default: 5).

For LLM enrichment, multiple pairs can be batched into a single LLM call (5–10 pairs per call) to reduce overhead.

---

## 7. Analyzer 2: `session-compact-v1`

### 7.1 Identity

```
id:             "session-compact-v1"
label:          "Session-Level Compaction Analysis"
anchor_span:    "full_session"
dependencies:  ["turn-pair-core"]
```

### 7.2 Scope

One node per session. Consumes all `turn-pair-core` nodes for the session, plus compaction summaries and recent raw messages.

### 7.3 Compression strategy

For sessions that fit in the model's context window:

```
Structured digest → LLM → one analysis node
```

For sessions that exceed the model's context window (map-reduce):

```
Phase 1: Build structured digest from turn-pair nodes + message metadata + compaction summaries
Phase 2: If digest > context budget, split into overlapping segments
Phase 3: Map — summarize each segment with cheap model
Phase 4: Reduce — combine segment summaries into final analysis with mid-range model
```

The digest format (not truncation):

```markdown
## Session: project-name, 2026-05-29, 47 min, 12 pairs

### Compaction Summary (verbatim from session)
The user was working on auth module refactoring. They had several corrections about function names...

### Per-Pair Summary (from turn-pair-core nodes)
| # | Time    | Sentiment | Friction | Correction | Tools |
|---|---------|----------|----------|------------|-------|
| 1 | 14:02   | neutral  | none     | —          | read  |
| 2 | 14:08   | frustrated | wrong_approach | "wrong function" | read, edit |
| 3 | 14:15   | neutral  | none     | —          | bash  |
...

### Key Events (post-compaction messages, full detail)
[14:23] USER: "actually, I said use pnpm not npm"
[14:24] AGENT: reads package.json (2KB), runs pnpm install
[14:25] USER: "no, the dev script, not install"
...

### Statistics (deterministic, from turn-pair-core aggregation)
- Total pairs: 12, friction pairs: 3, correction rate: 0.25
- Tool failures: 2 (edit mismatch, bash exit 1)
- Tool waste: 45KB total (2 reads never referenced)
- Models: anthropic/claude-sonnet-4-5 (10 pairs), anthropic/claude-haiku-3 (2 pairs)
```

This is typically 5–15% of the original session size. For very long sessions, it further compresses via the map-reduce phases above.

### 7.4 Content schema

```typescript
interface SessionCompactProperties {
    // ── Aggregated from turn-pair-core (deterministic, no LLM) ──
    total_pairs: number;
    friction_pairs: number;
    correction_count: number;
    avg_quality_score: number | null;     // null if no LLM enrichment
    dominant_friction_type: string | null;
    tool_failure_rate: number;            // fraction of pairs with tool failures
    total_tool_waste_bytes: number;
    session_duration_seconds: number | null;

    // ── LLM-produced (mid-range model) ──
    session_summary: string;              // 3–5 sentence summary
    key_friction_points: Array<{
        description: string;
        pair_node_id: string;            // reference to turn-pair analysis node
        severity: 'low' | 'medium' | 'high';
    }>;
    improvement_proposals: Array<{
        target_type: 'agents_md' | 'system_md' | 'skill' | 'extension_prompt' | 'tool_output' | 'repo_doc' | 'config';
        target_path: string;
        title: string;
        summary: string;
        detail: string;
        evidence: string;
        confidence: number;               // 0.0–1.0
        severity: 'friction' | 'correction' | 'waste' | 'suggestion' | 'insight';
    }>;
    sentiment_arc: Array<{               // sentiment over time
        segment: number;                 // 0-based segment index
        sentiment: string;
        key_event: string;
    }>;
}
```

### 7.5 Plan logic

```typescript
plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
    const pairNodes = ctx.dependencyNodes['turn-pair-core'];
    if (pairNodes.length === 0) return []; // dependency hasn't run yet

    const sources: SourceRef[] = [
        { kind: 'session', id: ctx.sessionId },
        ...pairNodes.map(n => ({ kind: 'analysis_node' as const, id: n.id })),
    ];

    return [{ sources, sourceSetHash: computeSourceSetHash(sources) }];
}
```

### 7.6 Analyze logic (pseudocode)

```typescript
async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
    const pairNodes = unit.sources
        .filter(s => s.kind === 'analysis_node')
        .map(s => ctx.getNode(s.id)!);

    const pairProperties = pairNodes.map(n => JSON.parse(n.content_json));

    // Phase 1: Aggregate deterministic stats
    const stats = aggregatePairStats(pairProperties);

    // Phase 2: Build structured digest
    const digest = buildSessionDigest(pairNodes, pairProperties, ctx);

    // Phase 3: Compress if needed (map-reduce)
    const compressed = await compressIfNeeded(digest, ctx);

    // Phase 4: Generate analysis with LLM
    const llmResult = await ctx.llm({
        model: ctx.config.configJson.mid_model || 'anthropic/claude-sonnet-4-5',
        messages: [
            { role: 'system', content: SESSION_COMPACT_PROMPT },
            { role: 'user', content: compressed },
        ],
        schema: SESSION_COMPACT_SCHEMA,
    });

    // Phase 5: Combine deterministic + LLM results
    const content = { ...stats, ...llmResult.parsed };

    // Phase 6: Materialize proposals
    const edges: Edge[] = [
        { toRefKind: 'session', toRefId: ctx.sessionId, edgeKind: 'anchors' },
        ...pairNodes.map((n, i) => ({
            toRefKind: 'analysis_node' as const,
            toRefId: n.id,
            edgeKind: 'consumes' as const,
            ordinal: i,
        })),
        { toRefKind: 'prompt_version', toRefId: ctx.prompts['reduce'].id, edgeKind: 'uses_prompt' },
    ];

    return {
        contentJson: content,
        nodeKind: 'summary',
        anchorKind: 'session',
        anchorRef: ctx.sessionId,
        edges,
        modelUsed: llmResult.model,
        costUsd: llmResult.cost,
        tokensUsed: llmResult.tokens,
        durationMs: llmResult.durationMs,
    };
}
```

---

## 8. Proposal materialization

### 8.1 Flow

After `session-compact-v1` (or any future proposal-generating analyzer) produces a node with `node_kind = 'proposal'`:

1. Framework extracts `improvement_proposals` from `content_json`
2. For each proposal:
   a. Compute `dedup_key = SHA-256(target_type + target_path + severity + normalize(title))`
   b. Check if an `open` proposal with this `dedup_key` exists
   c. If yes → mark new proposal node's content with `duplicate_of: existing_proposal_id` and set proposal status to `duplicate`
   d. If no → INSERT into `proposals` and create an analysis edge from the proposal node to the proposal

### 8.2 Deduplication

The `dedup_key` normalizes away trivial differences:
- lowercase
- strip articles
- collapse whitespace
- trim to 200 chars

This means "Add rule to always use pnpm" and "Add a rule: always use pnpm" produce the same dedup key.

---

## 9. Model tiers

```typescript
interface AnalyzerModelConfig {
    cheap: string;       // e.g. 'anthropic/claude-haiku-3' or 'google/gemini-2.0-flash'
    mid: string;         // e.g. 'anthropic/claude-sonnet-4-5'
    expensive: string;  // e.g. 'anthropic/claude-opus-4' (rarely used)
}
```

Analyzers request tiers, not specific models. The config resolves to actual model strings.

Changing the `mid` model does NOT invalidate analysis nodes — model choice is metadata on the run, not part of the recipe.

---

## 10. Incremental run lifecycle

### 10.1 Incremental sync + analysis schedule

```
Every minute (or on demand):
  1. runSync()                    — sync new/changed session files into DB
  2. For each registered analyzer, in dependency order:
     a. For each session with new messages since last run:
        - runAnalyzer(analyzer, session, config)
          - plan() → get all candidate units
          - filter by idempotency → skip existing
          - analyze() remaining units
          - materialize proposals
```

### 10.2 Dependency ordering

The framework runs analyzers in topological order based on `dependencies`:

```
turn-pair-core (no deps) → runs first
session-compact-v1 (depends on turn-pair-core) → runs after turn-pair-core completes
```

### 10.3 Progress tracking

After each analyzer run on a session, `analysis_progress` is updated:

```sql
INSERT OR REPLACE INTO analysis_progress
(analyzer_id, analyzer_version_id, config_version_id, session_id,
 cursor_json, last_run_id, status, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 'ok', datetime('now'));
```

On the next incremental run, the framework uses `cursor_json` to determine which messages are new since the last run.

For `turn-pair-core`, the cursor stores `{"last_message_rowid": <number>}`. Only messages with `rowid > last_message_rowid` need new pairs.

For `session-compact-v1`, the cursor stores `{"needs_rerun": true}` if any new `turn-pair-core` nodes appeared for this session since the last run.

---

## 11. Versioning and meta-analysis

### 11.1 Prompt versioning

When an analyzer is registered, all its prompts are stored in `prompt_versions`:

```typescript
function storePrompt(db: Database, prompt: PromptVersion): string {
    // Content-addressed: INSERT OR IGNORE ensures no duplicates
    db.prepare(`
        INSERT OR IGNORE INTO prompt_versions (id, content, content_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(prompt.id, prompt.content, prompt.contentHash, prompt.role, new Date().toISOString());
    return prompt.id;
}
```

### 11.2 Meta-analysis

Because every node links to its prompt version, config version, and analyzer version through the run:

```sql
-- Which prompt versions produced the most proposals?
SELECT pv.role, pv.content_hash, COUNT(*) as proposal_count
FROM analysis_nodes an
JOIN analysis_runs ar ON an.run_id = ar.id
JOIN analysis_edges ae ON ae.from_node_id = an.id AND ae.edge_kind = 'uses_prompt'
JOIN prompt_versions pv ON ae.to_ref_id = pv.id
WHERE an.node_kind = 'proposal'
GROUP BY pv.id
ORDER BY proposal_count DESC;

-- Did a config change improve friction detection?
SELECT ar.config_version_id, AVG(CAST(an.content_json->>'$.correction_detected' AS REAL)) as avg_correction
FROM analysis_nodes an
JOIN analysis_runs ar ON an.run_id = ar.id
WHERE an.analyzer_id = 'turn-pair-core'
GROUP BY ar.config_version_id;

-- Which sessions had the most friction?
SELECT s.session_id, COUNT(*) as friction_count
FROM analysis_nodes an
JOIN sessions s ON an.session_id = s.id
WHERE an.analyzer_id = 'turn-pair-core'
  AND an.content_json->>'$.correction_detected' = 'true'
GROUP BY s.session_id
ORDER BY friction_count DESC
LIMIT 10;
```

---

## 12. Handling compaction

Pi sessions contain `compactionSummary` entries:

```json
{"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"compactionSummary","summary":"...","tokensBefore":12345}}
```

The sync/parser already handles these. For analysis:

- **turn-pair-core**: does NOT create pairs for compactionSummary entries (they have no user message). When a pair spans a compaction boundary, `is_compaction_boundary: true` is set in the properties.
- **session-compact-v1**: includes compaction summary text as the compressed pre-compaction context. The structured digest includes them verbatim, preserving more context than naive truncation.

---

## 13. What NOT to build in v1

1. **Pi sub-agent execution engine** — Use in-process TypeScript analyzers with direct `pi-ai` calls. The `implementation_kind = 'pi_subagent'` field exists for future use but should not be implemented now.

2. **Eager supersession of old analyzer versions** — Old nodes remain in the graph. Queries filter by `(analyzer_id, analyzer_version_id)` to see only current results. A future `/prospect-gc` command can optionally archive old-version nodes.

3. **Per-model invalidation** — Model changes do NOT invalidate analysis. Model is metadata on the run, not part of the recipe.

4. **Complex dependency version resolution** — Dependencies resolve to "latest successful version" for MVP. Pinned versions can be added later.

5. **Cross-session meta-analyzer** — Focus on per-session analysis first. A `cross-session-patterns` analyzer that reads proposal nodes across sessions can be built as analyzer v3.

6. **Target file auto-discovery** — The first analyzer should propose improvements targeting known categories (`AGENTS.md`, `SKILL.md`, etc.). Scanning `~/.pi/` to discover all config targets is a future enhancement.

---

## 14. File structure for initial analyzers

```
src/
├── analyze/
│   ├── framework.ts              — AnalyzerFramework class: register, run, runAll, idempotency, deps
│   ├── types.ts                  — All TypeScript interfaces from §3
│   ├── input-hash.ts             — computeSourceSetHash, computePromptBundleHash
│   ├── edge-kinds.ts             — Edge kind constants and validation
│   ├── proposal-materializer.ts  — Extract proposals from analysis nodes, dedup, insert
│   ├── analyzers/
│   │   ├── turn-pair-core.ts      — Analyzer implementation (deterministic + optional LLM)
│   │   ├── turn-pair-core/
│   │   │   ├── patterns.ts        — Correction/frustration regex patterns
│   │   │   ├── deterministic.ts    — Tier 0 computation
│   │   │   ├── llm-enrich.ts      — Tier 1 LLM enrichment
│   │   │   └── prompt.ts          — LLM prompt template + schema
│   │   └── session-compact-v1/
│   │       ├── index.ts            — Analyzer implementation
│   │       ├── digest.ts           — Build structured session digest
│   │       ├── compress.ts         — Map-reduce compression for large sessions
│   │       └── prompt.ts          — LLM prompts + schemas (map, reduce, classify)
├── db/
│   ├── schema.ts                 — Existing + new tables (migrations 002+)
│   ├── queries.ts                — Existing + new query functions
│   └── analysis-queries.ts       — Queries for analysis_nodes, edges, runs, progress
├── commands/
│   ├── sync.ts                   — Existing (updated to trigger analyzers after sync)
│   ├── analyze.ts                — Updated: now uses framework
│   └── proposals.ts               — Updated: reads from proposals table + analysis_nodes
```

---

## 15. Summary: key differences from earlier drafts

| Aspect | DESIGN-analyzers.md | analyzer-design.md | analyzer-framework.md | This design |
|---|---|---|---|---|
| Analysis model | Nodes with typed edges | Nodes on message anchors | Nodes in tree shape | Nodes with **explicit graph edges** |
| Source tracking | `node_sources` join table | `source_ids` JSON array | `source_ids` JSON array | `analysis_edges` **join table** |
| Run provenance | Not modeled | Not modeled | `analysis_progress` only | **`analysis_runs` table** |
| Config versioning | Not separate | Not separate | Not separate | **Separate `analyzer_config_versions`** |
| Prompt versioning | `prompt_versions` table | Inline in `analyzers` | `prompt_registry` table | **`prompt_versions` table** (content-addressed) |
| Idempotency key | `(analyzer, version, prompt_hash, source_hash)` | `(analyzer, source_type, source_id, prompt_version)` | `input_hash` (includes version+prompt+anchor+content) | **(analyzer, version, config, source_set_hash)** |
| Analyzer interface | `plan()` + `analyze()` | `analyze(sources, deps)` | `analyze(sources, deps)` | **`plan()` + `analyze()`** |
| Proposal handling | In `analysis_nodes.properties` | Derived from nodes → `proposals` table | In `analysis_nodes.properties` | **Analysis node + separate `proposals` table** |
| Dependency visibility | Framework-enforced | Declared in schema | Declared, framework-enforced | **Declared, framework-enforced** |
| Compaction handling | Mentioned | Explicit strategy | Detailed map-reduce | **Compaction-aware digest + map-reduce** |
| Sub-agent model | `pi -p` or `completeSimple()` | TBD | TBD | **In-process first, sub-agent later** |

This design preserves the best ideas from all three drafts (graph model from analyzer-framework, plan/analyze split from DESIGN-analyzers, proposal materialization from analyzer-design) while adding the explicit graph edges, analysis_runs, and config versioning that were missing.