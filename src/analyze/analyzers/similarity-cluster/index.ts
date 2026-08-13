import type {
  Analyzer,
  AnalyzerDef,
  AnalyzerPlanContext,
  AnalyzerRunContext,
  AnalysisResult,
  AnalysisUnit,
} from "../../types.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { DEFAULT_SIMILARITY_CLUSTER_CONFIG } from "./config.js";

export const SIMILARITY_CLUSTER_DEF: AnalyzerDef = {
  id: "similarity-cluster",
  label: "Similarity Cluster (near-duplicate detection)",
  description:
    "Deterministic near-miss clustering of user prompts, tool calls, and tool results across sessions.",
  anchorSpan: "cross_session",
};

export const SIMILARITY_CLUSTER_VERSION = {
  analyzerId: SIMILARITY_CLUSTER_DEF.id,
  major: 0,
  minor: 1,
  implementationKind: "deterministic" as const,
  codeRef: "src/analyze/analyzers/similarity-cluster/index.ts",
};

export interface SimilarityClusterProperties {
  detector: "tool_call" | "tool_result" | "user_prompt";
  members: Array<{
    session_id: string;
    message_id: string;
    turn_ordinal: number;
    normalized_hash: string;
    excerpt: string;
  }>;
  avg_similarity: number;
  size: number;
  blind_count: number;
  corpus_size: number;
  comparisons: number;
}

export const similarityClusterAnalyzer: Analyzer = {
  def: SIMILARITY_CLUSTER_DEF,
  version: SIMILARITY_CLUSTER_VERSION,
  prompts: {} as Record<string, unknown>,
  defaultConfig: {
    id: "",
    analyzerId: SIMILARITY_CLUSTER_DEF.id,
    configHash: "",
    configJson: DEFAULT_SIMILARITY_CLUSTER_CONFIG as unknown as Record<string, unknown>,
    label: "default",
  },

  plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
    // Stub implementation: no units until full clustering is implemented.
    return [];
  },

  analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
    // Stub: return empty metric node.
    return {
      nodeKind: "metric",
      contentJson: {},
      anchorKind: "session",
      anchorRef: unit.anchorRef ?? "",
      edges: [],
    };
  },
};
