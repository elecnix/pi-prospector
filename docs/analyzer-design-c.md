# pi-prospector Analyzer Framework — Final Design

## 1. Overview

The analyzer framework extends pi-prospector's session index with an **append-only analysis graph** grafted onto the conversation tree. Every analysis artifact is versioned, idempotent, and traceable back to the exact analyzer code, prompt, and configuration that produced it.

All relationships between analysis nodes and between nodes and other entities are expressed through a single **typed edge table**. There are no tree-style `parent_id` columns and no denormalized anchor columns on analysis nodes — the edges table is the single source of truth for graph relationships.

Proposals are materialized from analysis nodes into a fast-access table for user review and deduplication.

### Core principles

1. **Append-only** — analysis nodes are never mutated. New analyzer versions or config changes produce new nodes; old ones persist.
2. **Typed edge graph** — all relationships (anchoring, consumption, refinement, provenance) are explicit edges with kinds. No `parent_id`, no anchor columns on nodes.
3. **Idempotent** — an `(input_hash)` uniquely identifies a node produced by a given recipe on a given source set. Re-running is a no-op.
4. **Incremental** — cursors track progress per (analyzer, version, config, session). Only new messages get analyzed.
5. **Crash-recoverable** — re-running after a crash picks up where it left off by checking which source combinations already have nodes.
6. **Versioned provenance** — every node traces to the exact analyzer version, prompt version, config version, and run that produced it.
7. **Dependency-scoped visibility** — an analyzer sees only its own nodes and nodes from declared dependencies.
8. **Deterministic first, LLM optional** — every analyzer produces a deterministic baseline. LLM enrichment is a separate pass on flagged artifacts.

```
Conversation graph (read-only):
  msg_001 → msg_002 → msg_003 → [compaction] → msg_004 → msg_005

Analysis graph (append-only, grafted via edges):
  msg_003 ←─┬─ turn-pair node (metric, deterministic)
             └─ turn-pair-llm node (classification, cheap LLM)

  session ─── session-overview node (summary + proposals, mid LLM)
                │ consumes turn-pair and turn-pair-llm nodes
                │ anchors to the session
                │ produces proposal nodes
```

---

## 2. Data model

### 2.1 Entity-relationship diagram

```
analyzer_defs ──1:N──→ analyzer_versions
                         │
                         │ N:N via prompt_version_edges (implicit, through runs)
                         ▼
prompt_registry          analysis_runs ──1:N──→ analysis_nodes ──→ analysis_edges
                                   │                              │                    │
analyzer_config_versions ─────────┘                              │                    │
                                                                  │                    │
sessions ──1:N──→ messages ──────────────────────────────────────┘                    │
                                                                  │                    │
proposals ◄── materialized from analysis_nodes ──────────────────────┘

analysis_progress (per analyzer/version/config/session cursor)
```

### 2.2 Table definitions

#### `analyzer_defs` — stable logical identity

One row per analyzer, regardless of version. Never deleted.

```sql
CREATE TABLE IF NOT EXISTS analyzer_defs (
    id              TEXT PRIMARY KEY,           -- 'turn-pair-core', 'session-overview'
    label           TEXT NOT NULL,              -- 'Per-Turn Sentiment & Friction'
    description     TEXT,
    anchor_span     TEXT NOT NULL,              -- 'pair' | 'segment' | 'full_session'
    dependencies    TEXT NOT NULL DEFAULT '[]', -- JSON array of analyzer_def IDs
    created_at      TEXT NOT NULL
);
```

#### `analyzer_versions` — one row per code release

```sql
CREATE TABLE IF NOT EXISTS analyzer_versions (
    analyzer_id         TEXT NOT NULL,
    version_id          TEXT NOT NULL,           -- commit SHA or semver
    implementation_kind TEXT NOT NULL,           -- 'deterministic' | 'in_process_llm' | 'pi_subagent'
    code_ref            TEXT,                    -- git commit, npm version, or extension path
    created_at          TEXT NOT NULL,
    PRIMARY KEY (analyzer_id, version_id),
    FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
);
```

#### `prompt_registry` — content-addressed prompt store

Immutable. Multiple analyzers can share identical prompts.

```sql
CREATE TABLE IF NOT EXISTS prompt_registry (
    hash            TEXT PRIMARY KEY,           -- SHA-256 first 16 hex chars
    content         TEXT NOT NULL,             -- full prompt template text
    role            TEXT,                      -- 'classify' | 'map' | 'reduce' | 'verify' | null
    created_at      TEXT NOT NULL
);
```

#### `analyzer_configs` — content-addressed config/parameter store

Every change to an analyzer's config produces a new row. Nodes reference the specific config that produced them.

```sql
CREATE TABLE IF NOT EXISTS analyzer_configs (
    id              TEXT PRIMARY KEY,           -- UUID v7
    analyzer_id     TEXT NOT NULL,
    config_hash     TEXT NOT NULL UNIQUE,       -- SHA-256 of canonical JSON
    config_json     TEXT NOT NULL,             -- e.g. {"cheap_model":"anthropic/haiku-3","friction_threshold":0.5}
    label           TEXT,                       -- 'default', 'sensitive', 'aggressive'
    created_at      TEXT NOT NULL,
    FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
);
```

#### `analysis_runs` — execution provenance

One row per attempted execution of an analyzer on a session. Separates execution metadata from artifact data.

```sql
CREATE TABLE IF NOT EXISTS analysis_runs (
    id                      TEXT PRIMARY KEY,
    analyzer_id             TEXT NOT NULL,
    analyzer_version_id     TEXT NOT NULL,
    config_id               TEXT NOT NULL,
    session_id              TEXT NOT NULL,

    status                  TEXT NOT NULL DEFAULT 'planned', -- 'planned'|'running'|'ok'|'error'|'partial'
    prompt_bundle_hash      TEXT NOT NULL,      -- SHA-256 of sorted prompt hashes used in this run

    started_at              TEXT NOT NULL,
    finished_at             TEXT,
    model_spec              TEXT,              -- resolved model string, e.g. 'anthropic/claude-sonnet-4-5'
    cost_usd                REAL DEFAULT 0,
    tokens_used             INTEGER DEFAULT 0,
    nodes_produced          INTEGER DEFAULT 0,
    nodes_skipped           INTEGER DEFAULT 0,
    error_message           TEXT,

    FOREIGN KEY (analyzer_id, analyzer_version_id) REFERENCES analyzer_versions(analyzer_id, version_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON analysis_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON analysis_runs(status);
```

#### `analysis_nodes` — append-only artifact store

No `UPDATE` or `DELETE` after insert. No `parent_id`, no anchor columns — all relationships go through `analysis_edges`.

```sql
CREATE TABLE IF NOT EXISTS analysis_nodes (
    id                  TEXT PRIMARY KEY,           -- UUID v7 (time-sortable)
    session_id          TEXT NOT NULL,

    analyzer_id          TEXT NOT NULL,
    analyzer_version_id  TEXT NOT NULL,
    config_id            TEXT NOT NULL,
    run_id               TEXT NOT NULL,

    node_kind            TEXT NOT NULL,              -- 'metric'|'classification'|'summary'|'proposal'|'error'

    content_json         TEXT NOT NULL,              -- structured artifact payload (schema varies by node_kind)
    source_set_hash      TEXT NOT NULL,              -- SHA-256 of sorted source refs (what went in)
    input_hash           TEXT NOT NULL,              -- SHA-256(recipe) for idempotency lookup

    created_at           TEXT NOT NULL,

    -- LLM metadata (NULL for deterministic nodes)
    model_used           TEXT,
    cost_usd             REAL DEFAULT 0,
    tokens_used           INTEGER DEFAULT 0,
    duration_ms           INTEGER,

    FOREIGN KEY (run_id) REFERENCES analysis_runs(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_session      ON analysis_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_analyzer     ON analysis_nodes(analyzer_id, analyzer_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind          ON analysis_nodes(node_kind);
CREATE INDEX IF NOT EXISTS idx_nodes_input_hash   ON analysis_nodes(input_hash);
CREATE INDEX IF NOT EXISTS idx_nodes_source_hash   ON analysis_nodes(source_set_hash);
CREATE INDEX IF NOT EXISTS idx_nodes_config       ON analysis_nodes(config_id);
CREATE INDEX IF NOT EXISTS idx_nodes_idempotency ON analysis_nodes(analyzer_id, analyzer_version_id, config_id, source_set_hash);
```

#### `analysis_edges` — typed graph relationships

The single table that makes this a real graph. Every edge has a kind that explains the relationship.

```sql
CREATE TABLE IF NOT EXISTS analysis_edges (
    from_node_id    TEXT NOT NULL,           -- the node that holds this relationship
    to_ref_kind     TEXT NOT NULL,           -- what kind of entity the target is
    to_ref_id       TEXT NOT NULL,           -- id of the target entity
    edge_kind       TEXT NOT NULL,           -- what the relationship means
    ordinal         INTEGER DEFAULT 0,      -- ordering within same (from_node, edge_kind)
    PRIMARY KEY (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal),
    FOREIGN KEY (from_node_id) REFERENCES analysis_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_edges_from   ON analysis_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_to     ON analysis_edges(to_ref_kind, to_ref_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind   ON analysis_edges(edge_kind);
```

**Edge kinds:**

| Edge kind | from | to | Meaning |
|-----------|------|----|---------|
| `anchors` | analysis_node | `message` or `session` | This node is about this conversation entity. A pair-level node anchors to its user message. A session-level node anchors to the session. |
| `consumes` | analysis_node | `message` or `analysis_node` | This node used this as input. A session-overview consumes turn-pair nodes. An LLM enrichment consumes its deterministic base node. |
| `refines` | analysis_node | `analysis_node` | This node builds on top of another. An LLM enrichment refines its deterministic base. |
| `uses_prompt` | analysis_node | `prompt_version` (by hash) | This node was produced using this prompt. |
| `uses_config` | analysis_node | `analyzer_config` (by id) | This node was produced with this config. |
| `produces` | analysis_node | (proposal extracted from content) | This node produced this proposal. An `produces` edge connects the session-overview (or other summary) node to each proposal materialized from it. |

**Navigation queries:**

```sql
-- All analysis anchored to a specific message
SELECT an.* FROM analysis_nodes an
JOIN analysis_edges e ON e.from_node_id = an.id
WHERE e.edge_kind = 'anchors'
  AND e.to_ref_kind = 'message'
  AND e.to_ref_id = 'msg_006';

-- All sources consumed by a session-overview node
SELECT e.to_ref_kind, e.to_ref_id FROM analysis_edges e
WHERE e.from_node_id = 'an:session_overview_1'
  AND e.edge_kind = 'consumes';

-- Walk from a proposal back to the conversation messages that produced it
WITH RECURSIVE provenance AS (
    SELECT e.from_node_id, e.to_ref_kind, e.to_ref_id
    FROM analysis_edges e
    WHERE e.to_ref_kind = 'message' AND e.edge_kind = 'anchors'
      AND e.from_node_id IN (
          SELECT from_node_id FROM analysis_edges
          WHERE edge_kind = 'consumes' AND to_ref_kind = 'analysis_node'
            AND to_ref_id IN (
                SELECT from_node_id FROM analysis_edges
                WHERE edge_kind = 'produces' AND to_ref_id = 'proposal_42'
            )
      )
    UNION ALL
    SELECT e.from_node_id, e.to_ref_kind, e.to_ref_id
    FROM analysis_edges e
    JOIN provenance p ON e.from_node_id = p.to_ref_id
    WHERE e.edge_kind = 'consumes' AND p.to_ref_kind = 'analysis_node'
)
SELECT DISTINCT to_ref_id FROM provenance WHERE to_ref_kind = 'message';
```

#### `analysis_progress` — incremental cursor per (analyzer, version, config, session)

```sql
CREATE TABLE IF NOT EXISTS analysis_progress (
    analyzer_id         TEXT NOT NULL,
    analyzer_version_id  TEXT NOT NULL,
    config_id            TEXT NOT NULL,
    session_id           TEXT NOT NULL,

    cursor_json          TEXT,                  -- {"last_message_rowid": 452, "last_pair_index": 17}
    last_run_id          TEXT,
    total_analyzed      INTEGER DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'ok', -- 'ok'|'in_progress'|'error'|'needs_rerun'
    error_message        TEXT,
    updated_at           TEXT NOT NULL,

    PRIMARY KEY (analyzer_id, analyzer_version_id, config_id, session_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

#### `proposals` — fast-access materialized view

Derived from `analysis_nodes` where `node_kind = 'proposal'`. Kept in sync by the framework after each run.

```sql
CREATE TABLE IF NOT EXISTS proposals (
    id                  TEXT PRIMARY KEY,
    analysis_node_id    TEXT NOT NULL UNIQUE,      -- 1:1 with the source analysis node

    session_id          TEXT NOT NULL,
    analyzer_id         TEXT NOT NULL,

    target_type         TEXT NOT NULL,            -- 'agents_md'|'system_md'|'skill'|'extension_prompt'|'tool_output'|'repo_doc'|'config'
    target_path         TEXT,                     -- e.g. '~/.pi/agent/AGENTS.md'
    title               TEXT NOT NULL,
    summary             TEXT NOT NULL,
    detail              TEXT,                     -- proposed edit text or detailed explanation
    evidence_json        TEXT,                     -- JSON array of message/node references and excerpts
    confidence          REAL,                     -- 0.0–1.0
    severity            TEXT,                     -- 'friction'|'correction'|'waste'|'suggestion'|'insight'
    dedup_key           TEXT,                     -- hash of (target_type, target_path, severity, normalize(title))

    status              TEXT NOT NULL DEFAULT 'open', -- 'open'|'accepted'|'applied'|'rejected'|'duplicate'
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,

    FOREIGN KEY (analysis_node_id) REFERENCES analysis_nodes(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_proposals_status   ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_target   ON proposals(target_type, target_path);
CREATE INDEX IF NOT EXISTS idx_proposals_dedup    ON proposals(dedup_key);
CREATE INDEX IF NOT EXISTS idx_proposals_session  ON proposals(session_id);
```

---

## 3. Idempotency model

### 3.1 Recipe

A node is uniquely identified by its `input_hash`:

```
input_hash = SHA-256(
    analyzer_id
    | analyzer_version_id
    | config_id
    | prompt_bundle_hash   -- SHA-256 of all prompt hashes used, sorted
    | source_set_hash
)
```

Where:
- `source_set_hash = SHA-256(sorted(source_refs).map(r => r.kind + ':' + r.id).join('|'))`
- `prompt_bundle_hash = SHA-256(sorted(prompt_hashes).join('|'))`

### 3.2 Idempotency check

Before producing a node, the framework checks:

```sql
SELECT 1 FROM analysis_nodes WHERE input_hash = ?;
```

If a row exists → skip (already computed).

### 3.3 When does a new recipe get created?

| What changes | Effect on recipe | Effect on existing nodes |
|---|---|---|
| Analyzer code updated (new `version_id`) | New recipe → new nodes | Old nodes remain |
| Config parameters changed (new `config_id`) | New recipe → new nodes | Old nodes remain |
| Prompt text changed (new `prompt_hash`) → new `prompt_bundle_hash` | New recipe → new nodes | Old nodes remain |
| Model changed | No recipe change | Same nodes are valid; model is metadata on `analysis_run` |
| New messages synced | New source refs → new `source_set_hash` for those units | Old units keep their hash |
| Analyzer re-run with same recipe | Idempotency check finds existing node → skip | No new nodes |

---

## 4. Analyzer interface

### 4.1 TypeScript types

```typescript
// ── Analyzer definition ──

interface AnalyzerDef {
    id: string;                   // 'turn-pair-core', 'session-overview'
    label: string;
    description: string;
    anchorSpan: 'pair' | 'segment' | 'full_session';
    dependencies: string[];       // analyzer_def IDs
}

interface AnalyzerVersion {
    analyzerId: string;
    versionId: string;            // commit SHA or semver
    implementationKind: 'deterministic' | 'in_process_llm' | 'pi_subagent';
    codeRef?: string;
}

interface PromptVersion {
    hash: string;                  // content hash (first 16 hex chars of SHA-256)
    content: string;
    fullHash: string;             // full SHA-256 for verification
    role?: string;                // 'classify' | 'map' | 'reduce' | 'verify'
}

interface AnalyzerConfig {
    id: string;                   // config hash or UUID
    analyzerId: string;
    configJson: Record<string, unknown>;
    configHash: string;           // SHA-256 of canonical JSON
    label?: string;
}

// ── Analysis units ──

interface AnalysisUnit {
    sources: SourceRef[];
    sourceSetHash: string;
    /** What kind of conversation entity this unit targets */
    anchorKind: 'message' | 'pair' | 'segment' | 'session' | 'analysis_node' | 'none';
    /** The id of the anchor (message.id or session.id), null for 'none' */
    anchorRef?: string;
    meta?: Record<string, unknown>;
}

interface SourceRef {
    kind: 'message' | 'analysis_node' | 'session';
    id: string;
}

// ── Analysis result ──

interface AnalysisResult {
    contentJson: Record<string, unknown>;
    nodeKind: 'metric' | 'classification' | 'summary' | 'proposal' | 'error';
    /** What kind of conversation entity this node is about */
    anchorKind: 'message' | 'pair' | 'segment' | 'session' | 'analysis_node' | 'none';
    /** The id of the anchor (message.id or session.id), null for 'none' */
    anchorRef?: string;

    edges: Array<{
        toRefKind: SourceRef['kind'] | 'prompt_version' | 'config_version';
        toRefId: string;
        edgeKind: 'anchors' | 'consumes' | 'refines' | 'uses_prompt' | 'uses_config' | 'produces';
        ordinal?: number;
    }>;

    modelUsed?: string;
    costUsd?: number;
    tokensUsed?: number;
    durationMs?: number;
}

// ── Analyzer interface ──

interface Analyzer {
    def: AnalyzerDef;
    version: AnalyzerVersion;
    prompts: Record<string, PromptVersion>;
    defaultConfig: AnalyzerConfig;

    plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]>;
    analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult>;
}

// ── Contexts ──

interface AnalyzerPlanContext {
    sessionId: string;
    messages: MessageRow[];
    allNodes: AnalysisNodeRow[];
    ownNodes: AnalysisNodeRow[];
    dependencyNodes: Record<string, AnalysisNodeRow[]>;
    progress: ProgressRow | null;
    db: Database;
}

interface AnalyzerRunContext {
    getMessage(id: string): MessageRow | undefined;
    getNode(id: string): AnalysisNodeRow | undefined;
    getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
    llm(request: LLMRequest): Promise<LLMResponse>;
    run: RunRow;
    config: AnalyzerConfig;
    prompts: Record<string, string>;
}
```

### 4.2 Framework execution flow

```
runAnalyzer(analyzer, sessionId, config)

  1. Resolve analyzer version, store prompts (INSERT OR IGNORE), resolve config
  2. Compute prompt_bundle_hash
  3. Create analysis_run row (status = 'running')

  4. analyzer.plan(ctx) → AnalysisUnit[]
  5. For each unit:
     a. Compute source_set_hash
     b. Compute input_hash = SHA-256(analyzer_id | version_id | config_id | prompt_bundle_hash | source_set_hash)
     c. Idempotency check: SELECT 1 FROM analysis_nodes WHERE input_hash = ?
        → if exists, skip, increment nodes_skipped
     d. Call analyzer.analyze(unit, runCtx)
     e. INSERT INTO analysis_nodes
     f. INSERT INTO analysis_edges for each edge in result.edges
     g. If node_kind = 'proposal' → upsert into proposals table
     h. Increment nodes_produced

  6. Update analysis_run (status = 'ok' or 'error', cost, tokens)
  7. Update analysis_progress (cursor, status)

  8. Return { runId, nodes_produced, nodes_skipped, cost_usd }
```

### 4.3 Crash recovery

If the process crashes between steps 5d and 5f:

- Nodes already inserted are valid (append-only, no mutations)
- Nodes not yet inserted have no row in `analysis_nodes` → their `input_hash` doesn't exist → re-running will produce them
- Edges for inserted nodes might be missing → a repair pass can re-link orphaned nodes by checking `analysis_nodes` rows with no matching `analysis_edges`

The framework can also detect partial runs:
```sql
SELECT * FROM analysis_runs WHERE status = 'running';
```
These can be retried or marked as `'error'`.

---

## 5. Isolation model

### 5.1 Visibility rule

An analyzer with `def.id = X` and `def.dependencies = ["A", "B"]` can see:

1. **Conversation data** — all messages and sessions (always readable)
2. **Own nodes** — `analysis_nodes WHERE analyzer_id = X`
3. **Dependency nodes** — `analysis_nodes WHERE analyzer_id IN ('A', 'B')`

It CANNOT see nodes from analyzers not in its dependency list.

### 5.2 Enforcement

The framework enforces this in `AnalyzerPlanContext` and `AnalyzerRunContext`:
- `dependencyNodes` only includes declared dependencies
- `getDependencyNodes(analyzerId)` validates against the dependency list

If an analyzer runs as a Pi sub-agent in the future, tool wrappers will enforce the same visibility.

---

## 6. Analyzer 1: `turn-pair-core`

### 6.1 Identity

```
id:             "turn-pair-core"
label:          "Per-Turn Deterministic Metrics"
anchor_span:    "pair"
dependencies:  []
implementation_kind: "deterministic"
```

### 6.2 Scope

A single (user_message → assistant_response + intervening tool_results) pair.

### 6.3 Deterministic properties (always produced, no LLM)

| Property | Type | Source |
|---|---|---|
| `user_msg_length` | integer | `len(user_msg.content_text)` |
| `assistant_msg_length` | integer | `len(assistant_msg.content_text)` |
| `has_thinking` | boolean | `assistant_msg.content_thinking != null` |
| `thinking_length` | integer | `len(assistant_msg.content_thinking) \|\| 0` |
| `correction_detected` | boolean | regex match |
| `correction_patterns` | string[] | which patterns matched |
| `correction_type` | string \| null | `'explicit' \| 'implicit' \| 'repetition' \| null` |
| `correction_text` | string \| null | extracted corrective instruction |
| `tool_call_count` | integer | number of tool calls |
| `tool_names` | string[] | names of tools called |
| `tool_failure_count` | integer | tool results with `is_error = true` |
| `tool_failure_details` | object[] | `[{tool_name, error_preview}]` |
| `tool_waste_bytes` | integer | bytes of tool results never referenced in subsequent text |
| `retry_detected` | boolean | same tool+target called 2+ times |
| `elapsed_seconds` | float \| null | time between user and assistant timestamps |
| `friction_score` | float | 0.0–1.0 (computed from signals) |
| `model` | string \| null | model that produced assistant response |
| `stop_reason` | string \| null | from assistant response |
| `usage_input_tokens` | integer \| null | from assistant response |
| `usage_output_tokens` | integer \| null | from assistant response |
| `is_compaction_boundary` | boolean | true if any message in the pair is a compactionSummary |

Correction patterns (same regex sets as discussed in earlier drafts — strong, weak, negation).

### 6.4 Plan logic

```typescript
plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
    const units: AnalysisUnit[] = [];
    for (let i = 0; i < ctx.messages.length; i++) {
        if (ctx.messages[i].role !== 'user') continue;
        let j = i + 1;
        while (j < ctx.messages.length && ctx.messages[j].role !== 'assistant') j++;
        if (j >= ctx.messages.length) continue;

        const sources: SourceRef[] = [];
        for (let k = i; k <= j && k < ctx.messages.length; k++) {
            sources.push({ kind: 'message', id: ctx.messages[k].id });
        }

        units.push({
            sources,
            sourceSetHash: computeSourceSetHash(sources),
            anchorKind: 'pair',
            anchorRef: ctx.messages[i].id,  // the user message
            meta: { userIndex: i, assistantIndex: j },
        });
    }
    return units;
}
```

### 6.5 Edges produced

Each node creates:

```
anchors → each message in the pair (user, assistant, and intervening tool results)
```

No `consumes`, `refines`, or dependency edges (this is a root analyzer with no dependencies).

---

## 7. Analyzer 2: `turn-pair-llm`

### 7.1 Identity

```
id:             "turn-pair-llm"
label:          "Per-Turn LLM Sentiment & Friction"
anchor_span:    "pair"
dependencies:  ["turn-pair-core"]
implementation_kind: "in_process_llm"
```

### 7.2 Scope

Only processes pairs where the deterministic `turn-pair-core` flagged `correction_detected: true` or `friction_score >= 0.4`.

### 7.3 LLM properties

| Property | Type | Source |
|---|---|---|
| `sentiment` | string | LLM: `'positive' \| 'neutral' \| 'negative' \| 'frustrated'` |
| `frustration_level` | integer | LLM: 0–10 |
| `correction_type_llm` | string \| null | LLM: `'explicit' \| 'implicit' \| 'repetition' \| null` |
| `friction_cause` | string \| null | LLM |
| `friction_summary` | string \| null | LLM: 1–2 sentences |
| `user_intent` | string | LLM: what the user was trying to accomplish |
| `quality_score` | integer | LLM: 1–5 |

### 7.4 Plan logic

```typescript
plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
    const deterministicNodes = ctx.dependencyNodes['turn-pair-core'];
    const highSignal = deterministicNodes.filter(n => {
        const props = JSON.parse(n.content_json);
        return props.correction_detected || props.friction_score >= 0.4;
    });

    return highSignal.map(n => ({
        sources: [{ kind: 'analysis_node', id: n.id }],
        sourceSetHash: computeSourceSetHash([{ kind: 'analysis_node', id: n.id }]),
        anchorKind: 'analysis_node',
        anchorRef: n.id,
        meta: { deterministicNodeId: n.id },
    }));
}
```

### 7.5 Edges produced

Each node creates:

```
refines  → turn-pair-core node it enriches
consumes → turn-pair-core node (same as refines, but different semantic)
anchors  → same messages as the turn-pair-core node (inherited)
uses_prompt → the prompt used for classification
```

---

## 8. Analyzer 3: `session-overview`

### 8.1 Identity

```
id:             "session-overview"
label:          "Session-Level Analysis & Proposals"
anchor_span:    "full_session"
dependencies:  ["turn-pair-core", "turn-pair-llm"]
implementation_kind: "in_process_llm"
```

### 8.2 Scope

One node per session. Consumes all turn-pair-core and turn-pair-llm nodes.

### 8.3 Context budget strategy

For sessions that fit in the model's context window:
```
Structured digest → single LLM call
```

For sessions that exceed the context:
```
Phase 1: Build structured digest from turn-pair nodes + compaction summaries + message metadata
Phase 2: If digest > context budget, split into overlapping segments
Phase 3: Map — summarize each segment with cheap model
Phase 4: Reduce — combine segment summaries + aggregated stats → final analysis with mid model
```

The structured digest format (not truncation):

```markdown
## Session: project-name, 2026-05-29, 47 min, 12 pairs

### Compaction Summary (verbatim from session)
The user was working on auth module refactoring. They had several corrections about function names...

### Per-Pair Summary (from turn-pair-core nodes)
| # | Time  | Sentiment | Friction | Correction | Tools |
|---|-------|-----------|----------|------------|-------|
| 1 | 14:02 | neutral  | none     | —          | read  |
| 2 | 14:08 | frustrated | wrong_approach | "wrong function" | read, edit |
...

### Key Events (post-compaction messages, full detail)
[14:23] USER: "actually, I said use pnpm not npm"
[14:24] AGENT: reads package.json (2KB), runs pnpm install

### Statistics (deterministic, from turn-pair aggregation)
- Total pairs: 12, friction pairs: 3, correction rate: 0.25
- Tool failures: 2 (edit mismatch, bash exit 1)
- Tool waste: 45KB total (2 reads never referenced)
```

### 8.4 Properties produced

```typescript
interface SessionOverviewProperties {
    // Aggregated deterministic stats
    total_pairs: number;
    friction_pairs: number;
    correction_count: number;
    avg_quality_score: number | null;
    dominant_friction_type: string | null;
    tool_failure_rate: number;
    total_tool_waste_bytes: number;
    session_duration_seconds: number | null;

    // LLM-produced
    session_summary: string;
    key_friction_points: Array<{
        description: string;
        pair_node_id: string;
        severity: 'low' | 'medium' | 'high';
    }>;
    improvement_proposals: Array<{
        target_type: string;
        target_path: string;
        title: string;
        summary: string;
        detail: string;
        evidence: string;
        confidence: number;
        severity: string;
    }>;
    sentiment_arc: Array<{
        segment: number;
        sentiment: string;
        key_event: string;
    }>;
}
```

### 8.5 Plan logic

One unit per session, sourcing all dependency nodes:

```typescript
plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
    const pairNodes = ctx.dependencyNodes['turn-pair-core'];
    const llmNodes = ctx.dependencyNodes['turn-pair-llm'];
    if (pairNodes.length === 0) return [];

    const sources: SourceRef[] = [
        ...pairNodes.map(n => ({ kind: 'analysis_node' as const, id: n.id })),
        ...llmNodes.map(n => ({ kind: 'analysis_node' as const, id: n.id })),
    ];

    return [{
        sources,
        sourceSetHash: computeSourceSetHash(sources),
        anchorKind: 'session',
        anchorRef: ctx.sessionId,
    }];
}
```

### 8.6 Edges produced

```
anchors  → session
consumes → all turn-pair-core and turn-pair-llm nodes
uses_prompt → map prompt (if map-reduce was used)
uses_prompt → reduce prompt
uses_config → config version
produces → proposal nodes (materialized into proposals table)
```

---

## 9. Proposal materialization

After `session-overview` (or any future proposal-generating analyzer) produces a node with `node_kind = 'proposal'`:

1. Framework extracts `improvement_proposals` from `content_json`
2. For each proposal:
   a. Compute `dedup_key = SHA-256(target_type + target_path + severity + normalize(title))`
   b. Check if an `open` proposal with this `dedup_key` exists
   c. If yes → increment occurrence tracking, mark new proposal as `duplicate`
   d. If no → INSERT into `proposals` and create analysis edges:
      - `analysis_edges(from_node_id=proposal_node, to_ref_kind='analysis_node', to_ref_id=source_analysis_node, edge_kind='produces')`
      - `analysis_edges(from_node_id=proposal_node, to_ref_kind='session', to_ref_id=session_id, edge_kind='anchors')`
      - `analysis_edges(from_node_id=proposal_node, to_ref_kind='session', to_ref_id=session_id, edge_kind='anchors')`

---

## 10. Model tiers

```typescript
interface ModelTierConfig {
    cheap: string;      // e.g. 'anthropic/claude-haiku-3' or 'google/gemini-2.5-flash'
    mid: string;        // e.g. 'anthropic/claude-sonnet-4-5'
    expensive: string; // e.g. 'anthropic/claude-opus-4' (rarely used)
}
```

Configured in `~/.pi/agent/prospector.json`. Analyzers request tiers, not specific models.

---

## 11. Incremental run schedule

| When | What | Cost |
|------|------|------|
| Every sync (~1 min) | Run `turn-pair-core` deterministic on new messages | Free |
| On demand (or daily) | Run `turn-pair-llm` on high-signal pairs | ~$0.01/session |
| On demand (or daily) | Run `session-overview` on sessions with new analysis | ~$0.05–0.15/session |
| On demand | Extract proposals from `session-overview` nodes | Free (DB query) |

---

## 12. What NOT to build in v1

1. **Pi sub-agent execution engine** — Use in-process TypeScript analyzers with `pi-ai` calls. The `implementation_kind = 'pi_subagent'` field exists for future use.

2. **Eager supersession of old versions** — Old nodes remain. Queries filter by `(analyzer_id, analyzer_version_id)` to see current results. A future `/prospect-gc` can optionally archive old-version nodes.

3. **Per-model invalidation** — Model changes do NOT invalidate analysis. Model is metadata on `analysis_run`, not part of the recipe.

4. **Complex dependency version resolution** — Dependencies resolve to "latest successful version" for MVP.

5. **Cross-session meta-analyzer** — Focus on per-session analysis first.

6. **Target file auto-discovery** — The first analyzers propose improvements targeting known categories. Scanning `~/.pi/` to discover all config targets is a future enhancement.

---

## 13. Migration from existing schema

The existing `proposals` table remains for now. Add:

```sql
ALTER TABLE proposals ADD COLUMN source_node_id TEXT REFERENCES analysis_nodes(id);
```

New analysis-node-based proposals will populate both `analysis_nodes` (with `node_kind = 'proposal'`) and `proposals`. The `/prospect-proposals` command reads from both during transition.

Eventually:
- `proposals` table → read-only for old records
- `analysis_nodes WHERE node_kind = 'proposal'` → the new source
- The command merges results from both

---

## 14. File structure

```
src/
├── analyze/
│   ├── framework.ts              — AnalyzerFramework class: register, run, runAll
│   ├── types.ts                  — All TypeScript interfaces
│   ├── input-hash.ts             — computeSourceSetHash, computeInputHash, computePromptBundleHash
│   ├── edge-kinds.ts             — Edge kind constants and validation
│   ├── proposal-materializer.ts  — Extract proposals from analysis nodes, dedup, insert
│   ├── model-tiers.ts            — ModelTierConfig, resolveModelTier
│   ├── analyzers/
│   │   ├── turn-pair-core/
│   │   │   ├── index.ts          — Analyzer implementation
│   │   │   ├── patterns.ts       — Correction/frustration regex patterns
│   │   │   └── config.ts        — Default config + friction scoring formula
│   │   ├── turn-pair-llm/
│   │   │   ├── index.ts          — LLM enrichment analyzer
│   │   │   ├── prompt.ts         — Prompt template + structured output schema
│   │   │   └── config.ts
│   │   └── session-overview/
│   │       ├── index.ts          — Analyzer implementation
│   │       ├── digest.ts          — Build structured session digest
│   │       ├── compress.ts       — Map-reduce compression for large sessions
│   │       ├── prompt-map.ts     — Map-phase prompt + schema
│   │       ├── prompt-reduce.ts  — Reduce-phase prompt + schema
│   │       └── config.ts
├── db/
│   ├── schema.ts                 — Existing + new tables (migration 002+)
│   ├── queries.ts               — Existing + new query functions
│   └── analysis-queries.ts      — Queries for analysis_nodes, edges, runs, progress
├── commands/
│   ├── sync.ts                  — Existing (updated to trigger analyzers)
│   ├── analyze.ts               — Updated: now uses framework
│   ├── proposals.ts             — Updated: reads from proposals table + analysis_nodes
│   ├── stats.ts                 — Existing
│   └── tool.ts                  — Existing
```