# Analyzer Framework Design

## Overview

The analyzer framework extends the existing pi-prospector conversation graph with **analysis nodes** — an append-only graph grafted onto the session tree. Analyzers produce versioned, idempotent artifacts that reference specific source messages and can depend on other analyzers' outputs.

```
Conversation Graph (read-only, synced from Pi sessions):
  msg_1 → msg_2 → msg_3 → [compaction] → msg_4 → msg_5

Analysis Graph (append-only, produced by analyzers):
  msg_1 ← pair_node_1 (pair-friction v1, prompt_v3)
  msg_2 ← pair_node_2 (pair-friction v1, prompt_v3)
  msg_3 ← pair_node_3 (pair-friction v1, prompt_v3)
  msg_4 ← pair_node_4 (pair-friction v1, prompt_v3)
  msg_5 ← pair_node_5 (pair-friction v1, prompt_v3)
  session ← overview_node_1 (session-overview v1, prompt_v7)
              sources: [pair_node_1..5]  (declares dependency on pair-friction)
```

## Core Principles

1. **Append-only**: Analysis nodes are never modified. A new analysis with different parameters produces a new node. Old nodes remain for auditability.

2. **Idempotent**: Running an analyzer again with the same (analyzer_version, prompt_version, source_refs) produces no new nodes — it detects existing artifacts and skips.

3. **Crash-recoverable**: If an analyzer crashes mid-run, re-running it picks up where it left off by checking which source combinations already have nodes.

4. **Versioned**: Every node traces back to the exact analyzer commit and prompt text that produced it. Prompts are content-addressed (stored by hash), so identical prompts across versions share a single entry.

5. **Dependency-scoped visibility**: An analyzer only sees its own nodes plus nodes from analyzers it explicitly declares as dependencies. The framework enforces this at the query layer.

## Schema

### New Tables (added to existing `prospector.db`)

```sql
-- Registered analyzers and their versions
CREATE TABLE IF NOT EXISTS analyzers (
    id TEXT NOT NULL,              -- e.g. "pair-friction", "session-overview"
    version TEXT NOT NULL,         -- semver or commit hash: "1.0.0" or "abc1234"
    registered_at TEXT NOT NULL,   -- ISO timestamp
    description TEXT,              -- human-readable purpose
    dependencies TEXT,             -- JSON array of analyzer IDs this depends on: ["pair-friction"]
    config_schema TEXT,            -- optional JSON Schema for analyzer-specific config
    PRIMARY KEY (id, version)
);

-- Content-addressed prompt store
CREATE TABLE IF NOT EXISTS prompt_versions (
    hash TEXT PRIMARY KEY,         -- SHA-256 of prompt_text (first 16 hex chars)
    analyzer_id TEXT NOT NULL,     -- which analyzer owns this prompt
    prompt_text TEXT NOT NULL,     -- full prompt template
    created_at TEXT NOT NULL,      -- when first stored
    label TEXT                     -- optional human label: "v3-concise", "experiment-sentiment"
);
CREATE INDEX IF NOT EXISTS idx_prompt_analyzer ON prompt_versions(analyzer_id);

-- The analysis graph nodes (append-only)
CREATE TABLE IF NOT EXISTS analysis_nodes (
    id TEXT PRIMARY KEY,           -- UUID v7 (time-sortable)
    analyzer_id TEXT NOT NULL,     -- which analyzer produced this
    analyzer_version TEXT NOT NULL,-- version of the analyzer that ran
    prompt_hash TEXT,              -- references prompt_versions.hash (NULL for deterministic analyzers)
    session_id TEXT NOT NULL,      -- which session this belongs to
    created_at TEXT NOT NULL,      -- ISO timestamp
    source_hash TEXT NOT NULL,     -- SHA-256 of sorted source_refs (for idempotency check)
    properties TEXT NOT NULL,      -- JSON object: the analysis output
    model_used TEXT,               -- LLM model if applicable: "anthropic/haiku-3"
    cost_usd REAL,                 -- cost of producing this node (NULL for deterministic)
    duration_ms INTEGER,           -- wall-clock time to produce this node
    error TEXT,                    -- NULL if successful, error message if failed
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON analysis_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_analyzer ON analysis_nodes(analyzer_id, analyzer_version);
CREATE INDEX IF NOT EXISTS idx_nodes_source_hash ON analysis_nodes(source_hash);
CREATE INDEX IF NOT EXISTS idx_nodes_idempotent ON analysis_nodes(analyzer_id, analyzer_version, prompt_hash, source_hash);

-- Links from analysis nodes to their source messages or other nodes
-- A node can have multiple sources (e.g., session-overview depends on all pair nodes)
CREATE TABLE IF NOT EXISTS node_sources (
    node_id TEXT NOT NULL,         -- the analysis node
    source_type TEXT NOT NULL,     -- "message" or "node"
    source_id TEXT NOT NULL,       -- messages.id or analysis_nodes.id
    ordinal INTEGER NOT NULL DEFAULT 0,  -- ordering within the source set
    PRIMARY KEY (node_id, source_type, source_id),
    FOREIGN KEY (node_id) REFERENCES analysis_nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_sources_target ON node_sources(source_type, source_id);
```

### Idempotency Key

A node is uniquely identified by:
```
(analyzer_id, analyzer_version, prompt_hash, source_hash)
```

Where `source_hash = SHA-256(sort(source_refs).join("|"))`.

Before producing a node, the analyzer checks:
```sql
SELECT id FROM analysis_nodes
WHERE analyzer_id = ? AND analyzer_version = ? AND prompt_hash = ? AND source_hash = ?
```

If a row exists → skip (already computed). This makes the entire framework idempotent.

### Append-Only Guarantees

- No `UPDATE` or `DELETE` on `analysis_nodes` or `node_sources`.
- The only mutable field is `analyzers.registered_at` (updated on re-registration with same version — a no-op in practice).
- Old nodes are never removed. If an analyzer version changes, it produces new nodes alongside the old ones.
- Queries filter by `(analyzer_id, analyzer_version)` to see only current results.

## Analyzer Interface

```typescript
/**
 * An analyzer produces analysis nodes from conversation messages
 * or from other analyzers' nodes.
 */
export interface Analyzer {
    /** Unique identifier: "pair-friction", "session-overview" */
    id: string;

    /** Current version (semver or commit hash) */
    version: string;

    /** Human-readable description */
    description: string;

    /** Analyzer IDs this depends on. Empty = no dependencies. */
    dependencies: string[];

    /**
     * Called once when the analyzer is registered.
     * Returns the prompt(s) this analyzer uses, keyed by role.
     * Each prompt is content-addressed and stored in prompt_versions.
     */
    getPrompts(): Record<string, string>;

    /**
     * Determine which sources need analysis for a given session.
     * Returns groups of source references that should each produce one node.
     *
     * The framework calls this, filters out groups that already have nodes
     * (idempotency check), and passes the remaining groups to `analyze()`.
     */
    plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]>;

    /**
     * Produce one analysis node for a single unit of work.
     * Must return the properties JSON or throw an error.
     *
     * The framework handles: idempotency check, node creation,
     * source linking, cost tracking, error recording.
     */
    analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult>;
}

/** A single unit of work for an analyzer */
export interface AnalysisUnit {
    /** Source references (message IDs or node IDs) */
    sources: SourceRef[];

    /** Precomputed source_hash for idempotency */
    sourceHash: string;

    /** Analyzer-specific metadata about this unit (e.g., message pair index) */
    meta?: Record<string, unknown>;
}

export interface SourceRef {
    type: "message" | "node";
    id: string;
}

/** Context provided during planning */
export interface AnalyzerPlanContext {
    /** Session being analyzed */
    sessionId: string;

    /** All messages in this session (ordered by rowid) */
    messages: MessageRow[];

    /** Query nodes from declared dependencies only */
    getDependencyNodes(analyzerId: string): AnalysisNodeRow[];

    /** Query own nodes for this session (for incremental skip) */
    getOwnNodes(): AnalysisNodeRow[];
}

/** Context provided during analysis */
export interface AnalyzerRunContext {
    /** Read a message by ID */
    getMessage(id: string): MessageRow | undefined;

    /** Read a dependency node by ID */
    getNode(id: string): AnalysisNodeRow | undefined;

    /** Query dependency nodes by analyzer ID */
    getDependencyNodes(analyzerId: string, sessionId: string): AnalysisNodeRow[];

    /** Invoke an LLM (abstraction over pi-ai or subshell) */
    llm(request: LLMRequest): Promise<LLMResponse>;

    /** Current prompt hash (set by framework from getPrompts()) */
    promptHash: string | null;
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
```

## Analyzer Execution Flow

```
┌─────────────────────────────────────────────────────────┐
│  Framework: runAnalyzer(analyzer, sessionId)             │
│                                                          │
│  1. Register analyzer + store prompts (if not exists)    │
│  2. Call analyzer.plan(ctx) → AnalysisUnit[]             │
│  3. For each unit:                                       │
│     a. Compute source_hash                               │
│     b. Check idempotency:                                │
│        SELECT FROM analysis_nodes WHERE                   │
│          analyzer_id=? AND version=? AND                  │
│          prompt_hash=? AND source_hash=?                  │
│     c. If exists → skip                                  │
│     d. If not → call analyzer.analyze(unit, ctx)         │
│     e. INSERT INTO analysis_nodes (append-only)          │
│     f. INSERT INTO node_sources for each source          │
│  4. Return: { produced: N, skipped: M, errors: E }      │
└─────────────────────────────────────────────────────────┘
```

### Parallelism

For analyzers where each unit is independent (like `pair-friction`), the framework can run `analyze()` calls concurrently with a configurable concurrency limit. The `plan()` step is always serial.

### Crash Recovery

If the process crashes between step 3d and 3e (analysis succeeded but INSERT failed), the node is lost and will be re-computed on next run — acceptable since analysis is idempotent.

If the process crashes between step 3e and 3f (node inserted but sources not linked), the orphaned node will be detected on next run because the idempotency check passes (node exists for that source_hash), so it won't be re-computed. The missing source links are a minor inconsistency but don't affect correctness — we can add a repair pass that re-links orphaned nodes.

If the process crashes in the middle of processing multiple units, remaining units are simply unprocessed and will be picked up on the next run (their source_hash won't match any existing node).

## Dependency Visibility

When an analyzer declares `dependencies: ["pair-friction"]`, the framework:

1. Ensures `pair-friction` has run for the session before running this analyzer
2. Provides `ctx.getDependencyNodes("pair-friction")` which queries:
   ```sql
   SELECT * FROM analysis_nodes
   WHERE analyzer_id = 'pair-friction'
     AND session_id = ?
     AND error IS NULL
   ORDER BY created_at ASC
   ```
3. Hides all other analyzers' nodes from the context

An analyzer with `dependencies: []` can only see conversation messages — no analysis nodes at all.

## Initial Analyzers

### Analyzer 1: `pair-friction`

**Purpose**: Analyze individual user→assistant message pairs for friction signals.

**Scope**: One `(user_message, assistant_response)` pair per node.

**Parallelism**: Yes — each pair is independent.

**Dependencies**: None (reads only conversation messages).

**Properties produced**:

```typescript
interface PairFrictionProperties {
    // Deterministic (regex-based, no LLM needed)
    correction_detected: boolean;    // user message matches correction patterns
    frustration_signals: string[];   // matched patterns: "no", "wrong", "actually", "I said"
    tool_failure_count: number;      // tool results with isError=true in assistant response
    retry_detected: boolean;         // same tool called 2+ times in the response

    // LLM-produced (cheap model: Haiku/Flash)
    sentiment: "positive" | "neutral" | "negative" | "frustrated";
    friction_type: "none" | "misunderstanding" | "tool_failure" | "wrong_approach" |
                   "slow_response" | "missing_context" | "incorrect_output";
    friction_summary: string | null; // 1-2 sentence description (null if no friction)
    user_intent: string;             // what the user was trying to accomplish
    quality_score: number;           // 1-5: how well the assistant served the user
}
```

**Plan logic**:
```typescript
plan(ctx) {
    const units: AnalysisUnit[] = [];
    const messages = ctx.messages;

    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== "user") continue;

        // Find the next assistant message (may not be immediate due to tool results)
        let j = i + 1;
        while (j < messages.length && messages[j].role !== "assistant") j++;
        if (j >= messages.length) continue;

        // Also gather any tool results between user and assistant
        const sources: SourceRef[] = [
            { type: "message", id: messages[i].id },
            { type: "message", id: messages[j].id },
        ];
        // Include intervening tool results as sources
        for (let k = i + 1; k < j; k++) {
            if (messages[k].role === "toolResult") {
                sources.push({ type: "message", id: messages[k].id });
            }
        }

        units.push({ sources, sourceHash: computeSourceHash(sources) });
    }

    return units;
}
```

**Analysis logic**:
```typescript
analyze(unit, ctx) {
    const userMsg = ctx.getMessage(unit.sources[0].id);
    const assistantMsg = ctx.getMessage(unit.sources[1].id);
    const toolResults = unit.sources.slice(2).map(s => ctx.getMessage(s.id));

    // Phase 1: Deterministic extraction (always runs, free)
    const deterministic = {
        correction_detected: matchesCorrectionPattern(userMsg.content_text),
        frustration_signals: extractFrustrationSignals(userMsg.content_text),
        tool_failure_count: toolResults.filter(r => r?.tool_results?.[0]?.isError).length,
        retry_detected: detectRetries(assistantMsg.tool_calls),
    };

    // Phase 2: LLM classification (cheap model)
    const llmResult = await ctx.llm({
        model: "cheap",  // resolved by framework to configured cheap model
        messages: [
            { role: "system", content: PAIR_ANALYSIS_PROMPT },
            { role: "user", content: formatPairForAnalysis(userMsg, assistantMsg, toolResults) },
        ],
        schema: PAIR_FRICTION_SCHEMA,  // structured output
    });

    return {
        properties: { ...deterministic, ...llmResult.parsed },
        modelUsed: llmResult.model,
        costUsd: llmResult.cost,
        durationMs: llmResult.durationMs,
    };
}
```

**Prompt** (stored in `prompt_versions`):
```
You are analyzing a single user→assistant exchange from a coding agent session.

Classify the exchange on these dimensions:
- sentiment: How does the user feel? (positive/neutral/negative/frustrated)
- friction_type: What kind of friction occurred, if any?
  (none/misunderstanding/tool_failure/wrong_approach/slow_response/missing_context/incorrect_output)
- friction_summary: If friction_type != "none", describe in 1-2 sentences what went wrong.
- user_intent: What was the user trying to accomplish? (1 sentence)
- quality_score: 1-5, how well did the assistant serve the user's intent?

Respond with JSON only. No explanation.
```

### Analyzer 2: `session-overview`

**Purpose**: Analyze an entire session by progressively compressing it, then extracting session-level friction patterns and improvement proposals.

**Scope**: One node per session.

**Parallelism**: No — one per session, but sessions can be processed in parallel.

**Dependencies**: `["pair-friction"]` — uses pair-level scores to identify hot spots.

**Properties produced**:

```typescript
interface SessionOverviewProperties {
    // Aggregated from pair-friction nodes (deterministic)
    total_pairs: number;
    friction_pairs: number;          // pairs with friction_type != "none"
    correction_count: number;        // pairs with correction_detected
    avg_quality_score: number;       // mean of all pair quality_scores
    dominant_friction_type: string;  // most common friction_type
    tool_failure_rate: number;       // fraction of pairs with tool failures

    // LLM-produced (mid-range model)
    session_summary: string;         // 3-5 sentence summary of what happened
    key_friction_points: Array<{
        description: string;
        pair_node_id: string;        // reference to the pair-friction node
        severity: "low" | "medium" | "high";
    }>;
    improvement_proposals: Array<{
        target_type: "agents_md" | "system_md" | "skill" | "extension" | "tool_output" | "repo_doc";
        target_path: string;
        description: string;
        rationale: string;
        confidence: number;          // 0.0-1.0
    }>;
    session_sentiment_arc: Array<{   // sentiment over time
        segment: number;             // 0-based segment index
        sentiment: string;
        key_event: string;
    }>;
}
```

**Compression strategy** (not truncation):

The session-overview analyzer uses a **two-phase compression** approach to handle sessions of any size:

```
Phase 1: Build a structured digest from pair-friction nodes + raw messages
  - For each pair-friction node: (user_intent, quality_score, friction_type, friction_summary)
  - Include: compaction summaries (verbatim), file operations, git operations
  - Exclude: full tool result content, full assistant text, thinking blocks
  - This produces a "session digest" that's typically 5-15% of the original

Phase 2: If the digest exceeds the model's context budget:
  - Split into segments (by time or by pair count)
  - Summarize each segment with a cheap model (map step)
  - Combine segment summaries into a final digest (reduce step)
  - Pass the reduced digest to the mid-range model for proposal generation
```

**Plan logic**:
```typescript
plan(ctx) {
    // One unit per session, sourcing all pair-friction nodes
    const pairNodes = ctx.getDependencyNodes("pair-friction");
    if (pairNodes.length === 0) return [];  // pair-friction hasn't run yet

    const sources: SourceRef[] = pairNodes.map(n => ({ type: "node", id: n.id }));

    return [{ sources, sourceHash: computeSourceHash(sources) }];
}
```

**Analysis logic**:
```typescript
analyze(unit, ctx) {
    const pairNodes = unit.sources.map(s => ctx.getNode(s.id)!);
    const properties = pairNodes.map(n => JSON.parse(n.properties));

    // Phase 1: Aggregate deterministic stats
    const stats = {
        total_pairs: pairNodes.length,
        friction_pairs: properties.filter(p => p.friction_type !== "none").length,
        correction_count: properties.filter(p => p.correction_detected).length,
        avg_quality_score: mean(properties.map(p => p.quality_score)),
        dominant_friction_type: mode(properties.map(p => p.friction_type).filter(t => t !== "none")),
        tool_failure_rate: properties.filter(p => p.tool_failure_count > 0).length / pairNodes.length,
    };

    // Phase 2: Build session digest for LLM
    const digest = buildSessionDigest(pairNodes, properties, ctx);

    // Phase 3: Compress if needed (map-reduce for large sessions)
    const compressed = await compressIfNeeded(digest, ctx);

    // Phase 4: Generate proposals with mid-range model
    const llmResult = await ctx.llm({
        model: "mid",
        messages: [
            { role: "system", content: SESSION_OVERVIEW_PROMPT },
            { role: "user", content: compressed },
        ],
        schema: SESSION_OVERVIEW_SCHEMA,
    });

    return {
        properties: { ...stats, ...llmResult.parsed },
        modelUsed: llmResult.model,
        costUsd: llmResult.cost,
        durationMs: llmResult.durationMs,
    };
}
```

## Prompt Versioning

Prompts are content-addressed by their SHA-256 hash:

```typescript
function storePrompt(db: Database, analyzerId: string, promptText: string, label?: string): string {
    const hash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);
    db.prepare(`
        INSERT OR IGNORE INTO prompt_versions (hash, analyzer_id, prompt_text, created_at, label)
        VALUES (?, ?, ?, ?, ?)
    `).run(hash, analyzerId, promptText, new Date().toISOString(), label ?? null);
    return hash;
}
```

When an analyzer is registered, all its prompts are stored:
```typescript
const prompts = analyzer.getPrompts();
const promptHashes: Record<string, string> = {};
for (const [role, text] of Object.entries(prompts)) {
    promptHashes[role] = storePrompt(db, analyzer.id, text, role);
}
```

The `analysis_nodes.prompt_hash` field references the primary prompt used for that node. If an analyzer uses multiple prompts (e.g., map + reduce), the primary prompt_hash points to the final reduce prompt, and the map prompt hash can be stored in `properties.map_prompt_hash`.

### Meta-Analysis

Because every node links back to its prompt via `prompt_hash`, you can:
1. Query all nodes produced by a specific prompt version
2. Compare quality_scores across prompt versions (A/B testing)
3. Find prompts that produce high false-positive friction detection
4. Run a meta-analyzer that takes analysis nodes as input and evaluates prompt effectiveness

## Model Tiers

The framework resolves model tier names to actual models via config:

```typescript
interface AnalyzerModelConfig {
    cheap: string;   // e.g., "anthropic/haiku-3" or "google/gemini-flash"
    mid: string;     // e.g., "anthropic/sonnet-4"
    expensive: string; // e.g., "anthropic/opus-4" (rarely used)
}
```

Analyzers request tiers, not specific models. This lets users control cost vs quality globally.

## Incremental Run Lifecycle

```
1. Sync new session data (existing pi-prospector sync)
2. For each registered analyzer, in dependency order:
   a. For each session with new messages since last analyzer run:
      - Call plan() → get analysis units
      - Filter out units with existing nodes (idempotency)
      - Run analyze() on remaining units (with concurrency limit)
      - Record results
3. Report: { analyzer: "pair-friction", produced: 47, skipped: 1203, errors: 0 }
```

### "Since Last Run" Tracking

Each analyzer tracks its progress per session:

```sql
CREATE TABLE IF NOT EXISTS analyzer_cursors (
    analyzer_id TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_message_id TEXT,          -- last message ID that was part of a plan() output
    last_run_at TEXT NOT NULL,
    PRIMARY KEY (analyzer_id, session_id)
);
```

On incremental run:
1. Get the cursor for this (analyzer, session)
2. Only plan() against messages *after* the cursor's `last_message_id`
3. After successful run, update the cursor

This means: even if a session has 10,000 messages, if only 5 new messages arrived since the last run, only those 5 (and their pairs/context) are planned and analyzed.

## File Layout

```
src/
├── analyzers/
│   ├── framework.ts          -- runAnalyzer(), registerAnalyzer(), runAllAnalyzers()
│   ├── types.ts              -- Analyzer interface, contexts, results
│   ├── registry.ts           -- DB operations for analyzers, prompts, nodes, sources
│   ├── visibility.ts         -- Dependency-scoped query helpers
│   ├── pair-friction/
│   │   ├── index.ts          -- Analyzer implementation
│   │   ├── patterns.ts       -- Correction/frustration regex patterns
│   │   └── prompt.ts         -- Prompt text + schema
│   └── session-overview/
│       ├── index.ts          -- Analyzer implementation
│       ├── digest.ts         -- Session digest builder
│       ├── compress.ts       -- Map-reduce compression for large sessions
│       └── prompt.ts         -- Prompt text + schema
```

## Migration Path from Existing `proposals` Table

The existing `proposals` table remains for now — it's the output of the *old* `/prospect-analyze` command. The new `analysis_nodes` table subsumes it: `session-overview` analyzer produces `improvement_proposals` in its properties, which can be surfaced via the same `/prospect-proposals` command.

Eventually:
- `proposals` table → deprecated, read-only
- `analysis_nodes` WHERE `analyzer_id = 'session-overview'` AND `properties->>'improvement_proposals'` → the new proposals source
- The `/prospect-proposals` command reads from both during transition

## Open Questions (TBD)

1. **Sub-agent implementation**: Should the LLM call be a `pi -p` subprocess or an in-process `completeSimple()` call? For now, use in-process `completeSimple()` from `@earendil-works/pi-ai` since it's simpler and avoids process spawn overhead.

2. **Structured output**: Should we use tool-call schemas (like pi-reflect) or JSON mode? Tool-call schemas are more reliable for structured extraction across models.

3. **Batch optimization**: For `pair-friction`, should we batch multiple pairs into one LLM call? Yes, probably — sending 5-10 pairs per call with a JSON array response would reduce overhead significantly.

4. **Compaction-aware pair detection**: How to handle pairs that span a compaction boundary? The compaction summary becomes a source, and the pair is marked as `partial: true`.

5. **Version migration**: When an analyzer bumps its version, should old nodes be garbage-collected? No — append-only means old nodes stay forever. Queries should filter by `(analyzer_id, analyzer_version)` to see only current results. A separate `/prospect-gc` command could optionally archive old-version nodes.

6. **Cost budgets**: Should the framework enforce per-session or per-day cost limits? Yes — add a `max_cost_per_run` config that aborts after threshold is exceeded.
