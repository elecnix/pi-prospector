# Analyzer Framework Implementation Summary

## Implemented (Working)

### 1. Database Schema (`src/db/schema.ts`)
- Added `analyzer_defs`, `analyzer_versions`, `prompt_registry`, `analyzer_configs`, `analysis_runs`, `analysis_nodes`, `analysis_edges`, `analysis_progress` tables
- All tables follow the design specification

### 2. Core Types (`src/types.ts`)
- Analyzer types: `AnalyzerDef`, `AnalyzerVersion`, `AnalyzerConfig`, `PromptVersion`, `AnalysisNodeRow`, `RunRow`, `ProgressRow`, `ProposalRow`
- Source types: `SourceRef`, `AnalysisUnit`, `AnalysisEdge`, `AnalysisResult`
- Context types: `AnalyzerPlanContext`, `AnalyzerRunContext`
- LLM types: `LLMRequest`, `LLMResponse`

### 3. Input Hash (`src/input-hash.ts`)
- `computeSourceSetHash()` - hashes source references
- `computePromptBundleHash()` - hashes prompt bundle
- `computeInputHash()` - main idempotency key

### 4. Analyzer Framework (`src/analyze.ts`)
- `AnalyzerFramework` class with:
  - `registerDef()` - register analyzer definition
  - `run()` - execute analyzer on session
  - Full idempotency via input_hash checking
  - Edge insertion for graph relationships

### 5. Turn-Pair Core Analyzer (`src/commands/turn-pair-core-analyzer.ts`)
- Detects correction patterns (explicit, implicit, repetition)
- Computes friction score from multiple signals
- Extracts deterministic metrics: message lengths, tool calls, thinking, corrections
- Creates analysis nodes with edges to source messages

## Working Test Results

```
Created 1 analysis node(s)

Node content:
{
  "user_msg_length": 62,
  "correction_detected": true,
  "correction_patterns": ["implicit"],
  "friction_score": 0.4,
  ...
}

After second run: 1 analysis node(s) (idempotency working!)
```

## Remaining to Implement

### Turn-Pair LLM Analyzer
- LLM-based sentiment and friction analysis
- Depends on turn-pair-core

### Session Overview Analyzer  
- Session-level summary with proposals
- Map-reduce for large sessions

### Real Session Integration
- Run on actual ~/.pi session files
- Generate actionable proposals

## To Run When You Wake Up

```bash
# Build
npm run build

# Create test DB with sample data
node test-analyze-real.mjs

# Run on real sessions (after setting OPENROUTER_API_KEY)
node run-analyzer-on-real.mjs
```
