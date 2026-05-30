# Analyzer Framework Design

## Overview

The analyzer framework extends pi-prospector's session index with a **graph of analysis nodes** grafted onto the conversation tree. Each analyzer is a versioned, idempotent pipeline that reads conversation entries and produces analysis nodes. The framework handles incremental progress, crash recovery, isolation between analyzers, and dependency chains.

### Key Principles

1. **Append-on-write**: Analysis nodes are never mutated. A new analyzer version creates new nodes; old ones persist in the graph.
2. **Grafted graph**: Analysis nodes use the same `id`/`parent_id` tree structure as Pi sessions, allowing navigation from any leaf to any root.
3. **Idempotent**: `input_hash` on every node means re-running an unchanged analyzer on unchanged input is a no-op.
4. **Incremental**: Cursors track which conversation entries have been processed by each analyzer.
5. **Isolated**: An analyzer sees only its own nodes + nodes from declared dependencies + the conversation tree.

---

## 1. Data Model

### New Tables

```sql
-- ── Analyzer Registry ──
-- One row per version of an analyzer. Upgrading an analyzer inserts a new row;
-- the old row remains for provenance tracking.

CREATE TABLE analyzers (
    id          TEXT NOT NULL,       -- "per-message-pair"
    version     TEXT NOT NULL,       -- git commit hash of the analyzer code
    label       TEXT,                -- human-readable name
    prompt_hash TEXT NOT NULL,       -- SHA256 of the prompt template used
    deps        TEXT NOT NULL DEFAULT '[]',  -- JSON array of analyzer ids this depends on
    description TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (id, version)
);

-- ── Analysis Graph ──
-- Each row is a node in the analysis graph. The graph extends Pi's session tree:
--   anchor_entry_id → the conversation message this node is "about" (NULL for session-level nodes)
--   parent_id       → parent in the *analysis* graph (connects analysis nodes to each other)
--   source_ids      → what this analysis consumed (for dependency tracking)

CREATE TABLE analysis_nodes (
    id              TEXT PRIMARY KEY,    -- UUID
    analyzer_id     TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    prompt_hash     TEXT NOT NULL,

    -- Graph structure
    parent_id       TEXT,               -- NULL = root of this analysis branch
    anchor_entry_id TEXT,               -- conversation message.id this is anchored to (NULL = session-level)
    anchor_span     TEXT NOT NULL,       -- 'single_entry' | 'entry_pair' | 'segment' | 'full_session'

    -- Content
    node_type       TEXT NOT NULL,       -- 'deterministic' | 'llm_analysis' | 'summary' | 'metric'
    content         TEXT NOT NULL,       -- JSON: the analysis result
    properties      TEXT NOT NULL DEFAULT '{}', -- JSON: { propName: propValue, ... } for multi-property nodes

    -- Provenance & idempotency
    input_hash      TEXT NOT NULL,       -- SHA256(analyzer_id|version|prompt_hash|anchor_entry_id|input_content_hash)
    source_ids      TEXT NOT NULL DEFAULT '[]', -- JSON array of analysis_node.id's consumed by this node
    session_path    TEXT NOT NULL,       -- path to session JSONL (denormalized for fast lookups)

    -- Metadata
    created_at      TEXT NOT NULL,
    cost_usd        REAL DEFAULT 0,
    tokens_used     INTEGER DEFAULT 0,
    model_used      TEXT,
    status          TEXT DEFAULT 'ok',   -- 'ok' | 'error' | 'superseded'
    error_message   TEXT,

    FOREIGN KEY (analyzer_id, analyzer_version) REFERENCES analyzers(id, version)
);

-- ── Analyzer Progress ──
-- Tracks where each analyzer left off in each session. Enables incremental processing.

CREATE TABLE analysis_progress (
    analyzer_id         TEXT NOT NULL,
    analyzer_version    TEXT NOT NULL,
    session_path        TEXT NOT NULL,
    last_entry_id       TEXT,              -- last conversation entry.id processed
    last_analysis_node  TEXT,              -- last analysis_node.id created
    total_analyzed      INTEGER DEFAULT 0,
    last_run_at         TEXT,
    status              TEXT DEFAULT 'ok', -- 'ok' | 'in_progress' | 'error' | 'needs_rerun'
    error_message       TEXT,
    PRIMARY KEY (analyzer_id, analyzer_version, session_path),
    FOREIGN KEY (analyzer_id, analyzer_version) REFERENCES analyzers(id, version)
);

-- ── Prompt Registry ──
-- Immutable store of prompt templates. prompt_hash = SHA256(content).
-- Enables meta-analysis: "show me all nodes produced by prompt version X."

CREATE TABLE prompt_registry (
    hash        TEXT PRIMARY KEY,       -- SHA256 of the prompt template text
    content     TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL
);

-- ── Indexes ──
CREATE INDEX idx_analysis_anchor    ON analysis_nodes(anchor_entry_id);
CREATE INDEX idx_analysis_parent    ON analysis_nodes(parent_id);
CREATE INDEX idx_analysis_analyzer  ON analysis_nodes(analyzer_id, analyzer_version);
CREATE INDEX idx_analysis_session   ON analysis_nodes(session_path);
CREATE INDEX idx_analysis_input     ON analysis_nodes(input_hash);
CREATE INDEX idx_analysis_type      ON analysis_nodes(node_type);
CREATE INDEX idx_analysis_source    ON analysis_nodes(source_ids);
```

### Relationship to Existing Tables

```
sessions
  ├── messages (existing: conversation entries)
  │     └── analysis_nodes.anchor_entry_id → messages.id
  ├── analysis_nodes (grafted onto the tree)
  │     └── analysis_nodes.parent_id → analysis_nodes.id (self-referential)
  ├── proposals (existing: improvement proposals)
  │     └── proposals can reference analysis_nodes that generated them
  └── analysis_progress (per-analyzer cursor per session)

analyzers
  └── analysis_nodes.analyzer_id → analyzers.id

prompt_registry
  └── analysis_nodes.prompt_hash → prompt_registry.hash
```

### Input Hash Formula

```
input_hash = SHA256(
  analyzer_id | version | prompt_hash | anchor_entry_id | input_content_hash
)
```

Where `input_content_hash` is:
- For single-message anchors: `SHA256(content_text || content_thinking)`
- For message-pair anchors: `SHA256(user_text || assistant_text)`
- For session-level anchors: `SHA256(concatenated entry hashes in order)`

**Why this includes analyzer version + prompt hash**: If either changes, `input_hash` changes, so the framework detects that re-analysis is needed and the old node gets marked `superseded`.

---

## 2. Analyzer Interface

An analyzer is registered with the framework and implements:

```typescript
interface Analyzer {
  /** Unique identifier (stable across versions) */
  id: string;

  /** Current version (git commit hash of analyzer source) */
  version: string;

  /** Human-readable label */
  label: string;

  /** Analyzer ids this analyzer depends on (can read their nodes) */
  dependencies: string[];

  /** The prompt template used by this analyzer (stored in prompt_registry) */
  promptTemplate: string;

  /** What span does this analyzer target? */
  anchorSpan: "single_entry" | "entry_pair" | "segment" | "full_session";

  /**
   * Given a set of conversation entries that need analysis,
   * produce analysis nodes. The framework handles idempotency:
   * entries whose input_hash already exists for this analyzer
   * version are skipped.
   *
   * Context provides:
   *   - Conversation entries (filtered to this analyzer's scope)
   *   - This analyzer's existing nodes (for incremental awareness)
   *   - Dependency analyzers' nodes (if dependencies declared)
   *   - Database handle (read-only for analysis, write via returned nodes)
   */
  analyze(ctx: AnalyzerContext): Promise<AnalysisNodeInput[]>;
}

interface AnalyzerContext {
  db: Database;
  sessionPath: string;

  /** Conversation entries to analyze (pre-filtered by anchor type) */
  entries: ConversationEntry[];

  /** This analyzer's previous nodes for this session */
  ownNodes: AnalysisNode[];

  /** Nodes from dependency analyzers, keyed by analyzer id */
  dependencyNodes: Record<string, AnalysisNode[]>;

  /** Progress cursor for this analyzer on this session */
  progress: AnalysisProgress | null;
}

interface ConversationEntry {
  id: string;
  parentId: string | null;
  role: string;
  contentText: string | null;
  contentThinking: string | null;
  toolCalls: string | null;   // JSON
  toolResults: string | null;  // JSON
  timestamp: string | null;
}

interface AnalysisNodeInput {
  /** UUID generated by the analyzer (deterministic or random) */
  id: string;

  /** Parent in the analysis graph; NULL = root for this analysis branch */
  parentId: string | null;

  /** The conversation entry.id this is anchored to (NULL for session-level) */
  anchorEntryId: string | null;

  nodeType: "deterministic" | "llm_analysis" | "summary" | "metric";

  /** JSON string of the analysis result */
  content: string;

  /** Key-value properties for multi-property nodes */
  properties: Record<string, unknown>;

  /** Which analysis_node.id's this node consumed */
  sourceIds: string[];

  /** SHA256 for idempotency — computed by the framework, but the analyzer
   *  provides input_content_hash so the framework can compute input_hash */
  inputContentHash: string;

  /** Cost metadata (set by framework for LLM-based analyzers) */
  costUsd?: number;
  tokensUsed?: number;
  modelUsed?: string;
}
```

### Registration

Analyzers are registered at framework initialization:

```typescript
const framework = new AnalyzerFramework(db);
framework.register({
  id: "per-message-pair",
  version: "<git-sha>",
  label: "Per-Message-Pair Sentiment & Friction",
  dependencies: [],
  promptTemplate: PER_MESSAGE_PAIR_PROMPT,
  anchorSpan: "entry_pair",
  analyze: perMessagePairAnalyzer,
});

framework.register({
  id: "session-compact",
  version: "<git-sha>",
  label: "Session-Level Compaction Analysis",
  dependencies: ["per-message-pair"], // Can read per-message-pair nodes
  promptTemplate: SESSION_COMPACT_PROMPT,
  anchorSpan: "full_session",
  analyze: sessionCompactAnalyzer,
});
```

---

## 3. Framework Lifecycle

### run(sessionPath, analyzerId)

The core loop for running one analyzer on one session:

```
1. Resolve analyzer from registry
2. Check analysis_progress for this (analyzer_id, version, session_path)
3. If status == 'ok' and session hasn't changed:
     → no-op, return
4. If status == 'in_progress':
     → crash recovery: find the last successfully created node, resume from there
5. Determine which conversation entries need analysis:
     - From cursor: last_entry_id processed
     - For session-level: always run if session has new messages
6. Compute input_hashes for candidate entries
7. Filter out entries where input_hash already exists in analysis_nodes
   (for this analyzer_id + version + prompt_hash)
8. If no entries to process:
     → update progress to 'ok', return
9. Construct AnalyzerContext:
     - entries: the conversation entries that need analysis
     - ownNodes: this analyzer's nodes for this session
     - dependencyNodes: nodes from declared dependencies
     - progress: current cursor
10. Set progress.status = 'in_progress'
11. Call analyzer.analyze(ctx)
12. For each returned AnalysisNodeInput:
      - Compute final input_hash
      - INSERT INTO analysis_nodes
      - Update progress.last_entry_id, last_analysis_node
13. Set progress.status = 'ok', update last_run_at
```

### runAll(sessionPath?)

Runs all registered analyzers on all sessions (or one specific session):

```
1. For each session (or one specified session):
     For each registered analyzer:
       await run(sessionPath, analyzerId)
```

### Idempotency

The framework guarantees:
- Same `(analyzer_id, version, prompt_hash, anchor_entry_id, input_content_hash)` → same `input_hash` → detected as already existing → skipped
- If the analyzer version or prompt changes → `input_hash` differs → old nodes marked `superseded`, new nodes created
- If the conversation changes (new messages appended) → new messages get new `input_hash` values → only new messages are analyzed

### Crash Recovery

The `analysis_progress.status` field provides crash recovery:
- `in_progress`: last run didn't complete. Framework finds the last `analysis_node` for this analyzer/session, resumes from `last_entry_id`.
- Since analysis is idempotent, re-running on already-processed entries is safe (they'll be skipped via input_hash).
- The worst case is re-running some expensive LLM analysis, but no data corruption.

---

## 4. Graph Model

### Conversation Tree (Pi Native)

```
Session file: 2026-05-26T02-18-11-837Z_019e6213.jsonl

  entry:abc123 (user: "fix the auth bug")
    ├── entry:def456 (assistant: reads auth.ts)
    │     └── entry:ghi789 (toolResult: 3KB)
    ├── entry:jkl012 (assistant: edits auth.ts)
    │     └── entry:mno345 (toolResult: "matched 2 lines")
    ├── entry:comp001 (compactionSummary: "summarized previous work solving auth bug")
    └── entry:pqr678 (user: "no, wrong function — change verifyToken not authenticate")
          ├── entry:stu901 (assistant: reads auth.ts again)
          │     └── entry:vwx234 (toolResult: 2KB)
          └── entry:yza567 (assistant: edits auth.ts, successful)
```

### Analysis Graph Grafted Onto Conversation

```
entry:pqr678 ("no, wrong function")          [conversation node]
  │
  ├── an:AA01 (per-message-pair: sentiment)  [analysis node]
  │     type: "llm_analysis"
  │     anchor_entry_id: "pqr678"            ← grafts onto conversation
  │     parent_id: null                      ← root of analysis branch
  │     content: { user_emotion: "frustrated", correction: true, ... }
  │
  ├── an:AA02 (per-message-pair: tool metrics)
  │     type: "deterministic"
  │     anchor_entry_id: "pqr678"
  │     parent_id: null
  │     content: { edit_mismatches: 1, retry_count: 0, ... }
  │
  └── an:BB01 (proposal generator, depends on [per-message-pair])
        type: "llm_analysis"
        anchor_entry_id: "pqr678"
        parent_id: "an:AA01"                 ← builds on sentiment analysis
        source_ids: ["an:AA01", "an:AA02"]   ← consumed these nodes
        content: {
          proposal: "Add rule to AGENTS.md: verify function name before editing",
          target: "AGENTS.md § Editing guidelines",
          confidence: 0.9
        }
```

### Navigation

From any node, you can traverse:

```
-- Up the conversation tree
SELECT * FROM messages WHERE id = ?;
SELECT * FROM messages WHERE id = <parent_id>;

-- Up the analysis graph
WITH RECURSIVE analysis_path AS (
  SELECT * FROM analysis_nodes WHERE id = ?
  UNION ALL
  SELECT an.* FROM analysis_nodes an
  JOIN analysis_path ap ON an.id = ap.parent_id
) SELECT * FROM analysis_path;

-- From a conversation entry, find all analysis nodes
SELECT * FROM analysis_nodes WHERE anchor_entry_id = ?;

-- From an analysis node, find what it consumed
SELECT * FROM analysis_nodes WHERE id IN (SELECT value FROM json_each(?, '$.source_ids'));
```

### Properties Model

A single analysis node can carry multiple properties, enabling a "point of analysis" to aggregate findings:

```json
{
  "id": "an:CC01",
  "analyzer_id": "session-compact",
  "anchor_entry_id": null,
  "anchor_span": "full_session",
  "node_type": "summary",
  "properties": {
    "total_friction_events": 7,
    "friction_by_type": { "correction": 4, "tool_failure": 3 },
    "dominant_emotion": "frustrated",
    "session_duration_minutes": 47,
    "correction_rate": 0.35,
    "most_corrected_tool": "edit",
    "summary_text": "User spent 47 minutes debugging auth, with 4 explicit corrections..."
  },
  "source_ids": ["an:AA01", "an:AA02", "an:AA03", ...]
}
```

The `properties` column is a flat JSON object with arbitrary keys. Different analyzers produce different property schemas. This enables:
- Meta-analysis: analyzer C reads the `properties` of analyzer A's nodes
- Dashboard views: extract specific properties across all sessions
- Trend tracking: `correction_rate` over time

---

## 5. Isolation Model

### Default Visibility

An analyzer running with id `X` can see:
1. **Conversation entries** (from `messages` table) — always
2. **Its own analysis nodes** — always
3. **Nodes from declared dependencies** — only analyzers listed in `dependencies`

It CANNOT see:
- Nodes from other analyzers not in its dependency list
- Nodes from different versions of itself (only its current `version`)

### Dependency Chains

```
analyzers:
  A: id="per-message-pair",    deps=[]
  B: id="tool-metrics",        deps=[]
  C: id="proposal-generator",  deps=["per-message-pair", "tool-metrics"]
  D: id="proposal-evaluator",  deps=["proposal-generator"]
```

- Analyzer C sees: conversation + A's nodes + B's nodes + C's nodes
- Analyzer D sees: conversation + C's nodes + D's nodes
- Analyser D does NOT directly see A's or B's nodes (they're encapsulated in C's output)

### Upgrade Propagation

When analyzer A is upgraded (new version):
1. Framework inserts new row in `analyzers` table
2. All of A's existing nodes remain (with old version)
3. `analysis_progress` for A is reset → re-analysis needed
4. Analyzer C (depends on A) detects that A's nodes have new versions
5. C's `analysis_progress` is also marked `needs_rerun`
6. D (depends on C) similarly cascades

The propagation is detected by comparing `analysis_nodes.analyzer_version` of dependencies against what the framework expects.

### Tool-Level Filtering

When an analyzer runs as a Pi sub-agent, the tools it receives for navigating the graph automatically filter:

```typescript
// read_analysis_node tool (framework-provided)
function readAnalysisNode(id: string, ctx: SubAgentContext): AnalysisNode {
  const node = db.get("SELECT * FROM analysis_nodes WHERE id = ?", id);
  if (!ctx.allowedAnalyzerIds.has(node.analyzer_id)) {
    throw new Error(`Access denied: analyzer ${ctx.analyzerId} cannot read nodes from ${node.analyzer_id}`);
  }
  return node;
}
```

---

## 6. Two Initial Analyzers

### 6.1 Analyzer: `per-message-pair`

**What**: Analyzes each (user_message, immediate_assistant_response) pair independently.
**Scope**: `entry_pair`
**Dependencies**: none
**Parallelizable**: Yes — each pair is independent

#### Deterministic Tier (Tier 0 — no LLM)

Runs first and always. Produces lightweight `deterministic` nodes.

```
For each (user_msg, assistant_msg) pair:
  input_content = user_msg.content_text + assistant_msg.content_text
  input_content_hash = SHA256(input_content)
  input_hash = SHA256(analyzer_id | version | prompt_hash | user_msg.id | input_content_hash)

  // Check if already analyzed
  if analysis_nodes has matching input_hash → skip

  // Deterministic metrics
  properties = {
    user_msg_length: user_msg.content_text?.length ?? 0,
    assistant_msg_length: assistant_msg.content_text?.length ?? 0,
    has_thinking: assistant_msg.content_thinking != null,
    thinking_length: assistant_msg.content_thinking?.length ?? 0,
    is_correction: matchesCorrectionPattern(user_msg.content_text),
    correction_patterns: extractCorrectionPatterns(user_msg.content_text),
    is_repeated: hasRepeatedContent(user_msg.content_text, assistant_msg.content_text),
    tool_count: countToolCalls(assistant_msg),
    tool_names: extractToolCalls(assistant_msg).map(t => t.name),
    elapsed_seconds: computeElapsed(user_msg.timestamp, assistant_msg.timestamp),
  }

  node = {
    id: generateId("det-msgpair", user_msg.id),
    parentId: null,
    anchorEntryId: user_msg.id,
    nodeType: "deterministic",
    content: JSON.stringify({ pair_analysis: properties }),
    properties,
    sourceIds: [],
    inputContentHash: input_content_hash,
  }
```

**Correction detection patterns** (no LLM, fast regex):
```
"no,"  "not that"  "wrong"  "actually"  "I said"  "stop"  
"don't"  "use [X] not [Y]"  "fix it"  "try again"
```

#### LLM Tier (Tier 1 — cheap model)

Runs only on pairs where the deterministic tier flagged `is_correction: true` or `elapsed_seconds > 60` (user took a long pause — possible frustration).

```
prompt = PER_MESSAGE_PAIR_PROMPT
input = user_msg.content_text + assistant_msg.content_text
→ LLM (Haiku/Gemini Flash) →
  {
    sentiment: "negative" | "neutral" | "positive",
    frustration_level: 0-10,
    correction_type: "explicit" | "implicit" | "repetition" | null,
    friction_cause: "tool_failure" | "misunderstanding" | "missing_context" | "wrong_approach" | null,
    topic: string,
    task_completed: boolean
  }
```

**Prompt template** (stored in `prompt_registry`):
```
You analyze a single exchange between a user and an AI coding agent.

USER: {user_text}
AGENT: {assistant_text}

Classify this exchange:
- sentiment: negative, neutral, or positive
- frustration_level: 0 (none) to 10 (extreme)
- correction_type: explicit, implicit, repetition, or null
- friction_cause: tool_failure, misunderstanding, missing_context, wrong_approach, or null
- topic: one-line summary of what was being worked on
- task_completed: true if the user's request was satisfied

Return JSON only.
```

### 6.2 Analyzer: `session-compact`

**What**: Analyzes an entire session using LLM-based compaction (not truncation) to fit within context windows.
**Scope**: `full_session`
**Dependencies**: `["per-message-pair"]` (can read sentiment/friction nodes to guide compaction focus)
**Parallelizable**: Per-session

#### Strategy: Map-Reduce Compaction

For sessions where the structured extraction exceeds the model's context window:

```
MAP phase:
  1. Split entries into chunks that fit within context budget
     - Each chunk: N entries + their per-message-pair analysis nodes
     - Chunk boundary: never split a user-assistant pair
     - Chunk overlap: last entry of chunk N is first entry of chunk N+1

  2. For each chunk, call LLM:
     prompt = SESSION_CHUNK_PROMPT
     input = chunk entries (compacted transcript style)
     → structured chunk summary:
       {
         topics: string[],
         key_decisions: string[],
         corrections_in_chunk: [{what, why, outcome}],
         tools_used: {name: string, count: number, failures: number}[],
         errors_encountered: string[],
         files_touched: string[],
         carried_context: string  // for cross-chunk continuity
       }

REDUCE phase:
  3. Collect all chunk summaries
  4. If they still don't fit in context → second map-reduce pass

  5. Call LLM:
     prompt = SESSION_REDUCE_PROMPT
     input = all chunk summaries + per-message-pair aggregate stats
     → final session analysis:
       {
         session_summary: string,
         friction_chronology: [{timestamp, event, severity}],
         dominant_patterns: [{pattern, occurrences, suggestion}],
         improvement_proposals: [{target, severity, detail, evidence}],
         session_score: { overall: 0-10, efficiency: 0-10, friction: 0-10 }
       }
```

**For cheap LLMs (short context):**
- Map chunk size: ~4K tokens (fits in Haiku's 8K context with prompt overhead)
- Reduce: max ~8 chunk summaries → fits in Haiku's context
- A session with 200 messages → ~8 chunks → 9 LLM calls (~$0.09 total with Haiku)

**For large context models:**
- Skip map-reduce entirely, send all entries in one call
- Only use map-reduce when estimated tokens > model context window

**Compaction style** (instead of truncation):

The compaction prompt tells the LLM to produce a structured summary, not a prose summary. This preserves information in a format that downstream analyzers can consume:

```
## Session Summary (compaction style)

### Chronology
[timestamp] USER: "fix the auth bug"
[timestamp] AGENT: read auth.ts (2KB), edit auth.ts (matched 2 lines)
[timestamp] USER: "no, wrong function — change verifyToken not authenticate"
  → CORRECTION: user redirected from authenticate() to verifyToken()
[timestamp] AGENT: read auth.ts (2KB), edit auth.ts (successful)

### Corrections
1. @14:23 - redirected from authenticate() → verifyToken()
   Root cause: agent assumed function name without reading file

### Files Changed
- auth.ts: 2 edits (1 correction, 1 success)

### Tools Used
- read: 2 calls, 5KB total
- edit: 2 calls, 1 failure (wrong function), 1 success

### Patterns
- Pre-edit verification: agent edited before confirming function name → correction
  Suggestion: add "verify symbol exists before editing" to AGENTS.md
```

This format is:
- Compact (~200 words where prose would be 500+)
- Machine-parseable (chronology, corrections, files, tools, patterns are clearly delimited)
- Lossless for factual data (file names, counts, timestamps preserved)
- Readable by downstream LLM analyzers

---

## 7. Versioning and Meta-Analysis

### Prompt Versioning

Every analysis node records:
- `analyzer_version`: git commit of the analyzer code
- `prompt_hash`: SHA256 of the prompt template text

The `prompt_registry` table stores the full prompt text, versioned by hash:

```sql
INSERT INTO prompt_registry (hash, content, description, created_at)
VALUES (
  'abc123...',
  'You analyze a single exchange between a user...',
  'Per-message-pair sentiment classifier v1',
  '2026-05-29T00:00:00Z'
);
```

### Meta-Analysis Queries

```sql
-- Which prompt versions produced the most proposals?
SELECT prompt_hash, COUNT(*) as proposal_count
FROM analysis_nodes
WHERE node_type = 'llm_analysis'
GROUP BY prompt_hash
ORDER BY proposal_count DESC;

-- Which analyzer version is most expensive per session?
SELECT analyzer_version, AVG(cost_usd) as avg_cost
FROM analysis_nodes
WHERE cost_usd > 0
GROUP BY analyzer_version;

-- Did a prompt change reduce false positives?
SELECT
  old.prompt_hash as old_prompt,
  new.prompt_hash as new_prompt,
  AVG(CASE WHEN old.id IS NOT NULL THEN 1 ELSE 0 END) as old_rejection_rate,
  AVG(CASE WHEN new.id IS NOT NULL THEN 1 ELSE 0 END) as new_rejection_rate
FROM analysis_nodes old
JOIN analysis_nodes new ON old.anchor_entry_id = new.anchor_entry_id
WHERE old.analyzer_id = 'per-message-pair'
  AND new.analyzer_id = 'per-message-pair'
  AND old.analyzer_version != new.analyzer_version;
```

### Meta-Analyzer Example

An analyzer that analyzes the analysis itself:

```typescript
framework.register({
  id: "meta-accuracy",
  version: "<sha>",
  label: "Analysis Accuracy Evaluator",
  dependencies: ["per-message-pair", "proposal-generator"],
  promptTemplate: META_ACCURACY_PROMPT,
  anchorSpan: "full_session",
  analyze: async (ctx) => {
    // Read per-message-pair sentiment nodes
    const sentimentNodes = ctx.dependencyNodes["per-message-pair"];

    // Read proposal nodes
    const proposalNodes = ctx.dependencyNodes["proposal-generator"];

    // Sample the conversation to ground-truth the sentiment
    const samples = pickRandomSamples(sentimentNodes, 20);
    for (const node of samples) {
      const msg = getMessage(ctx.db, node.anchor_entry_id);
      // Compare LLM sentiment vs. actual user behavior
    }

    // Produce accuracy metrics
    return [{
      id: uuid(),
      nodeType: "metric",
      content: JSON.stringify({
        sentiment_accuracy: 0.87,
        false_positive_rate: 0.05,
        false_negative_rate: 0.12,
      }),
      ...
    }];
  }
});
```

---

## 8. Implementation Plan

### Phase 1: Schema + Framework Core

**Files to create/modify:**

```
src/db/schema.ts          — add analyzers, analysis_nodes, analysis_progress, prompt_registry tables
src/db/queries.ts         — add queries for analysis_nodes CRUD, progress tracking, input_hash checking
src/types.ts              — add Analyzer, AnalysisNode, AnalysisProgress types
src/analyze/framework.ts  — NEW: AnalyzerFramework class (register, run, runAll)
src/analyze/input-hash.ts — NEW: computeInputHash, computeInputContentHash
```

**Key decisions to lock:**

1. `input_hash` formula exactly as specified
2. `anchor_span` values: `single_entry`, `entry_pair`, `segment`, `full_session`
3. `node_type` values: `deterministic`, `llm_analysis`, `summary`, `metric`
4. Progress tracking uses `(analyzer_id, analyzer_version, session_path)` as primary key
5. Crash recovery: mark progress as `in_progress` before analysis, `ok` after

### Phase 2: Per-Message-Pair Analyzer

**Files to create:**

```
src/analyze/tier0.ts           — correction pattern regex, deterministic metrics
src/analyze/analyzers/         — NEW directory
  per-message-pair.ts          — Analyzer implementation
  per-message-pair-prompt.ts   — LLM prompt template
```

**Deterministic tier (Tier 0):**
- `matchesCorrectionPattern()`: regex-based detection
- `extractCorrectionPatterns()`: categorize the correction type
- `countToolCalls()`: parse tool_calls JSON, count by name
- Produces `deterministic` nodes with `properties`

**LLM tier (Tier 1):**
- Only runs on entries flagged by Tier 0
- Uses `@earendil-works/pi-ai` `completeSimple()` (stubbed in tests)
- Produces `llm_analysis` nodes with sentiment/friction classification
- Records `cost_usd`, `tokens_used`, `model_used` on each node

### Phase 3: Session-Compact Analyzer

**Files to create:**

```
src/analyze/analyzers/
  session-compact.ts           — Analyzer implementation
  session-compact-prompt.ts    — LLM prompt template
  chunking.ts                  — split into context-sized chunks
  map-reduce.ts                — map-reduce execution (reusable by future analyzers)
```

### Phase 4: Commands + Tool

```
src/commands/
  prospect-run.ts      — /prospect-run [analyzer] [session]
  prospect-graph.ts    — /prospect-graph [anchor]  (navigate the analysis graph)
  prospect-meta.ts     — /prospect-meta [analyzer] (meta-analysis stats)

Update src/index.ts to register new commands
```

### Phase 5: Tests

```
tests/
  unit/
    input-hash.test.ts
    tier0.test.ts
    chunking.test.ts
  component/
    framework.test.ts
    per-message-pair.test.ts
    session-compact.test.ts
  integration/
    test-analyzer-pipeline.ts
```

---

## 9. Edge Cases

### Compaction Events in Sessions

Pi sessions contain `compactionSummary` entries. The framework handles these:

- **Sync**: `compactionSummary` entries are stored as messages with `role = "compactionSummary"`
- **Per-message-pair**: does NOT create pairs for compactionSummary entries (they have no assistant response)
- **Session-compact**: includes compaction summary text in the session overview. If the session has been compacted, the compaction summary IS the "compressed" view of pre-compaction content.

### Forked Sessions

Pi sessions can be forked (parentSession in header). The framework:
- Sync already resolves forks and stores `parent_session` in the `sessions` table
- Analyzers that want cross-fork context can follow `parent_session` → read messages from the parent session
- This is out of scope for initial analyzers but the graph structure supports it (analysis nodes can have `anchor_entry_id` pointing to messages in any session)

### Very Long Sessions (545MB / 1400+ sessions)

From real usage data:
- **Sync**: Already handles incremental parsing. A 545MB workspace won't block if nothing changed.
- **Per-message-pair (Tier 0)**: Deterministic, no LLM, runs in milliseconds per message. Can process thousands of pairs.
- **Session-compact**: Uses map-reduce with budget-aware chunking. A 200-message session might use 9 LLM calls with Haiku.
- **Progress tracking**: Even if analysis is interrupted, progress is saved per-message, so resuming is near-instant.

### Analyzer Upgrade (New Version)

```
Old: per-message-pair v1 (commit abc123)
New: per-message-pair v2 (commit def456)

Framework actions:
1. Register v2 in analyzers table
2. Detect that analysis_progress has no entry for v2
3. Run v2 on all sessions
4. v2's input_hash includes analyzer_version → all entries need re-analysis
5. Old v1 nodes remain in analysis_nodes (status = 'ok')
6. New v2 nodes are created
7. If desired, v1 nodes can be marked 'superseded' via a migration script
```

### Deleted Session Files

If a session JSONL is deleted but analysis nodes exist:
- Analysis nodes remain (they're SQLite rows)
- Queries that join to `messages` or `sessions` will return no matches
- The analysis graph is still navigable (it's self-contained via `parent_id`)
- `/prospect-graph` can show analysis for orphaned session references

---

## 10. Design Decisions Log

| Decision | Rationale |
|----------|-----------|
| Analysis nodes live in SQLite, not JSONL | Append-on-write is SQLite's strength; JSONL would require file-level locking for concurrent analyzers |
| `input_hash` includes analyzer_version + prompt_hash | Makes upgrades automatic — new version triggers re-analysis without manual invalidation |
| `properties` is a flat JSON column, not separate columns | Different analyzers have different property schemas; a JSON column avoids schema migrations for every new property |
| `source_ids` is a JSON array, not a join table | For the expected cardinality (1-20 sources per node), JSON is simpler and graph navigation uses recursive CTEs on `parent_id` |
| Progress tracking per (analyzer, version, session) | Supports multiple analyzer versions coexisting, each with independent progress |
| Deterministic tier always runs before LLM tier | Provides cheap signal for LLM tier filtering; also ensures graph has baseline metrics even if LLM is unavailable |
| Compaction-style summaries, not prose | Machine-parseable, more compact, lossless for factual data |
| Dependency chains are explicit in `analyzers.deps` | Enables the framework to compute visibility without runtime configuration |
