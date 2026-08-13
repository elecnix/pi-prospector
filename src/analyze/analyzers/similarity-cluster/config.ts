import { Type } from "@sinclair/typebox";
import { computeConfigHash } from "../../input-hash.js";

export const SimilarityClusterConfigSchema = Type.Object({
  k: Type.Number(),
  threshold: Type.Number(),
  nominate_with: Type.Number(),
  max_freq: Type.Number(),
  min_nodes: Type.Number(),
  detect_tool_calls: Type.Boolean(),
  detect_tool_results: Type.Boolean(),
  detect_user_prompts: Type.Boolean(),
  min_cluster_size: Type.Number(),
  top: Type.Number(),
  max_result_nodes: Type.Number(),
});

export type SimilarityClusterConfig = {
  k: number;
  threshold: number;
  nominate_with: number;
  max_freq: number;
  min_nodes: number;
  detect_tool_calls: boolean;
  detect_tool_results: boolean;
  detect_user_prompts: boolean;
  min_cluster_size: number;
  top: number;
  max_result_nodes: number;
};

export const DEFAULT_SIMILARITY_CLUSTER_CONFIG: SimilarityClusterConfig = {
  k: 4,
  threshold: 0.15,
  nominate_with: 12,
  max_freq: 50,
  min_nodes: 10,
  detect_tool_calls: true,
  detect_tool_results: true,
  detect_user_prompts: true,
  min_cluster_size: 3,
  top: 100,
  max_result_nodes: 4000,
};

export const DEFAULT_SIMILARITY_CLUSTER_CONFIG_HASH = computeConfigHash(DEFAULT_SIMILARITY_CLUSTER_CONFIG);
