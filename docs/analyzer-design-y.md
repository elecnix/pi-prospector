# pi-prospector Analyzer Framework — Final Design

## 1. Overview

The analyzer framework extends pi-prospector's session index with an **append-only analysis graph** grafted onto the conversation tree. Every analysis artifact is versioned, idempotent, and traceable back to the exact analyzer code, prompt, and configuration that produced it. Proposals are materialized from analysis nodes into a fast-access table with deduplication.

```
Conversation graph (read-only, synced from Pi sessions):
  msg_1 → msg_2 → msg_3 → [compaction] → msg_4 → msg_5

Analysis graph (append-only, produced by analyzers):
  msg_3 ←── pair-friction node (deterministic metric)
           ←── pair-friction-llm node (LLM classification, depends on pair-friction)
  session ←── session-overview node (summary + proposals, depends on both)
                 └── materialized into proposals table
```

### Core principles

1. **Append-only** — analysis nodes are never mutated. New analyzer versions or config changes produce new nodes; old ones persist for auditability and meta-analysis.
2. **Grafted graph** — analysis nodes anchor to conversation messages and link to each other via typed edges, enabling navigation from any leaf to any root.
3. **Idempotent** — a node's `(analyzer_id, version, config_id, source_set_hash)` uniquely identifies it. Re-running with the same inputs is a no-op.
4. **Incremental** — cursors track progress per (analyzer, version, config, session). Only new messages trigger analysis.
5. **Crash-recoverable** — re-running after a crash picks up where it left off.
6. **Versioned provenance** — every node traces to the exact analyzer version, prompt hash, and config version that produced it.
7. **Dependency-scoped visibility** — an analyzer sees only its own nodes, conversation data, and nodes from declared dependencies.
8. **Deterministic first, LLM optional** — Tier 0 (deterministic, free) always runs. Tier 1 (cheap LLM) runs only on flagged entries. Tier 2 (mid LLM) runs on aggregated data.

---

## 2. Schema

### 2.1 `analyzer_defs` — stable logical identity

One row per analyzer, regardless of version. Never deleted.

```sql
CREATE TABLE IF NOT EXISTS analyzer_defs (
    id              TEXT PRIMARY KEY,           -- 'pair-friction', 'session-overview'
    label           TEXT NOT NULL,              -- 'Per-Turn Sentiment & Friction'
    description     TEXT,
    anchor_span     TEXT NOT NULL,             -- 'pair' | 'segment' | 'full_session'
    dependencies    TEXT NOT NULL DEFAULT '[]', -- JSON array of analyzer_def ids
    created_at      TEXT NOT NULL
);
```

### 2.2 `analyzer_versions` — one row per code release

```sql
CREATE TABLE IF NOT EXISTS analyzer_versions (
    analyzer_id         TEXT NOT NULL,
    version_id          TEXT NOT NULL,          -- git commit SHA or semver
    implementation_kind TEXT NOT NULL,          -- 'deterministic' | 'in_process_llm' | 'pi_subagent'
    code_ref            TEXT,                   -- git commit, npm version, or extension path
    created_at          TEXT NOT NULL,
    PRIMARY KEY (analyzer_id, version_id),
    FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
);
```

### 2.3 `prompt_versions` — content-addressed prompt store

Identical prompts across analyzer versions share a single row.

```sql
CREATE TABLE IF NOT EXISTS prompt_versions (
    id              TEXT PRIMARY KEY,          -- first 16 hex chars of SHA-256(content)
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL UNIQUE,      -- full SHA-256 for verification
    role            TEXT,                      -- 'classify' | 'map' | 'reduce' | null
    created_at      TEXT NOT NULL
);
```

### 2.4 `analyzer_config_versions` — version-tracked configuration

Every change to an analyzer's parameters produces a new row. Referenced from `analysis_nodes` and `analysis_runs`.

```sql
CREATE TABLE IF NOT EXISTS analyzer_config_versions (
    id              TEXT PRIMARY KEY,          -- UUID v7
    analyzer_id     TEXT NOT NULL,
    config_hash     TEXT NOT NULL UNIQUE,      -- SHA-256 of JSON-serialized config
    config_json     TEXT NOT NULL,             -- the full config object
    label           TEXT,                      -- 'default', 'sensitive', 'aggressive'
    created_at      TEXT NOT NULL,
    FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
);
```

### 2.5 `analysis_runs` — execution provenance

One row per attempted execution of an analyzer on a session. Essential for cost tracking, debugging, and crash recovery.

```sql
CREATE TABLE IF NOT EXISTS analysis_runs (
    id                  TEXT PRIMARY KEY,
    analyzer_id         TEXT NOT NULL,
    analyzer_version_id TEXT NOT NULL,
    config_id           TEXT NOT NULL,
    prompt_bundle_hash  TEXT NOT NULL,         -- SHA-256 of all prompt IDs used
    session_id          TEXT NOT NULL,

    status              TEXT NOT NULL DEFAULT 'planned', -- 'planned'|'running'|'ok'|'error'|'partial'
    started_at          TEXT NOT NULL,
    finished_at         TEXT,
    model_spec          TEXT,                  -- resolved model string
    cost_usd            REAL DEFAULT 0,
    tokens_used         INTEGER DEFAULT 0,
    nodes_produced      INTEGER DEFAULT 0,
    nodes_skipped       INTEGER DEFAULT 0,
    error_message       TEXT,

    FOREIGN KEY (analyzer_id, analyzer_version_id) REFERENCES analyzer_versions(analyzer_id, version_id),
    FOREIGN KEY (config_id) REFERENCES analyzer_config_versions(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON analysis_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON analysis_runs(status);
```

### 2.6 `analysis_nodes` — append-only artifact store

Every analysis artifact ever produced. No `UPDATE` or `DELETE` after insert.

```sql
CREATE TABLE IF NOT EXISTS analysis_nodes (
    id                  TEXT PRIMARY KEY,           -- UUID v7 (time-sortable)
    session_id          TEXT NOT NULL,
    run_id              TEXT NOT NULL,              -- FK to analysis_runs

    -- Identity
    analyzer_id         TEXT NOT NULL,
    analyzer_version_id TEXT NOT NULL,
    config_id           TEXT NOT NULL,
    prompt_bundle_hash  TEXT NOT NULL,

    -- Graph structure
    parent_id           TEXT,                      -- parent in analysis tree (NULL = root)
    anchor_entry_id     TEXT,                      -- conversation message.id (NULL = session-level)
    anchor_span         TEXT NOT NULL,              -- 'pair' | 'segment' | 'full_session'

    -- Content
    node_kind           TEXT NOT NULL,              -- 'metric' | 'classification' | 'summary' | 'proposal' | 'error'
    content_json        TEXT NOT NULL,              -- structured JSON payload (schema varies by analyzer)

    -- Provenance & idempotency
    source_set_hash     TEXT NOT NULL,              -- SHA-256 of sorted source refs

    -- Metadata
    created_at          TEXT NOT NULL,
    cost_usd            REAL DEFAULT 0,
    tokens_used         INTEGER DEFAULT 0,
    model_used          TEXT,
    duration_ms         INTEGER,

    FOREIGN KEY (run_id) REFERENCES analysis_runs(id),
    FOREIGN KEY (analyzer_id, analyzer_version_id) REFERENCES analyzer_versions(analyzer_id, version_id),
    FOREIGN KEY (config_id) REFERENCES analyzer_config_versions(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_session     ON analysis_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_analyzer    ON analysis_nodes(analyzer_id, analyzer_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_anchor      ON analysis_nodes(anchor_entry_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent      ON analysis_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind        ON analysis_nodes(node_kind);
CREATE INDEX IF NOT EXISTS idx_nodes_run         ON analysis_nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_nodes_idempotency ON analysis_nodes(
    analyzer_id, analyzer_version_id, config_id, source_set_hash
);
```

### 2.7 `analysis_edges` — typed graph relationships

A single table that makes this a real graph, not just a tree. Every relationship is explicit and queryable.

```sql
CREATE TABLE IF NOT EXISTS analysis_edges (
    from_node_id    TEXT NOT NULL,           -- the analysis node that holds this relationship
    to_ref_kind     TEXT NOT NULL,           -- 'message' | 'analysis_node' | 'session' | 'prompt_version' | 'config_version'
    to_ref_id       TEXT NOT NULL,           -- id of the referenced entity
    edge_kind       TEXT NOT NULL,           -- 'anchors' | 'consumes' | 'uses_prompt' | 'uses_config' | 'produces'
    ordinal         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal),
    FOREIGN KEY (from_node_id) REFERENCES analysis_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_edges_from   ON analysis_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to     ON analysis_edges(to_ref_kind, to_ref_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind    ON analysis_edges(edge_kind);
```

**Edge kind taxonomy:**

| Edge kind | Meaning | from | to |
|-----------|---------|------|----|
| `anchors` | This node is about this conversation entity | analysis_node | message, session |
| `consumes` | This node used this as input | analysis_node | analysis_node, message |
| `uses_prompt` | This run used this prompt version | analysis_node | prompt_version |
| `uses_config` | This run used this config version | analysis_node | config_version |
| `produces` | This node produced this proposal | analysis_node | (proposal extracted from content) |

### 2.8 `analysis_progress` — incremental cursor

```sql
CREATE TABLE IF NOT EXISTS analysis_progress (
    analyzer_id         TEXT NOT NULL,
    analyzer_version_id TEXT NOT NULL,
    config_id           TEXT NOT NULL,
    session_id          TEXT NOT NULL,

    cursor_json         TEXT,               -- analyzer-defined: {"last_message_rowid": 452, "last_pair_index": 17}
    last_run_id          TEXT,
    status              TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'in_progress' | 'error' | 'needs_rerun'
    error_message       TEXT,
    updated_at          TEXT NOT NULL,

    PRIMARY KEY (analyzer_id, analyzer_version_id, config_id, session_id),
    FOREIGN KEY (analyzer_id, analyzer_version_id) REFERENCES analyzer_versions(analyzer_id, version_id),
    FOREIGN KEY (config_id) REFERENCES analyzer_config_versions(id)
);
```

### 2.9 `proposals` — fast-access materialized view

Derived from `analysis_nodes` where `node_kind` contains improvement proposals. Kept in sync by the framework after each run.

```sql
CREATE TABLE IF NOT EXISTS proposals (
    id                  TEXT PRIMARY KEY,
    analysis_node_id    TEXT NOT NULL UNIQUE,  -- 1:1 with source analysis node

    session_id          TEXT NOT NULL,
    analyzer_id         TEXT NOT NULL,

    target_type         TEXT NOT NULL,    -- 'agents_md' | 'system_md' | 'skill' | 'extension_prompt' | 'tool_output' | 'repo_doc' | 'config'
    target_path         TEXT,             -- e.g. '~/.pi/agent/AGENTS.md'
    title               TEXT NOT NULL,
    summary             TEXT NOT NULL,
    detail              TEXT,             -- proposed edit text or detailed explanation
    evidence_json        TEXT,             -- JSON array of message/node references and excerpts
    confidence          REAL,             -- 0.0-1.0
    severity            TEXT NOT NULL,     -- 'friction' | 'correction' | 'waste' | 'suggestion' | 'insight'
    dedup_key           TEXT NOT NULL,    -- SHA-256(target_type + target_path + severity + normalize(title))

    status              TEXT NOT NULL DEFAULT 'open', -- 'open' | 'accepted' | 'applied' | 'rejected' | 'duplicate'
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

---

## 3. Idempotency model

### 3.1 Recipe

A node is uniquely identified by:

```
(analyzer_id, analyzer_version_id, config_id, source_set_hash)
```

Where `source_set_hash = SHA-256(sorted("kind:id" for each source ref).join("|"))`.

Before producing a node, the framework checks:

```sql
SELECT id FROM analysis_nodes
WHERE analyzer_id = ?
  AND analyzer_version_id = ?
  AND config_id = ?
  AND source_set_hash = ?
```

If a row exists → skip (already computed).

### 3.2 When does a new recipe get created?

| What changes | Effect on recipe | Effect on existing nodes |
|---|---|---|
| Analyzer code updated (new `version_id`) | New recipe → new nodes | Old nodes remain |
| Config parameters changed (new `config_id`) | New recipe → new nodes | Old nodes remain |
| Prompt text changed (new `prompt_version_id`) | New `prompt_bundle_hash` → new run, but config_id doesn't change → idempotency key doesn't include prompt directly | Existing nodes are valid; new runs use new prompts |
| Model changed | No recipe change (model is metadata on `analysis_runs`) | Same nodes are valid |
| New messages synced | New source refs → new `source_set_hash` for those units | Old units keep their hash |
| Analyzer re-run with same recipe | Idempotency check finds existing node → skip | No new nodes |

### 3.3 Prompt hashes and idempotency

Prompts are part of the run (`prompt_bundle_hash` on `analysis_runs`) but NOT part of the node idempotency key. Rationale: prompts are implementation details of the analyzer code. If the same analyzer version with the same config produces a node, the prompt is implicit in the version. Changing the prompt without changing the version is a code change that should bump the version.

If you want prompt-level idempotency (re-analyze only when the prompt changes), bump the analyzer version — the framework handles it automatically.

---

## 4. Analyzer interface

```typescript
export interface AnalyzerDef {
    id: string;                   // 'pair-friction', 'session-overview'
    label: string;
    description: string;
    anchorSpan: 'pair' | 'segment' | 'full_session';
    dependencies: string[];       // analyzer_def ids
}

export interface AnalyzerVersion {
    analyzerId: string;
    versionId: string;             // git commit SHA
    implementationKind: 'deterministic' | 'in_process_llm' | 'pi_subagent';
    codeRef?: string;
}

export interface AnalyzerConfig {
    id: string;                   // from analyzer_config_versions
    analyzerId: string;
    configJson: Record<string, unknown>;
    configHash: string;
    label?: string;
}

export interface PromptVersion {
    id: string;                   // content hash prefix
    content: string;
    contentHash: string;           // full SHA-256
    role?: string;                 // 'classify' | 'map' | 'reduce' | 'verify'
}

export interface AnalysisUnit {
    sources: SourceRef[];
    sourceSetHash: string;
    anchorKind: 'message' | 'pair' | 'segment' | 'session' | 'analysis_node' | 'none';
    anchorRef?: string;            // message.id or session.id
    meta?: Record<string, unknown>;
}

export interface SourceRef {
    kind: 'message' | 'analysis_node' | 'session';
    id: string;
}

export interface AnalysisResult {
    contentJson: Record<string, unknown>;
    nodeKind: 'metric' | 'classification' | 'summary' | 'proposal' | 'error';
    anchorKind: 'message' | 'pair' | 'segment' | 'session' | 'analysis_node' | 'none';
    anchorRef?: string;
    edges: Array<{
        toRefKind: SourceRef['kind'] | 'prompt_version' | 'config_version';
        toRefId: string;
        edgeKind: 'anchors' | 'consumes' | 'uses_prompt' | 'uses_config';
        ordinal?: number;
    }>;
    modelUsed?: string;
    costUsd?: number;
    tokensUsed?: number;
    durationMs?: number;
}

export interface Analyzer {
    def: AnalyzerDef;
    version: AnalyzerVersion;
    defaultConfig: AnalyzerConfig;
    prompts: Record<string, PromptVersion>;

    plan(ctx: PlanContext): Promise<AnalysisUnit[]>;
    analyze(unit: AnalysisUnit, ctx: RunContext): Promise<AnalysisResult>;
}

export interface PlanContext {
    sessionId: string;
    messages: MessageRow[];
    allNodes: AnalysisNodeRow[];
    ownNodes: AnalysisNodeRow[];
    dependencyNodes: Record<string, AnalysisNodeRow[]>;
    progress: ProgressRow | null;
    db: Database;
}

export interface RunContext {
    getMessage(id: string): MessageRow | undefined;
    getNode(id: string): AnalysisNodeRow | undefined;
    getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
    llm(request: LLMRequest): Promise<LLMResponse>;
    run: RunRow;
    config: AnalyzerConfig;
    prompts: Record<string, string>;  // pre-resolved prompt texts, keyed by role
}

export interface LLMRequest {
    modelTier: 'cheap' | 'mid' | 'expensive';
    messages: Array<{ role: string; content: string }>;
    schema?: Record<string, unknown>;
}
```

---

## 5. Execution flow

```
runAnalyzer(analyzer, sessionId, config)

  1. Register analyzer_def + analyzer_version (INSERT OR IGNORE)
  2. Store prompts in prompt_versions (INSERT OR IGNORE)
  3. Resolve config → get or create analyzer_config_versions row
  4. Create analysis_run row (status = 'running')

  5. analyzer.plan(ctx) → AnalysisUnit[]
  6. For each unit:
     a. Compute source_set_hash
     b. Check idempotency:
        SELECT id FROM analysis_nodes
        WHERE analyzer_id = ? AND analyzer_version_id = ?
          AND config_id = ? AND source_set_hash = ?
     c. If exists → skip, increment nodes_skipped
     d. If not → call analyzer.analyze(unit, runCtx)
     e. INSERT INTO analysis_nodes
     f. INSERT INTO analysis_edges for each edge in result.edges
     g. If node_kind = 'proposal' → extract and upsert into proposals table
     h. Increment nodes_produced

  7. UPDATE analysis_run (status = 'ok', cost, tokens, nodes_produced, nodes_skipped)
  8. UPDATE analysis_progress (cursor, status = 'ok')

  9. Return { runId, nodesProduced, nodesSkipped, costUsd }
```

### Parallelism

For analyzers where each unit is independent (like `pair-friction`), the framework can run `analyze()` calls concurrently with a configurable concurrency limit. The `plan()` step is always serial.

### Crash recovery

- `analysis_run.status` stays `'running'` if the process crashes. On next invocation, the framework detects this and can either resume or start a fresh run.
- Analysis nodes already inserted are valid (append-only). The idempotency check will skip them.
- Missing nodes (between crash and last successful insert) will be re-produced.

---

## 6. Graph navigation

### Visual

```
msg_003 ←── an:AA01 (pair-friction, node_kind=metric)
         ←── an:AA02 (pair-friction-llm, node_kind=classification)
  an:AA01 ──consumes──→ msg_003
  an:AA02 ──consumes──→ an:AA01

msg_006 ←── an:BB01 (pair-friction, node_kind=metric)
  an:BB01 ──consumes──→ msg_006

session ──── an:CC01 (session-overview, node_kind=summary)
  an:CC01 ──consumes──→ an:AA01
  an:CC01 ──consumes──→ an:AA02
  an:CC01 ──consumes──→ an:BB01
  an:CC01 ──anchors──→ session_001

  an:CC01 ──produces──→ proposal "Add pnpm rule to AGENTS.md"
```

### Key queries

```sql
-- From a conversation message, find all analysis anchored to it
SELECT an.* FROM analysis_nodes an
JOIN analysis_edges e ON e.from_node_id = an.id
WHERE e.edge_kind = 'anchors'
  AND e.to_ref_kind = 'message'
  AND e.to_ref_id = 'msg_006';

-- Walk up the analysis tree (from any node to its ancestors)
WITH RECURSIVE analysis_path AS (
    SELECT * FROM analysis_nodes WHERE id = ?
    UNION ALL
    SELECT parent.* FROM analysis_nodes parent
    JOIN analysis_path child ON parent.id = child.parent_id
) SELECT * FROM analysis_path;

-- Find all nodes that consumed a given node
SELECT an.* FROM analysis_nodes an
JOIN analysis_edges e ON an.id = e.from_node_id
WHERE e.edge_kind = 'consumes'
  AND e.to_ref_kind = 'analysis_node'
  AND e.to_ref_id = 'an:AA01';

-- Trace a proposal back through its analysis provenance
WITH RECURSIVE provenance AS (
    -- Start from the proposal's source analysis node
    SELECT an.id, an.parent_id FROM analysis_nodes an
    WHERE an.id = (SELECT analysis_node_id FROM proposals WHERE id = ?)
    UNION ALL
    SELECT parent.id, parent.parent_id FROM analysis_nodes parent
    JOIN analysis_path child ON parent.id = child.parent_id
)
SELECT * FROM provenance;

-- Which sessions had the most friction?
SELECT s.id, COUNT(*) as friction_count
FROM analysis_nodes an
JOIN sessions s ON an.session_id = s.id
WHERE an.analyzer_id = 'pair-friction'
  AND json_extract(an.content_json, '$.correction_detected') = 1
GROUP BY s.id
ORDER BY friction_count DESC
LIMIT 10;

-- Did a config change improve correction detection?
SELECT cv.config_json, AVG(CAST(json_extract(an.content_json, '$.friction_score') AS REAL)) as avg_friction
FROM analysis_nodes an
JOIN analyzer_config_versions cv ON an.config_id = cv.id
WHERE an.analyzer_id = 'pair-friction'
GROUP BY cv.id;

-- Which analyzer version produced the most proposals?
SELECT av.version_id, COUNT(*) as proposal_count
FROM analysis_nodes an
JOIN analysis_runs ar ON an.run_id = ar.id
JOIN analyzer_versions av ON ar.analyzer_id = av.analyzer_id AND ar.analyzer_version_id = av.version_id
WHERE an.node_kind = 'summary'
  AND json_extract(an.content_json, '$.improvement_proposals') IS NOT NULL
GROUP BY av.version_id;
```

---

## 7. Three initial analyzers

### 7.1 Analyzer: `pair-friction`

| Attribute | Value |
|-----------|-------|
| `id` | `pair-friction` |
| `anchor_span` | `pair` |
| `dependencies` | `[]` |
| `implementation_kind` | `deterministic` |
| `node_kind` | `metric` |

Deterministic (Tier 0). No LLM. Runs on every sync.

**Properties:**

```typescript
{
    user_msg_length: number,
    assistant_msg_length: number,
    has_thinking: boolean,
    thinking_length: number,
    correction_detected: boolean,
    correction_patterns: string[],
    correction_type: string | null,     // 'explicit' | 'implicit' | 'repetition' | null
    correction_text: string | null,
    tool_count: number,
    tool_names: string[],
    tool_failure_count: number,
    tool_failure_details: Array<{ name: string; error: string }>,
    tool_waste_bytes: number,
    retry_detected: boolean,
    elapsed_seconds: number | null,
    model: string | null,
    stop_reason: string | null,
    usage_input_tokens: number | null,
    usage_output_tokens: number | null,
    is_compaction_boundary: boolean,
    friction_score: number,               // 0.0-1.0
}
```

**Friction score formula:**

```
friction_score = clamp(
    (correction_detected ? 0.4 : 0) +
    (tool_failure_count > 0 ? 0.3 : 0) +
    (tool_waste_bytes > 10000 ? 0.2 : 0) +
    (correction_patterns.length > 1 ? 0.1 : 0) +
    (elapsed_seconds > 120 ? 0.05 : 0) +
    (stop_reason === 'error' ? 0.3 : 0) +
    (stop_reason === 'aborted' ? 0.2 : 0)
, 0, 1)
```

**Correction patterns:** See §7.3 below.

**Plan logic:** Group each user message with the subsequent assistant response and intervening tool results into a single AnalysisUnit.

### 7.2 Analyzer: `pair-friction-llm`

| Attribute | Value |
|-----------|-------|
| `id` | `pair-friction-llm` |
| `anchor_span` | `pair` |
| `dependencies` | `["pair-friction"]` |
| `implementation_kind` | `in_process_llm` |
| `model_tier` | `cheap` |

Optional LLM enrichment. Only processes pairs where `pair-friction` flagged `correction_detected: true` or `friction_score >= 0.4`.

**Properties:**

```typescript
{
    sentiment: "positive" | "neutral" | "negative" | "frustrated",
    friction_type: string | null,        // "misunderstanding" | "tool_failure" | "wrong_approach" | ...
    friction_summary: string | null,     // 1-2 sentence description
    user_intent: string,                 // what the user was trying to accomplish
    quality_score: number,               // 1-5
}
```

**Edges:** Each node `consumes` the corresponding `pair-friction` node. This is how the dependency chain is explicit.

### 7.3 Analyzer: `session-overview`

| Attribute | Value |
|-----------|-------|
| `id` | `session-overview` |
| `anchor_span` | `full_session` |
| `dependencies` | `["pair-friction", "pair-friction-llm"]` |
| `implementation_kind` | `in_process_llm` |
| `model_tier` | `mid` |

Per-session analysis. Consumes all `pair-friction` and `pair-friction-llm` nodes for the session.

**Properties:**

```typescript
{
    // Aggregated deterministic stats (from pair-friction nodes)
    total_pairs: number,
    friction_pairs: number,
    correction_count: number,
    avg_quality_score: number | null,
    dominant_friction_type: string | null,
    tool_failure_rate: number,
    total_tool_waste_bytes: number,
    session_duration_seconds: number | null,

    // LLM-produced
    session_summary: string,
    key_friction_points: Array<{
        description: string;
        pair_node_id: string;
        severity: "low" | "medium" | "high";
    }>,
    improvement_proposals: Array<{
        target_type: string,
        target_path: string,
        title: string,
        summary: string,
        detail: string,
        evidence: string,
        confidence: number,
        severity: string,
    }>,
    sentiment_arc: Array<{
        segment: number,
        sentiment: string,
        key_event: string,
    }>,
}
```

**Compression strategy for large sessions:**

```
Phase 1: Build structured digest from pair-friction nodes + compaction summaries + post-compaction messages
Phase 2: If digest exceeds context budget:
  - Split into overlapping segments (never split a user-assistant pair)
  - MAP: summarize each segment with cheap model
  - REDUCE: combine segment summaries + aggregated stats → mid model call
Phase 3: Generate session analysis with mid model
```

---

## 8. Correction detection patterns

```typescript
const CORRECTION_STRONG: RegExp[] = [
    /\bno[,.\s]/i,
    /\bnot (that|like|quite|exactly)\b/i,
    /\bwrong\b/i,
    /\bactually[,\s]/i,
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

---

## 9. Proposal materialization and deduplication

### 9.1 Flow

After `session-overview` produces a node with `improvement_proposals` in its `content_json`:

1. Framework extracts `improvement_proposals` array from the node
2. For each proposal:
   a. Compute `dedup_key = SHA-256(target_type + "|" + target_path + "|" + severity + "|" + normalize(title))`
   b. Check if an `open` proposal with this `dedup_key` already exists
   c. If yes → increment occurrence count in the existing proposal's `detail`, mark the new analysis node's edge as `duplicate`
   d. If no → INSERT into `proposals`, create `produces` edge from analysis node to proposal

### 9.2 Deduplication normalization

```typescript
function normalizeForDedup(title: string): string {
    return title
        .toLowerCase()
        .replace(/\b(a|an|the)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}
```

---

## 10. Model tier resolution

```typescript
interface ModelTierConfig {
    cheap: string;      // e.g. 'google/gemini-2.5-flash'
    mid: string;        // e.g. 'anthropic/claude-sonnet-4'
    expensive: string;  // e.g. 'anthropic/claude-opus-4'
}
```

Configured in `~/.pi/agent/prospector.json`. Analyzers request tiers, not specific models.

---

## 11. Incremental run lifecycle

```
On every sync (can run every minute):
  1. runSync() — sync new session data into SQLite
  2. For each analyzer in dependency order:
     a. For each session with new messages:
        i.   runAnalyzer(analyzer, session, config)
        ii.  plan() → get units → filter by idempotency → analyze() remaining
        iii. Materialize proposals into proposals table

On demand (or scheduled daily):
  3. Run pair-friction-llm on high-signal pairs (cheap model)
  4. Run session-overview on sessions with new pair-friction nodes (mid model)
```

---

## 12. Versioning and meta-analysis

### 12.1 Analyzer upgrade

When `pair-friction` is upgraded from commit `abc1234` to `def5678`:

1. Register `pair-friction@def5678` in `analyzer_versions`
2. All `pair-friction@abc1234` nodes remain (append-only)
3. `analysis_progress` has no entry for `pair-friction@def5678` → framework runs analysis
4. If cascading is desired: `/prospect-run --cascade pair-friction` re-runs dependent analyzers

### 12.2 Config change

When the friction threshold changes from `0.3` to `0.4`:

1. `resolveConfig()` hashes the new config → new `config_id`
2. `source_set_hash` doesn't change (the sources are the same messages)
3. `input_hash` changes because `config_id` is included → all units are re-analyzed
4. Old nodes with the old `config_id` remain for comparison

### 12.3 Meta-analysis

```sql
-- Which prompt version produced the most proposals?
SELECT pv.role, pv.id, COUNT(*) as node_count
FROM analysis_runs ar
JOIN analysis_edges ae ON ae.from_node_id IN (
    SELECT id FROM analysis_nodes WHERE run_id = ar.id
) AND ae.edge_kind = 'uses_prompt' AND ae.to_ref_kind = 'prompt_version'
JOIN prompt_versions pv ON ae.to_ref_id = pv.id
WHERE ar.analyzer_id = 'session-overview'
GROUP BY pv.id;

-- Did a config change affect detection rates?
SELECT cv.config_json, COUNT(*) as total,
       SUM(CASE WHEN json_extract(an.content_json, '$.correction_detected') = 1 THEN 1 ELSE 0 END) as corrections
FROM analysis_nodes an
JOIN analyzer_config_versions cv ON an.config_id = cv.id
WHERE an.analyzer_id = 'pair-friction'
GROUP BY cv.id;

-- Find sessions with high friction but no proposals
SELECT s.id
FROM sessions s
WHERE EXISTS (
    SELECT 1 FROM analysis_nodes an
    WHERE an.session_id = s.id
      AND an.analyzer_id = 'pair-friction'
      AND CAST(json_extract(an.content_json, '$.friction_score') AS REAL) > 0.7
)
AND NOT EXISTS (
    SELECT 1 FROM proposals p
    WHERE p.session_id = s.id AND p.status = 'open'
);
```

---

## 13. Edge cases

### Compaction events

Pi sessions contain `compactionSummary` messages. The framework:

- Stores them as messages with `role = "compactionSummary"` and `content_text = summary text`
- `pair-friction` does NOT create pairs for compactionSummary entries
- `session-overview` includes compaction summary text as compressed pre-compaction context, with post-compaction messages in full detail

### Forked sessions

- Sync already resolves forks and stores `parent_session` in `sessions` table
- Analyzers that want cross-fork context can follow `parent_session`
- Out of scope for initial analyzers

### Very long sessions (545MB / 1400+ sessions)

- **pair-friction (Tier 0)**: Deterministic, milliseconds per pair. Processes thousands.
- **pair-friction-llm (Tier 1)**: Only on 10-20% of pairs (those flagged as high-signal). ~$0.01/session.
- **session-overview (Tier 2)**: Map-reduce with budget-aware chunking. ~$0.05-0.15/session with Sonnet.
- **Progress tracking**: Only new messages since last cursor are analyzed.

---

## 14. Implementation plan

### Phase 1: Schema + framework core

**Files to create/modify:**

```
src/db/schema.ts          — add all new tables (migrations 002+)
src/db/analysis-queries.ts — CRUD for analysis_nodes, edges, runs, progress, proposals
src/analyze/framework.ts  — AnalyzerFramework: register, plan, run, runAll, idempotency
src/analyze/types.ts      — All TypeScript interfaces
src/analyze/hash.ts        — computeSourceSetHash, computeInputHash, resolveConfig
src/analyze/model-tiers.ts — ModelTierConfig, resolveModelTier
src/analyze/proposal-materializer.ts — extract proposals from analysis nodes, dedup
```

### Phase 2: `pair-friction` analyzer

```
src/analyze/analyzers/pair-friction/
    index.ts       — Analyzer implementation (plan + analyze)
    patterns.ts    — Correction/frustration regex patterns
    config.ts      — Default config + schema
```

### Phase 3: `pair-friction-llm` analyzer

```
src/analyze/analyzers/pair-friction-llm/
    index.ts       — Analyzer implementation (plan + analyze)
    prompt.ts      — LLM prompt template + structured output schema
    config.ts      — Default config + schema
```

### Phase 4: `session-overview` analyzer

```
src/analyze/analyzers/session-overview/
    index.ts       — Analyzer implementation
    digest.ts       — Build structured session digest
    compress.ts     — Map-reduce compression for large sessions
    prompt.ts       — Session analysis prompts + schemas (map, reduce, classify)
    config.ts       — Default config + schema
```

### Phase 5: Commands + tests

```
src/commands/
    prospect-run.ts    — /prospect-run [analyzer] [session]
    prospect-graph.ts  — /prospect-graph [anchor] (navigate the analysis graph)
    analyze.ts         — Updated to use framework
    proposals.ts       — Updated to read from proposals table + analysis_nodes

tests/
    unit/
        source-hash.test.ts
        input-hash.test.ts
        correction-patterns.test.ts
    component/
        framework.test.ts
        pair-friction.test.ts
        session-overview.test.ts
    integration/
        test-analyzer-pipeline.ts
```

---

## 15. What NOT to build in v1

1. **Pi sub-agent execution** — Use in-process TypeScript with direct `pi-ai` calls. The `implementation_kind = 'pi_subagent'` field exists for future use.
2. **Eager supersession of old analyzer versions** — Old nodes stay. Queries filter by latest version.
3. **Per-model invalidation** — Model changes are metadata on `analysis_runs`, not part of the idempotency key.
4. **Cross-session meta-analyzer** — Focus on per-session first. A `cross-session-patterns` analyzer can be built later.
5. **Target file auto-discovery** — First analyzers propose improvements targeting known categories. Scanning `~/.pi/` is a future enhancement.
6. **Batch optimization for LLM calls** — Start with one pair per call. Batching 5-10 pairs per call is an optimization for later.
7. **Cost budgets** — Start without a per-run cost limit. Add `maxCostPerRun` to config later.