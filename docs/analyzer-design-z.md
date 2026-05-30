# Analyzer Framework Design (Final)

The analysis framework extends pi-prospector's session index with an **append-only graph of analysis nodes** grafted onto the conversation tree. Analyzers are versioned, idempotent pipelines that read conversation messages, produce structured analysis artifacts, and can depend on other analyzers' outputs.

---

## Core Principles

1. **Append-only** — Analysis nodes are never mutated. Re-analysis creates new nodes; old ones persist for comparison.
2. **Grafted graph** — Analysis nodes anchor to conversation messages and link to each other via `parent_id`, enabling navigation from any leaf up to any root.
3. **Idempotent** — An `(analyzer_id, version, prompt_hash, config_id, source_hash)` tuple uniquely identifies a node. Re-running with the same inputs is a no-op.
4. **Incremental** — Cursors track progress per (analyzer, version, session). Only new messages trigger analysis.
5. **Crash-recoverable** — Re-running after a crash picks up where it left off by checking which source combinations already have nodes.
6. **Dependency-scoped** — An analyzer sees only its own nodes and nodes from declared dependencies. The framework enforces this at the query layer.
7. **Versioned** — Every node traces to the exact analyzer commit, prompt hash, and config version that produced it. Prompts are content-addressed.

---

## Schema

### `prompt_registry` — Content-addressed prompt store

Every prompt template is stored by its SHA-256 hash. Identical prompts across analyzer versions share a single row.

```sql
CREATE TABLE prompt_registry (
    hash        TEXT PRIMARY KEY,         -- SHA-256 (first 16 hex chars)
    analyzer_id TEXT NOT NULL,            -- which analyzer owns this prompt
    content     TEXT NOT NULL,            -- full prompt template text
    label       TEXT,                     -- optional human label: "v3-concise"
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_prompt_analyzer ON prompt_registry(analyzer_id);
```

When an analyzer is registered, all its prompts are stored via:

```typescript
function storePrompt(db: Database, analyzerId: string, content: string, label?: string): string {
    const hash = sha256(content).slice(0, 16);
    db.prepare(`INSERT OR IGNORE INTO prompt_registry (hash, analyzer_id, content, label, created_at)
                VALUES (?, ?, ?, ?, ?)`)
        .run(hash, analyzerId, content, label ?? null, new Date().toISOString());
    return hash;
}
```

### `analyzers` — Analyzer version registry

One row per version. Upgrading an analyzer inserts a new row; the old row persists for provenance.

```sql
CREATE TABLE analyzers (
    id           TEXT NOT NULL,            -- "pair-friction", "session-overview"
    version      TEXT NOT NULL,            -- git commit hash or semver
    label        TEXT,                     -- "Per-Message-Pair Friction Detection"
    description  TEXT,
    prompt_hash  TEXT NOT NULL,            -- SHA-256 of primary prompt (for idempotency key)
    dependencies TEXT NOT NULL DEFAULT '[]',  -- JSON array of analyzer IDs: ["pair-friction"]
    config       TEXT NOT NULL DEFAULT '{}',   -- JSON: current config values (thresholds, etc.)
    config_schema TEXT,                    -- optional JSON Schema for config validation
    is_deterministic INTEGER NOT NULL DEFAULT 0,
    model_tier   TEXT,                     -- "cheap"|"mid"|"expensive"|NULL (NULL for deterministic)
    created_at   TEXT NOT NULL,
    PRIMARY KEY (id, version)
);
```

### `analyzer_configs` — Version-tracked configuration

Every change to an analyzer's config produces a new row. The `input_hash` on analysis nodes references the specific config used, so you can trace whether a result came from config v3 or config v7.

```sql
CREATE TABLE analyzer_configs (
    id           TEXT PRIMARY KEY,         -- UUID v7
    analyzer_id  TEXT NOT NULL,
    config_hash  TEXT NOT NULL,            -- SHA-256 of JSON-serialized config
    config       TEXT NOT NULL,            -- JSON: the full config object
    created_at   TEXT NOT NULL,
    UNIQUE(analyzer_id, config_hash)
);
CREATE INDEX idx_config_analyzer ON analyzer_configs(analyzer_id);
```

```typescript
function resolveConfig(db: Database, analyzerId: string, config: Record<string, unknown>): string {
    const configJson = JSON.stringify(config, Object.keys(config).sort());
    const configHash = sha256(configJson).slice(0, 16);
    const existing = db.prepare(
        `SELECT id FROM analyzer_configs WHERE analyzer_id = ? AND config_hash = ?`
    ).get(analyzerId, configHash);
    if (existing) return existing.id;
    const id = uuidv7();
    db.prepare(`
        INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, analyzerId, configHash, configJson, new Date().toISOString());
    return id;
}
```

### `analysis_nodes` — The analysis graph

Append-only. Every row is one analysis artifact. Navigation uses `parent_id` (up the analysis tree), `anchor_entry_id` (down to the conversation), and `node_sources` (to other analysis nodes or messages).

```sql
CREATE TABLE analysis_nodes (
    id               TEXT PRIMARY KEY,           -- UUID v7 (time-sortable)
    analyzer_id      TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    prompt_hash      TEXT,                        -- NULL for deterministic analyzers
    config_id        TEXT,                        -- references analyzer_configs.id

    -- Graph structure
    parent_id        TEXT,                        -- parent in analysis tree (NULL = root)
    anchor_entry_id  TEXT,                        -- conversation message.id (NULL = session-level)
    anchor_span      TEXT NOT NULL,               -- 'single_entry'|'entry_pair'|'segment'|'full_session'

    -- Content
    node_type        TEXT NOT NULL,               -- 'deterministic'|'llm_analysis'|'summary'|'metric'
    properties       TEXT NOT NULL,               -- JSON: analyzer-specific structured output

    -- Provenance & idempotency
    session_id       TEXT NOT NULL,
    source_hash      TEXT NOT NULL,               -- SHA-256(sorted source refs joined by |)
    input_hash       TEXT NOT NULL,               -- SHA-256(analyzer_id|version|prompt_hash|config_id|source_hash)

    -- Metadata
    created_at       TEXT NOT NULL,
    cost_usd         REAL,                        -- NULL for deterministic
    tokens_used      INTEGER,
    model_used       TEXT,                         -- e.g. "anthropic/claude-sonnet-4"
    duration_ms      INTEGER,
    status           TEXT NOT NULL DEFAULT 'ok',  -- 'ok'|'error'
    error_message    TEXT,

    FOREIGN KEY (analyzer_id, analyzer_version) REFERENCES analyzers(id, version),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_nodes_session     ON analysis_nodes(session_id);
CREATE INDEX idx_nodes_analyzer    ON analysis_nodes(analyzer_id, analyzer_version);
CREATE INDEX idx_nodes_anchor      ON analysis_nodes(anchor_entry_id);
CREATE INDEX idx_nodes_parent      ON analysis_nodes(parent_id);
CREATE INDEX idx_nodes_input_hash  ON analysis_nodes(input_hash);
CREATE INDEX idx_nodes_idempotent  ON analysis_nodes(analyzer_id, analyzer_version, prompt_hash, source_hash);
CREATE INDEX idx_nodes_type        ON analysis_nodes(node_type);
```

**Why `source_hash` AND `input_hash`?**

- `source_hash` is the hash of the source refs — it identifies *what* was analyzed.
- `input_hash` includes `analyzer_id|version|prompt_hash|config_id|source_hash` — it identifies *this specific run* of this analyzer version with this config.
- Idempotency check: `SELECT 1 FROM analysis_nodes WHERE input_hash = ?` — if it exists, skip.
- Source filtering: `SELECT ... WHERE source_hash = ?` — find all analysis for a specific message.

### `node_sources` — Many-to-many source links

A single analysis node can consume multiple sources (messages or other analysis nodes). This join table makes those links queryable.

```sql
CREATE TABLE node_sources (
    node_id     TEXT NOT NULL,
    source_type TEXT NOT NULL,            -- 'message' or 'node'
    source_id   TEXT NOT NULL,           -- messages.id or analysis_nodes.id
    ordinal     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, source_type, source_id)
);
CREATE INDEX idx_sources_target ON node_sources(source_type, source_id);
```

### `analyzer_progress` — Incremental cursor per (analyzer, version, session)

```sql
CREATE TABLE analyzer_progress (
    analyzer_id      TEXT NOT NULL,
    analyzer_version  TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    last_message_id   TEXT,               -- last conversation entry processed
    total_produced    INTEGER DEFAULT 0,
    last_run_at       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'ok',  -- 'ok'|'in_progress'|'needs_rerun'
    error_message     TEXT,
    PRIMARY KEY (analyzer_id, analyzer_version, session_id)
);
```

### Relationship to existing tables

```
sessions
  ├── messages (conversation entries)
  │     └── analysis_nodes.anchor_entry_id → messages.id
  ├── analysis_nodes (grafted onto the tree)
  │     ├── parent_id → analysis_nodes.id (self-referential)
  │     ├── analyzer_id + analyzer_version → analyzers(id, version)
  │     ├── prompt_hash → prompt_registry.hash
  │     └── config_id → analyzer_configs.id
  ├── node_sources (links from nodes to sources)
  │     ├── node_id → analysis_nodes.id
  │     └── source_id → messages.id OR analysis_nodes.id
  ├── proposals (existing — populated from analysis_nodes)
  │     └── source_node_id → analysis_nodes.id
  └── analyzer_progress (cursor per analyzer per session)

analyzers (per-version registration)
analyzer_configs (versioned config values)
prompt_registry (content-addressed prompts)
```

---

## Graph Navigation

### Visual

```
Conversation tree (read-only, synced from Pi sessions):
  msg_001 (user: "fix the auth bug")
  msg_002 (assistant: reads auth.ts)
    msg_003 (toolResult: 3KB)
  msg_004 (assistant: edits auth.ts)
    msg_005 (toolResult: "matched 2 lines")
  msg_006 (user: "no, wrong function — change verifyToken not authenticate")
  msg_007 (assistant: reads auth.ts again)
    msg_008 (toolResult: 2KB)
  msg_009 (assistant: edits auth.ts, successful)

Analysis tree (append-only, grafted onto conversation):
  msg_006 ← an:AA01 (pair-friction, anchor_span=entry_pair)
           ← an:AA02 (pair-friction, deterministic tier)
           ← an:BB01 (session-overview, anchor_span=full_session)
                        source_ids: [an:AA01, an:AA02, ...]
```

### Queries

```sql
-- From a conversation message, find all analysis:
SELECT * FROM analysis_nodes WHERE anchor_entry_id = 'msg_006';

-- Walk up the analysis tree:
WITH RECURSIVE analysis_path AS (
    SELECT * FROM analysis_nodes WHERE id = 'an:BB01'
    UNION ALL
    SELECT an.* FROM analysis_nodes an
    JOIN analysis_path ap ON an.id = ap.parent_id
) SELECT * FROM analysis_path;

-- Find all nodes that consumed a given node:
SELECT an.* FROM analysis_nodes an
JOIN node_sources ns ON an.id = ns.node_id
WHERE ns.source_type = 'node' AND ns.source_id = 'an:AA01';

-- Find all proposals from session-overview analysis:
SELECT an.* FROM analysis_nodes an
JOIN analyzers a ON an.analyzer_id = a.id AND an.analyzer_version = a.version
WHERE a.name = 'session-overview' AND an.session_id = ?;

-- Idempotency check: does this exact run already exist?
SELECT 1 FROM analysis_nodes WHERE input_hash = ?;

-- Find all analysis for a message from a specific analyzer version:
SELECT an.* FROM analysis_nodes an
WHERE an.anchor_entry_id = 'msg_006'
  AND an.analyzer_id = 'pair-friction'
  AND an.analyzer_version = 'abc1234';
```

---

## Analyzer Interface

```typescript
/**
 * An analyzer produces analysis nodes from conversation messages
 * or from other analyzers' nodes.
 */
export interface Analyzer {
    /** Unique identifier: "pair-friction", "session-overview" */
    id: string;

    /** Current version — git commit hash of the analyzer source */
    version: string;

    /** Human-readable label */
    label: string;

    /** What this analyzer does */
    description: string;

    /** Analyzer IDs this depends on. Empty = reads only conversation messages. */
    dependencies: string[];

    /** Whether this analyzer uses LLM calls or is purely code */
    isDeterministic: boolean;

    /** Which model tier to use (NULL for deterministic analyzers) */
    modelTier?: "cheap" | "mid" | "expensive";

    /** Prompt templates keyed by role. Stored in prompt_registry by hash. */
    getPrompts(): Record<string, string>;

    /** Current config (thresholds, patterns, etc.). Versioned automatically. */
    getConfig(): Record<string, unknown>;

    /**
     * Determine which sources need analysis for a given session.
     * The framework calls this, filters out units that already have nodes
     * (idempotency check), and passes remaining units to analyze().
     */
    plan(ctx: PlanContext): Promise<AnalysisUnit[]>;

    /**
     * Produce one analysis node for a single unit of work.
     * The framework handles: idempotency, node creation, source linking,
     * cost tracking, error recording.
     */
    analyze(unit: AnalysisUnit, ctx: RunContext): Promise<AnalysisResult>;
}

/** A single unit of work for an analyzer */
export interface AnalysisUnit {
    /** Source references (message IDs or node IDs) */
    sources: SourceRef[];
    /** Precomputed hash of sorted source refs for idempotency */
    sourceHash: string;
    /** Anchor entry ID (the conversation message this unit is about) */
    anchorEntryId: string | null;
    /** Anchor span type */
    anchorSpan: "single_entry" | "entry_pair" | "segment" | "full_session";
    /** Analyzer-specific metadata about this unit */
    meta?: Record<string, unknown>;
}

export interface SourceRef {
    type: "message" | "node";
    id: string;
}

/** Context provided during planning */
export interface PlanContext {
    sessionId: string;
    /** All messages in this session (ordered) */
    messages: MessageRow[];
    /** Query nodes from declared dependencies only */
    getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
    /** Query own nodes (for incremental skip) */
    getOwnNodes(): AnalysisNodeRow[];
    /** Database access (read-only for planning) */
    db: Database;
}

/** Context provided during analysis */
export interface RunContext {
    /** Read a message by ID */
    getMessage(id: string): MessageRow | undefined;
    /** Read a dependency node by ID */
    getNode(id: string): AnalysisNodeRow | undefined;
    /** Query dependency nodes by analyzer ID */
    getDependencyNodes(analyzerId: string, sessionId: string): AnalysisNodeRow[];
    /** Invoke an LLM (framework resolves model tier to actual model) */
    llm(request: LLMRequest): Promise<LLMResponse>;
    /** Current prompt hash */
    promptHash: string | null;
    /** Current config ID */
    configId: string;
    /** Database access (read-only for analysis) */
    db: Database;
}

export interface AnalysisResult {
    /** The analysis output — stored as JSON in analysis_nodes.properties */
    properties: Record<string, unknown>;
    /** LLM model used (if any) */
    modelUsed?: string;
    /** Cost in USD (if any) */
    costUsd?: number;
    /** Wall-clock duration in ms */
    durationMs?: number;
}

export interface LLMRequest {
    modelTier: "cheap" | "mid" | "expensive";
    messages: Array<{ role: string; content: string }>;
    schema?: Record<string, unknown>;  // structured output schema
}

export interface LLMResponse {
    parsed: Record<string, unknown>;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
}
```

---

## Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Framework: runAnalyzer(analyzer, sessionId)                    │
│                                                                  │
│  1. Register analyzer + store prompts + resolve config           │
│  2. Call plan(ctx) → AnalysisUnit[]                               │
│  3. For each unit:                                                │
│     a. Compute sourceHash = SHA256(sorted source refs)           │
│     b. Compute inputHash = SHA256(                               │
│          analyzer_id | version | prompt_hash | config_id         │
│          | sourceHash)                                            │
│     c. Check idempotency:                                        │
│        SELECT 1 FROM analysis_nodes WHERE input_hash = ?          │
│        → if exists, skip                                          │
│     d. Set progress.status = 'in_progress'                       │
│     e. Call analyze(unit, ctx)                                    │
│     f. INSERT INTO analysis_nodes (append-only)                   │
│     g. INSERT INTO node_sources for each source                  │
│     h. UPDATE progress cursor                                    │
│  4. Set progress.status = 'ok'                                    │
│  5. Return: { produced: N, skipped: M, errors: E }              │
└─────────────────────────────────────────────────────────────────┘
```

### Parallelism

For analyzers where each unit is independent (like `pair-friction`), the framework can run `analyze()` calls concurrently with a configurable concurrency limit. The `plan()` step is always serial.

### Crash Recovery

- **Between step 3a and 3f** (analysis succeeded but INSERT failed): the node is lost. Re-running produces the same `input_hash`, so the unit will be re-analyzed. Acceptable since analysis is deterministic or idempotent (same inputs → same results for deterministic; for LLM, near-equivalent is fine).
- **Between step 3f and 3g** (node inserted but sources not linked): the node exists but has no source links. The idempotency check passes, so it won't be re-computed. A repair pass can re-link orphaned nodes.
- **Between step 3g for different units**: remaining units are unprocessed. Their `input_hash` won't exist. Next run picks them up.

---

## Dependency Visibility

When `session-overview` declares `dependencies: ["pair-friction"]`:

1. The framework ensures `pair-friction` has run for this session before running `session-overview`.
2. `ctx.getDependencyNodes("pair-friction")` queries:
   ```sql
   SELECT * FROM analysis_nodes
   WHERE analyzer_id = 'pair-friction'
     AND session_id = ?
     AND status = 'ok'
   ORDER BY created_at ASC
   ```
3. All other analyzers' nodes are hidden from the context.

An analyzer with `dependencies: []` sees only conversation messages — no analysis nodes.

---

## Model Tier Resolution

```typescript
interface ModelTierConfig {
    cheap: string;      // "google/gemini-2.5-flash" — for pair-friction enrichment
    mid: string;        // "anthropic/claude-sonnet-4" — for session-overview
    expensive: string; // "anthropic/claude-opus-4" — for meta-analysis (rare)
}
```

Analyzers request tiers, not specific models. Users control cost vs. quality globally in `~/.pi/agent/prospector.json`:

```json
{
    "modelTiers": {
        "cheap": "google/gemini-2.5-flash",
        "mid": "anthropic/claude-sonnet-4",
        "expensive": "anthropic/claude-opus-4"
    },
    "maxConcurrency": 5,
    "maxCostPerRun": 1.00
}
```

The framework resolves `ctx.llm({ modelTier: "cheap" })` to the configured model.

---

## Incremental Run Lifecycle

```
On every sync (can run every minute):
  1. Sync new session data into SQLite (existing pi-prospector sync)
  2. For each registered analyzer, in dependency order:
     a. For each session with new messages since last progress cursor:
        i.   Call plan() → get analysis units
        ii.  Filter out units with existing input_hash (idempotency)
        iii. For deterministic analyzers: run immediately, no LLM cost
        iv.  For LLM analyzers: run with concurrency limit and cost budget
        v.   Record results + update progress cursor
  3. Extract proposals from session-overview nodes → proposals table
  4. Report: { analyzer: "pair-friction", produced: 47, skipped: 1203, errors: 0 }
```

---

## Analyzer 1: `pair-friction`

Per user→assistant message pair.

| Attribute | Value |
|-----------|-------|
| `id` | `pair-friction` |
| `dependencies` | `[]` |
| `anchor_span` | `entry_pair` |
| `isDeterministic` | `true` (Tier 0) |
| `model_tier` | `NULL` |

### Deterministic Analysis (Tier 0 — always runs, free)

For each (user_message, assistant_response) pair:

```typescript
properties = {
    // --- Correction detection (regex) ---
    correction_detected: boolean,          // matches correction patterns
    correction_patterns: string[],         // which patterns matched
    correction_type: string | null,       // "redirect"|"explicit"|"repetition"|"abandonment"|null
    correction_text: string | null,        // the corrective instruction text

    // --- Tool metrics ---
    tool_call_count: number,
    tool_names: string[],
    tool_failure_count: number,            // tool results with isError=true
    tool_failure_details: Array<{ name: string, error: string }>,

    // --- Tool waste ---
    tool_result_bytes: number,             // total bytes of tool results
    tool_waste_bytes: number,              // bytes from results never referenced later

    // --- Timing ---
    elapsed_seconds: number | null,       // seconds between user msg and assistant response

    // --- Model info ---
    model: string | null,
    stop_reason: string | null,           // "stop"|"length"|"toolUse"|"error"|"aborted"

    // --- Friction ---
    friction_score: number,                // 0.0-1.0 (computed from signals)
    has_thinking: boolean,
    thinking_length: number,
}
```

**Correction detection patterns:**

```typescript
const CORRECTION_STRONG = [
    /\bno[,.!?\s]/i,
    /\bnot (that|like|quite|exactly)\b/i,
    /\bwrong\b/i,
    /\bactually[,.!?\s]/i,
    /\bI (said|told|mentioned|asked)\b/i,
    /\bdon'?t (do|use|run|write|create)\b/i,
    /\b(should|need|must) (be|use|have)\b/i,
    /\b(instead|rather)\b/i,
    /\bthat'?s not (right|correct|what I)\b/i,
];

const CORRECTION_WEAK = [
    /\bwait\b/i,
    /\bhm+\b/i,
    /\b(still|yet)\b/i,
];

const CORRECTION_NEGATIVE = [
    /\bno worries\b/i,
    /\blooks? good\b/i,
    /\bthat'?s (great|fine|correct|right|perfect)\b/i,
    /\b(thanks|thank you)\b/i,
];
```

**Friction score formula:**

```
friction_score = (
    (correction_detected ? 0.4 : 0) +
    (tool_failure_count > 0 ? 0.3 : 0) +
    (tool_waste_bytes > 10000 ? 0.2 : 0) +
    (correction_patterns.length > 1 ? 0.1 : 0) +
    (elapsed_seconds > 120 ? 0.05 : 0) +
    (stop_reason === "error" ? 0.3 : 0) +
    (stop_reason === "aborted" ? 0.2 : 0)
)
// Capped to [0, 1]
```

### Plan Logic

```typescript
plan(ctx: PlanContext): AnalysisUnit[] {
    const units = [];
    const messages = ctx.messages;

    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== "user") continue;
        // Find next assistant message
        let j = i + 1;
        while (j < messages.length && messages[j].role !== "assistant") j++;
        if (j >= messages.length) continue;

        const sources: SourceRef[] = [
            { type: "message", id: messages[i].id },
            { type: "message", id: messages[j].id },
        ];
        // Include intervening tool results
        for (let k = i + 1; k < j; k++) {
            if (messages[k].role === "toolResult") {
                sources.push({ type: "message", id: messages[k].id });
            }
        }

        units.push({
            sources,
            sourceHash: computeSourceHash(sources),
            anchorEntryId: messages[i].id,
            anchorSpan: "entry_pair",
            meta: { userIndex: i, assistantIndex: j },
        });
    }
    return units;
}
```

---

## Analyzer 2: `pair-friction-llm`

LLM enrichment for pairs that the deterministic tier flagged. Depends on `pair-friction`.

| Attribute | Value |
|-----------|-------|
| `id` | `pair-friction-llm` |
| `dependencies` | `["pair-friction"]` |
| `anchor_span` | `entry_pair` |
| `isDeterministic` | `false` |
| `model_tier` | `cheap` |

### Plan Logic

Only enqueues units where the deterministic `pair-friction` node has `correction_detected: true` or `friction_score >= 0.4`:

```typescript
plan(ctx: PlanContext): AnalysisUnit[] {
    const deterministicNodes = ctx.getDependencyNodes("pair-friction");
    const highSignal = deterministicNodes.filter(n => {
        const props = JSON.parse(n.properties);
        return props.correction_detected || props.friction_score >= 0.4;
    });

    return highSignal.map(n => ({
        sources: [{ type: "node", id: n.id }],
        sourceHash: computeSourceHash([{ type: "node", id: n.id }]),
        anchorEntryId: n.anchor_entry_id,
        anchorSpan: "entry_pair" as const,
        meta: { deterministicNodeId: n.id },
    }));
}
```

### LLM Properties (Tier 1)

```typescript
properties = {
    sentiment: "positive" | "neutral" | "negative" | "frustrated",
    frustration_level: number,             // 0-10
    correction_type: "explicit" | "implicit" | "repetition" | null,
    friction_cause: "tool_failure" | "misunderstanding" | "missing_context" |
                    "wrong_approach" | "incorrect_output" | null,
    friction_summary: string | null,        // 1-2 sentence description (null if no friction)
    user_intent: string,                   // what the user was trying to accomplish
    quality_score: number,                 // 1-5: how well the assistant served the user
}
```

### Prompt (stored in `prompt_registry`)

```
You analyze a single user→assistant exchange from a coding agent session.

USER: {user_text}
AGENT: {assistant_text}

Classify this exchange:
- sentiment: How does the user feel? (positive/neutral/negative/frustrated)
- frustration_level: 0 (none) to 10 (extreme)
- correction_type: explicit, implicit, repetition, or null
- friction_cause: tool_failure, misunderstanding, missing_context,
  wrong_approach, incorrect_output, or null
- friction_summary: If friction_cause != null, describe in 1-2 sentences.
- user_intent: What was the user trying to accomplish? (1 sentence)
- quality_score: 1-5, how well did the assistant serve the user's intent?

Return JSON only. No explanation.
```

---

## Analyzer 3: `session-overview`

Per-session analysis using map-reduce compression. Depends on `pair-friction` and `pair-friction-llm`.

| Attribute | Value |
|-----------|-------|
| `id` | `session-overview` |
| `dependencies` | `["pair-friction", "pair-friction-llm"]` |
| `anchor_span` | `full_session` |
| `isDeterministic` | `false` (but has a deterministic aggregation phase) |
| `model_tier` | `mid` |

### Properties Produced

```typescript
properties = {
    // --- Aggregated deterministic stats (from pair-friction nodes) ---
    total_pairs: number,
    friction_pairs: number,          // pairs with friction_score >= 0.4
    correction_count: number,
    avg_quality_score: number,
    dominant_friction_type: string,
    tool_failure_rate: number,

    // --- LLM-produced ---
    session_summary: string,
    key_friction_points: Array<{
        description: string;
        pair_node_id: string;       // reference to pair-friction node
        severity: "low" | "medium" | "high";
    }>,
    improvement_proposals: Array<{
        target_type: "agents_md" | "system_md" | "skill" | "extension" |
                     "tool_output" | "repo_doc";
        target_path: string;
        description: string;
        rationale: string;
        confidence: number;          // 0.0-1.0
        evidence_node_ids: string[]; // references to pair-friction nodes
    }>,
    sentiment_arc: Array<{
        segment: number;            // 0-based segment index
        sentiment: string;
        key_event: string;
    }>,
}
```

### Context Budget Strategy

```
Available context = model_context_window - system_prompt (~1K tokens) - tool_schema (~1K tokens)

Phase 1: Build a structured digest from deterministic data
  - For each pair-friction node: (user_intent, quality_score, friction_type, friction_summary)
  - For each pair-friction-llm node: (sentiment, frustration_level, friction_cause)
  - Include: compaction summaries (verbatim from session)
  - Include: file operations, git operations, token usage
  - Exclude: full tool result content, full assistant text, thinking blocks

Phase 2: Check if digest fits in context budget
  If fits:
    Send digest directly to LLM → single call
  Else:
    Split into segments (by time or pair count, never splitting a pair)
    MAP phase: summarize each segment with cheap model
    REDUCE phase: combine segment summaries + aggregated stats → mid model call
```

### Plan Logic

One unit per session. All pair-friction and pair-friction-llm nodes for this session are sources.

```typescript
plan(ctx: PlanContext): AnalysisUnit[] {
    const pairNodes = ctx.getDependencyNodes("pair-friction");
    const llmNodes = ctx.getDependencyNodes("pair-friction-llm");
    if (pairNodes.length === 0) return []; // pair-friction hasn't run yet

    const sources: SourceRef[] = [
        ...pairNodes.map(n => ({ type: "node" as const, id: n.id })),
        ...llmNodes.map(n => ({ type: "node" as const, id: n.id })),
    ];

    return [{
        sources,
        sourceHash: computeSourceHash(sources),
        anchorEntryId: null,  // session-level
        anchorSpan: "full_session",
    }];
}
```

---

## Proposals: Derived from Analysis Nodes

Proposals are **second-order artifacts** — they're generated from `session-overview` analysis nodes and stored in the existing `proposals` table for efficient retrieval and user interaction.

```sql
-- Existing proposals table (unchanged from current pi-prospector)
-- with an added column linking back to the analysis node
ALTER TABLE proposals ADD COLUMN source_node_id TEXT REFERENCES analysis_nodes(id);
```

Extraction after `session-overview` runs:

```typescript
function extractProposals(overviewNode: AnalysisNodeRow): NewProposal[] {
    const props = JSON.parse(overviewNode.properties);
    return (props.improvement_proposals ?? []).map(p => ({
        session_id: overviewNode.session_id,
        target_type: p.target_type,
        target_path: p.target_path,
        description: p.description,
        severity: p.severity ?? "suggestion",
        confidence: p.confidence,
        source_node_id: overviewNode.id,
        // dedup_hash computed from target_type + target_path + normalized description
    }));
}
```

---

## Versioning and Meta-Analysis

### Analyzer Upgrade Flow

When `pair-friction` is upgraded from commit `abc1234` to `def5678`:

1. Framework registers `pair-friction@def5678` in `analyzers` table
2. All `pair-friction@abc1234` nodes remain (append-only)
3. `analyzer_progress` has no entry for `pair-friction@def5678` → framework runs analysis
4. Dependent analyzers (`pair-friction-llm`, `session-overview`) are not automatically re-run — they can reference either version via `dependencies`
5. If the user wants to cascade upgrades: `/prospect-run --cascade pair-friction`

### Config Change Flow

When the correction detection threshold changes from `0.3` to `0.4`:

1. `resolveConfig()` hashes the new config → gets a new `config_id`
2. `input_hash` now includes the new `config_id` → all pair-friction nodes need re-analysis
3. `analyzer_progress` is reset → next run processes all sessions again
4. Old nodes with the old `config_id` remain in the database for comparison

### Prompt Change Flow

When the LLM prompt template is updated:

1. `storePrompt()` hashes the new prompt → gets a new `prompt_hash`
2. The analyzer record is updated with the new `prompt_hash`
3. `input_hash` changes → `pair-friction-llm` nodes need re-analysis
4. Old `pair-friction-llm` nodes remain (they have the old `prompt_hash` in their row)

### Meta-Analysis Queries

```sql
-- Which prompt version produced the most friction detections?
SELECT p.hash, p.label, COUNT(*) as node_count
FROM analysis_nodes an
JOIN prompt_registry p ON an.prompt_hash = p.hash
WHERE an.analyzer_id = 'pair-friction-llm'
GROUP BY p.hash, p.label
ORDER BY node_count DESC;

-- Compare correction detection rates across analyzer versions:
SELECT an.analyzer_version, AVG(CAST(an.properties->>'friction_score' AS REAL)) as avg_friction
FROM analysis_nodes an
WHERE an.analyzer_id = 'pair-friction'
GROUP BY an.analyzer_version;

-- Did a threshold change affect detection rates?
SELECT c.config, COUNT(*) as detections
FROM analysis_nodes an
JOIN analyzer_configs c ON an.config_id = c.id
WHERE an.analyzer_id = 'pair-friction'
  AND an.properties->>'correction_detected' = 'true'
GROUP BY c.config;

-- Find sessions with high friction but no proposals (opportunity):
SELECT s.id
FROM sessions s
WHERE EXISTS (
    SELECT 1 FROM analysis_nodes an
    WHERE an.session_id = s.id
      AND an.analyzer_id = 'pair-friction'
      AND CAST(an.properties->>'friction_score' AS REAL) > 0.7
)
AND NOT EXISTS (
    SELECT 1 FROM analysis_nodes an2
    WHERE an2.session_id = s.id
      AND an2.analyzer_id = 'session-overview'
);
```

---

## File Layout

```
src/
├── analyze/
│   ├── framework.ts              -- runAnalyzer(), registerAnalyzer(), runAll()
│   ├── types.ts                  -- Analyzer, AnalysisUnit, PlanContext, RunContext, etc.
│   ├── registry.ts               -- DB operations for analyzers, prompts, configs, nodes, sources
│   ├── visibility.ts             -- Dependency-scoped query helpers
│   ├── hash.ts                   -- computeSourceHash(), computeInputHash()
│   ├── model-tiers.ts            -- ModelTierConfig, resolveModelTier()
│   ├── analyzers/
│   │   ├── pair-friction/
│   │   │   ├── index.ts          -- Analyzer implementation (plan + analyze)
│   │   │   ├── patterns.ts       -- Correction/frustration regex patterns
│   │   │   └── config.ts        -- Default config + schema
│   │   ├── pair-friction-llm/
│   │   │   ├── index.ts          -- LLM enrichment analyzer
│   │   │   ├── prompt.ts         -- Prompt template + structured output schema
│   │   │   └── config.ts
│   │   └── session-overview/
│   │       ├── index.ts          -- Session analysis with map-reduce
│   │       ├── digest.ts         -- Build structured session digest
│   │       ├── compress.ts       -- Map-reduce compression for large sessions
│   │       ├── prompt.ts         -- Session analysis prompt + schema
│   │       └── config.ts
│   └── index.ts                  -- Barrel export
├── db/
│   ├── schema.ts                 -- (existing) + new tables
│   ├── queries.ts                 -- (existing) + new query functions
│   └── analysis-queries.ts       -- Queries specific to analysis_nodes, analyzers, sources
├── commands/
│   ├── sync.ts                   -- (existing)
│   ├── stats.ts                  -- (existing)
│   ├── proposals.ts              -- (existing, updated to read from analysis_nodes)
│   ├── analyze.ts                -- (existing, updated to use framework)
│   ├── tool.ts                   -- (existing, updated)
│   ├── prospect-run.ts           -- NEW: /prospect-run [analyzer] [session]
│   └── prospect-graph.ts        -- NEW: /prospect-graph [anchor] (navigate the analysis graph)
└── types.ts                      -- (existing) + new types
```

---

## Migration Path from Current `proposals` Table

The existing `proposals` table remains for now — it's populated by the old `/prospect-analyze` command. The new architecture subsumes it:

1. `session-overview` produces `improvement_proposals` in its `properties`
2. `/prospect-proposals` reads from both tables during transition:
   - Old proposals from `proposals` table
   - New proposals from `analysis_nodes` WHERE `analyzer_id = 'session-overview'`
3. Eventually deprecate the `proposals` table

---

## Edge Cases

### Compaction Events

Pi sessions contain `compactionSummary` entries. The framework handles these:

- **Sync**: Stored as messages with `role = "compactionSummary"` and `content_text = summary text`
- **pair-friction**: Does NOT create pairs for compactionSummary entries (they have no assistant response)
- **session-overview**: Includes compaction summary text as compressed pre-compaction context. Post-compaction messages are sent in full detail alongside their pair-friction analysis nodes.

### Forked Sessions

Pi sessions can be forked (parentSession in header). The framework:

- Sync already resolves forks and stores `parent_session` in `sessions` table
- Analyzers that want cross-fork context can follow `parent_session`
- Out of scope for initial analyzers

### Very Long Sessions (545MB / 1400+ sessions)

- **Sync**: Already handles incremental parsing
- **pair-friction (Tier 0)**: Deterministic, no LLM, milliseconds per pair. Can process thousands.
- **pair-friction-llm (Tier 1)**: Only runs on high-signal pairs (maybe 10-20% of pairs)
- **session-overview**: Map-reduce with budget-aware chunking. A 200-message session ≈ 9 LLM calls with Haiku (~$0.09)
- **Progress tracking**: Only new messages since last cursor are analyzed

### Deleted Session Files

- Analysis nodes persist in SQLite even if the session JSONL is deleted
- Queries joining to `messages` or `sessions` will return no matches for deleted sessions
- The analysis graph is still navigable (it's self-contained via `parent_id` and `node_sources`)
- `/prospect-graph` can show analysis for orphaned session references

---

## Incremental Run Schedule

| When | What | Cost |
|------|------|------|
| Every sync (1 min) | Run `pair-friction` Tier 0 on new messages | Free (deterministic) |
| Every sync (1 min) | Update `analyzer_progress` cursors | Free |
| On demand (or daily) | Run `pair-friction-llm` on high-signal pairs | ~$0.01/session |
| On demand (or daily) | Run `session-overview` on sessions with new analysis | ~$0.05-0.15/session |
| On demand | Extract proposals from `session-overview` nodes | Free (database query) |

---

## Open Questions (TBD)

1. **Sub-agent implementation**: Should LLM analysis calls use `pi -p` subprocess or in-process `completeSimple()` from `@marendil-works/pi-ai`? Start with in-process — it's simpler and avoids process spawn overhead. The `RunContext.llm()` abstraction hides this choice.

2. **Structured output**: Tool-call schemas (like pi-reflect) or JSON mode? Tool-call schemas are more reliable across models. Start with tool-call schemas.

3. **Batch optimization**: Should `pair-friction-llm` batch multiple pairs into one LLM call? Yes — 5-10 pairs per call reduces overhead significantly. The `plan()` step can group adjacent high-signal pairs into batches.

4. **Cost budgets**: Should the framework enforce per-session or per-day cost limits? Yes — add a `maxCostPerRun` config that aborts after threshold is exceeded.

5. **Node garbage collection**: Should old analyzer versions' nodes be archived? Not in v1 — queries filter by `(analyzer_id, analyzer_version)` to see only current results. A future `/prospect-gc` command could optionally archive old-version nodes.

6. **Config version cascading**: When `pair-friction` config changes, should `session-overview` automatically re-run? Not in v1 — the user controls when to re-run. Future: `/prospect-run --cascade pair-friction`.