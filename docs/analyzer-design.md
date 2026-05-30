# Analyzer Framework Design

## Core Idea

The conversation is a tree. The analysis is a tree grafted onto it. Each analysis node is append-only, versioned, and traced back to the analyzer and prompt that produced it.

```
Session JSONL (conversation tree):
  msg_001 (user)
  msg_002 (assistant)
  msg_003 (user)          ← analysis node grafts here
  msg_004 (assistant)
  ...
  msg_099 (compactionSummary)

Analysis tree (grafted onto conversation):
  msg_003 → analysis_node_a1 (turn-pair analyzer, v2)
           → analysis_node_a2 (turn-pair analyzer, v2)
           ↓
  msg_004 → analysis_node_a3 (turn-pair analyzer, v2)
           ...
  session_001 → analysis_node_s1 (session analyzer, v1)
              → analysis_node_s2 (meta analyzer, v1, depends_on: session analyzer)
```

## Schema

### `analyzers` table

One row per analyzer version. Inserted when an analyzer runs for the first time or when its prompt changes.

```sql
CREATE TABLE analyzers (
  id TEXT PRIMARY KEY,            -- '{name}:{version}' e.g. 'turn-pair:v2'
  name TEXT NOT NULL,             -- 'turn-pair', 'session-compact', 'meta-friction'
  version TEXT NOT NULL,          -- 'v2', auto-incremented or explicit
  prompt_hash TEXT NOT NULL,     -- sha256 of the prompt template
  prompt_text TEXT NOT NULL,     -- the actual prompt used
  model_spec TEXT,               -- e.g. 'anthropic/claude-sonnet-4-5' or null for deterministic
  is_deterministic INTEGER NOT NULL DEFAULT 0, -- 1 = no LLM, pure code
  depends_on TEXT,               -- JSON array of analyzer ids, e.g. '["turn-pair:v2"]'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, version)
);
```

### `analysis_nodes` table

Every artifact produced by every analyzer run. Append-only: rows are never updated after insert, only new rows are added.

```sql
CREATE TABLE analysis_nodes (
  id TEXT PRIMARY KEY,           -- UUID
  analyzer_id TEXT NOT NULL,     -- FK to analyzers.id
  session_id TEXT NOT NULL,      -- FK to sessions.id
  source_type TEXT NOT NULL,     -- 'message' | 'session' | 'compaction_boundary' | 'analysis_node'
  source_id TEXT NOT NULL,       -- message.id, session.id, or analysis_node.id
  parent_analysis_id TEXT,       -- for tree structure within analysis nodes
  properties TEXT NOT NULL,      -- JSON blob: analyzer-specific structured output
  prompt_version TEXT NOT NULL,  -- denormalized from analyzers.prompt_hash for fast filtering
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (analyzer_id) REFERENCES analyzers(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_analysis_nodes_session ON analysis_nodes(session_id);
CREATE INDEX idx_analysis_nodes_analyzer ON analysis_nodes(analyzer_id);
CREATE INDEX idx_analysis_nodes_source ON analysis_nodes(source_type, source_id);
CREATE INDEX idx_analysis_nodes_prompt ON analysis_nodes(prompt_version);
```

### `analyzers` is the version/prompt store

When an analyzer's prompt changes, a new row is inserted with an incremented version. Old analysis nodes still reference the old `analyzer_id`. This is how we track what prompt was used for what analysis.

New analyzer versions are created automatically: the framework hashes the prompt, checks if `(name, prompt_hash)` already exists, and if not, creates a new version. The version string is derived from the hash prefix (e.g. `turn-pair:a3f1`).

### Idempotency check

An analyzer run is a no-op when:

```
FOR EACH (source_type, source_id) that this analyzer would process:
  EXISTS analysis_nodes WHERE
    analyzer_id = '{current_analyzer_id}'
    AND source_type = '{source_type}'
    AND source_id = '{source_id}'
    AND prompt_version = '{current_prompt_hash}'
```

If all sources already have nodes with the current analyzer version and prompt, the run is skipped entirely. If some are missing (e.g. new messages since last run, or a crash mid-run), only the missing nodes are created.

### Properties: flexible JSON per analyzer

Each analyzer defines what goes in `properties`. This is the extensibility point. Examples:

**turn-pair analyzer** (`source_type = 'message'`):
```json
{
  "user_sentiment": "neutral|frustrated|satisfied|corrective",
  "correction_detected": true,
  "correction_type": "redirect|explicit_correction|repetition|abandonment",
  "correction_text": "No, use pnpm not npm",
  "tool_failures": ["bash: exit code 1"],
  "tool_waste_bytes": 45200,
  "friction_score": 0.7,
  "friction_signals": ["user repeated instruction", "agent asked for clarification after being told"]
}
```

**session-compact analyzer** (`source_type = 'session'`):
```json
{
  "overall_sentiment": "mixed",
  "friction_segments": [
    {"start_msg": "msg_003", "end_msg": "msg_007", "summary": "User repeatedly corrected tool usage", "score": 0.8}
  ],
  "key_corrections": [
    {"target": "AGENTS.md § Tool usage", "summary": "Agent used npm instead of pnpm 3 times", "detail": "...", "evidence": "..."}
  ],
  "waste_summary": {"total_waste_bytes": 120000, "wasted_reads": 3},
  "proposals": [
    {"target": "AGENTS.md", "severity": "correction", "summary": "Add 'always use pnpm' rule", "detail": "...", "evidence": "..."}
  ]
}
```

**meta-friction analyzer** (`source_type = 'analysis_node'`, `depends_on = ["turn-pair"]`):
```json
{
  "cross_session_patterns": [
    {"pattern": "pnpm confusion", "sessions": 3, "corrections": 7, "first_seen": "2026-05-20", "last_seen": "2026-05-28"}
  ],
  "recidivism": [
    {"target": "AGENTS.md § pnpm", "correction_count": 5, "proposed_count": 2, "still_occurring": true}
  ]
}
```

## Two Initial Analyzers

### Analyzer 1: `turn-pair` (per user→assistant→toolResult sequence)

**Source**: Individual message groups (source_type = 'message', source_id = message.id of the user message)

**Scope**: A single user message + the assistant response(s) + tool results that follow, up to the next user message. This is the minimal analysis unit.

**What it does (deterministic Tier 0)**:
1. Pattern-match user corrections: "no", "wrong", "not that", "actually", "I said use X", regex-based
2. Detect tool failures: bash exit code ≠ 0, edit "no match", read errors
3. Compute tool waste: tool result bytes where the content was never referenced in subsequent assistant text
4. Score friction: 0.0-1.0 based on correction signals, failures, and waste

**What it does (LLM Tier 1, optional)**:
5. Classify user sentiment: neutral/frustrated/satisfied/corrective
6. Identify the correction type and extract the corrective instruction
7. Generate a brief friction narrative

**Idempotency**: When run incrementally, only processes message IDs that don't already have a turn-pair analysis node for the current analyzer version and prompt hash. New messages since the last cursor position get analyzed; existing ones are skipped.

**Parallelism**: Each turn pair is independent. The analyzer processes them sequentially in-code but the data model allows parallel processing (each message gets its own analysis node).

### Analyzer 2: `session-compact` (per session, using compaction-style summary)

**Source**: session (source_type = 'session', source_id = session.id)

**Scope**: An entire session.

**What it does**:

For sessions that fit in the model's context window:
- Send the full structured extraction (not the raw JSONL — the turn-pair analysis nodes + message metadata)
- Ask the LLM to produce friction segments, proposals, and sentiment

For sessions that exceed the model's context window:
- Use the session's compaction summaries (which are already in the JSONL as `compactionSummary` entries) as the compressed "pre-compaction" context
- Include the full turn-pair analysis nodes from the post-compaction portion
- This gives the LLM: compressed old context + detailed recent context + deterministic analysis signals

**What it produces**:
- A single analysis node per session
- Contains friction segments, proposals, correction summaries, waste totals, and overall sentiment
- Proposals reference specific message IDs as evidence

**Idempotency**: Checks if an analysis node with the current analyzer version and prompt hash already exists for this session. If so, skips. If the prompt changes, creates a new analysis node (the old one stays for historical comparison — meta-analysis can see both and note that the new prompt found different things).

**Depends on**: `turn-pair` — the session analyzer reads turn-pair analysis nodes as input, so it can see per-turn friction scores and correction signals without re-deriving them.

## Analyzer Framework: Execution Model

```typescript
interface Analyzer {
  /** Unique name for this analyzer */
  name: string;

  /** Which source types this analyzer processes */
  sourceType: "message" | "session" | "compaction_boundary" | "analysis_node";

  /** Other analyzers whose output this analyzer reads */
  dependsOn: string[];

  /** Whether this analyzer uses LLM calls or is purely deterministic */
  isDeterministic: boolean;

  /** The prompt template (for LLM analyzers). Contains {placeholders}. */
  promptTemplate?: string;

  /** Model specification (for LLM analyzers) */
  modelSpec?: string;

  /**
   * Run this analyzer on a batch of sources.
   * Returns analysis nodes to insert.
   * The framework handles idempotency (skipping already-processed sources).
   */
  analyze(sources: AnalyzeSource[], dependencies: Map<string, AnalysisNode[]>): Promise<NewAnalysisNode[]>;
}

interface AnalyzeSource {
  sessionId: string;
  sourceType: string;
  sourceId: string;
  // For 'message': the message rows
  messages?: MessageRow[];
  // For 'session': session metadata
  session?: SessionRow;
}

interface NewAnalysisNode {
  analyzerId: string;
  sessionId: string;
  sourceType: string;
  sourceId: string;
  parentAnalysisId: string | null;
  properties: Record<string, unknown>;
}
```

### Framework orchestration

```typescript
async function runAnalyzer(analyzer: Analyzer, db: Database): Promise<RunResult> {
  // 1. Get or create the analyzer record (versioning by prompt hash)
  const analyzerRecord = getOrCreateAnalyzer(db, analyzer);

  // 2. Find sources that need analysis
  const sources = findUnanalyzedSources(db, analyzerRecord, analyzer.sourceType);

  if (sources.length === 0) {
    return { status: "noop", nodesCreated: 0 };
  }

  // 3. Load dependency analysis nodes if declared
  const dependencies = new Map<string, AnalysisNode[]>();
  for (const dep of analyzer.dependsOn) {
    const depAnalyzer = getLatestAnalyzer(db, dep);
    if (!depAnalyzer) {
      return { status: "blocked", reason: `Dependency ${dep} not yet run` };
    }
    // Only load nodes for the relevant sessions
    const depNodes = loadDependencyNodes(db, depAnalyzer.id, sources);
    dependencies.set(dep, depNodes);
  }

  // 4. Run the analyzer
  const newNodes = await analyzer.analyze(sources, dependencies);

  // 5. Insert nodes (append-only)
  for (const node of newNodes) {
    insertAnalysisNode(db, { ...node, analyzerId: analyzerRecord.id });
  }

  return { status: "ok", nodesCreated: newNodes.length };
}
```

### Dependency filtering

When `session-compact` runs and declares `dependsOn: ["turn-pair"]`:
- The framework loads only turn-pair analysis nodes that the session-compact analyzer is allowed to see
- By default, an analyzer can only see nodes from its declared dependencies
- This prevents analyzers from accidentally depending on un-versioned data

## DB Migration Changes

Add these tables to the existing `schema.ts` migration:

```sql
CREATE TABLE IF NOT EXISTS analyzers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  model_spec TEXT,
  is_deterministic INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,  -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS analysis_nodes (
  id TEXT PRIMARY KEY,
  analyzer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  parent_analysis_id TEXT,
  properties TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (analyzer_id) REFERENCES analyzers(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_analysis_nodes_session ON analysis_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_analysis_nodes_analyzer ON analysis_nodes(analyzer_id);
CREATE INDEX IF NOT EXISTS idx_analysis_nodes_source ON analysis_nodes(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_analysis_nodes_prompt ON analysis_nodes(prompt_version);
-- Idempotency check: does this analyzer+prompt already have a node for this source?
CREATE INDEX IF NOT EXISTS idx_analysis_idempotency ON analysis_nodes(analyzer_id, source_type, source_id, prompt_version);
```

## File Structure

```
src/
  analyze/
    framework.ts         # Analyzer interface, runAnalyzer(), idempotency, dependency loading
    registry.ts          # Analyzer registry, getOrCreateAnalyzer
    turn-pair.ts         # Turn-pair analyzer implementation
    session-compact.ts   # Session-compact analyzer implementation
    prompts.ts           # Prompt templates (versioned)
    parser.ts            # (existing) LLM response parser
  db/
    schema.ts            # (existing) + new tables
    queries.ts           # (existing) + new query functions
    analysis-queries.ts  # Queries specific to analysis_nodes and analyzers
  commands/
    analyze.ts           # (existing) now uses framework
    proposals.ts         # (existing) now reads from analysis_nodes
  types.ts               # (existing) + new types
```

## Turn-Pair Analyzer: Detailed Design

### Phase 1: Deterministic (no LLM, runs during sync)

```typescript
const turnPairDeterministic: Analyzer = {
  name: "turn-pair",
  sourceType: "message",
  dependsOn: [],
  isDeterministic: true,

  async analyze(sources, _deps) {
    const results: NewAnalysisNode[] = [];

    for (const source of sources) {
      const userMsg = source.messages!.find(m => m.id === source.sourceId);
      if (!userMsg || userMsg.role !== "user") continue;

      // Collect the turn pair: this user msg + following assistant + tool results
      const turn = collectTurnPair(source.messages!, userMsg);

      const properties = {
        // Pattern-based correction detection
        correction_detected: detectCorrection(turn.userText),
        correction_type: classifyCorrection(turn.userText),
        correction_text: extractCorrectionText(turn.userText),
        sentiment_hint: detectSentimentHint(turn.userText),

        // Tool failure detection
        tool_failures: detectToolFailures(turn.toolResults),
        tool_failure_details: extractToolFailureDetails(turn.toolResults),

        // Tool waste estimation
        tool_waste_bytes: estimateToolWaste(turn),

        // Friction scoring (deterministic)
        friction_score: computeFrictionScore(turn),

        // Thinking presence
        has_thinking: turn.thinking !== null,
        thinking_length: turn.thinking?.length ?? 0,

        // Model info from assistant message
        model: turn.model,
        stop_reason: turn.stopReason,

        // Token usage (from assistant message)
        usage: turn.usage,
      };

      results.push({
        analyzerId: "", // filled by framework
        sessionId: source.sessionId,
        sourceType: "message",
        sourceId: source.sourceId,
        parentAnalysisId: null,
        properties,
      });
    }

    return results;
  },
};
```

### Phase 1.5: LLM enrichment (optional, on-demand)

When a cheap LLM is available, run a second pass on turn pairs with `correction_detected: true` or `friction_score > 0.5` to enrich the deterministic analysis with:
- Full sentiment classification
- Correction paraphrase (what the user actually wanted)
- Category tagging (skill-related? prompt-related? tool-related?)

This produces a second analysis node per message, from a different analyzer version (`turn-pair-enriched:v1`), so the deterministic analysis is preserved and the enrichment is additive.

### Correction detection patterns

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

## Session-Compact Analyzer: Detailed Design

### Context window management

```typescript
const sessionCompactAnalyzer: Analyzer = {
  name: "session-compact",
  sourceType: "session",
  dependsOn: ["turn-pair"],

  async analyze(sources, dependencies) {
    // Load turn-pair analysis nodes (our dependency)
    const turnPairNodes = dependencies.get("turn-pair") ?? [];
    const results: NewAnalysisNode[] = [];

    for (const source of sources) {
      const session = source.session!;
      const messages = getSessionMessages(db, session.id);

      // Build context payload
      const context = buildContextPayload(session, messages, turnPairNodes);

      // If context exceeds budget, use compaction strategy:
      // - Pre-compaction: use compactionSummary text
      // - Post-compaction: use full messages + turn-pair analysis
      // - Turn-pair analysis: always included (it's already compressed)

      const payload = fitToContextBudget(context, maxTokens);

      // Call LLM with the payload
      const analysis = await callLLM(payload);

      results.push({
        analyzerId: "",
        sessionId: session.id,
        sourceType: "session",
        sourceId: session.id,
        parentAnalysisId: null,
        properties: analysis,
      });
    }

    return results;
  },
};
```

### Context budget strategy

```
Available context = model_context_window - system_prompt (~1K) - analysis_tool_schema (~1K)

For each session:
  1. Gather all compactionSummary entries from messages table
  2. Gather turn-pair analysis nodes for this session
  3. Gather post-compaction messages (after last compactionSummary)
  4. Estimate token counts for each component

  If (summaries + turnPairNodes + postCompactionMessages) < budget:
    Send all three → LLM
  Else:
    Send summaries (compressed) + turnPairNodes (compressed scores only) + 
    last N post-compaction messages → LLM
    (where N is chosen to fit the budget)
```

### Compaction awareness

The Pi session format has `compactionSummary` entries with this structure:
```json
{"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"compactionSummary","summary":"...","tokensBefore":12345}}
```

The sync/parser already handles these. The session-compact analyzer:
1. Finds all `compactionSummary` messages in the session
2. Includes their `summary` text as compressed history
3. Only sends post-compaction messages in full detail
4. Always includes turn-pair analysis nodes (they're small and contain the signals)

## Proposals: Derived from Analysis Nodes

Proposals are no longer generated directly by LLM calls. Instead:

1. `turn-pair` produces per-message friction/correction analysis
2. `session-compact` produces per-session proposals referencing specific messages
3. The existing `proposals` table is populated from `analysis_nodes` where the properties contain proposals

This means proposals are **second-order artifacts** — they're extracted from analysis nodes, not generated independently. The analysis nodes are the ground truth; proposals are a view.

New query:
```sql
-- Get all proposals from session-compact analysis nodes
SELECT an.properties -> '$.proposals' as proposals
FROM analysis_nodes an
JOIN analyzers a ON an.analyzer_id = a.id
WHERE a.name = 'session-compact'
  AND an.session_id = ?;
```

## Incremental Run Schedule

```
On every sync (can run every minute):
  1. Sync new messages into DB (existing)
  2. Run turn-pair deterministic on new messages (fast, no LLM)
  3. Mark new messages as having turn-pair analysis

On demand (or scheduled daily):
  4. Run turn-pair-enriched on high-friction messages (cheap LLM)
  5. Run session-compact on sessions that have new analysis since last run
  6. Extract proposals from session-compact nodes into proposals table
```

### Crash recovery

Since analysis nodes are append-only and idempotency is checked by `(analyzer_id, source_type, source_id, prompt_version)`:
- If the analyzer crashes mid-run, the next run will skip already-created nodes
- If the prompt changes, a new analyzer version is created and all sources are re-analyzed (old nodes preserved for comparison)
- If the model changes, the existing prompt_version means nodes are still valid — model choice doesn't invalidate analysis, only prompt changes do