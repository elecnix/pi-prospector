/**
 * Configuration for the similarity-cluster analyzer (issue #145).
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the (ungraded) `config` reason, recomputed only by a run that asks
 * for it. Per-detector defaults follow the issue's tuning table — tool calls
 * are short and dense (narrow shingles, loose threshold), tool results are long
 * and sparse (wide shingles, strict threshold), user prompts sit between.
 */

import { Type, type Static } from "typebox";

export const SimilarityClusterConfig = Type.Object({
	// ── shared knobs, per detector ──
	/** Shingle width in normalised tokens for the tool-call domain. */
	shingleWidthToolCalls: Type.Integer({ minimum: 2 }),
	/** Shingle width for the user-prompt domain. */
	shingleWidthPrompts: Type.Integer({ minimum: 2 }),
	/** Shingle width for the tool-result domain. */
	shingleWidthResults: Type.Integer({ minimum: 2 }),
	/** Maximum dissimilarity to report for tool calls: 1 − minSimilarity. */
	thresholdToolCalls: Type.Number({ minimum: 0, maximum: 1 }),
	/** Maximum dissimilarity for user prompts. */
	thresholdPrompts: Type.Number({ minimum: 0, maximum: 1 }),
	/** Maximum dissimilarity for tool results. */
	thresholdResults: Type.Number({ minimum: 0, maximum: 1 }),
	/** Rarest shingles a tool call is indexed under. */
	nominateWithToolCalls: Type.Integer({ minimum: 1 }),
	/** Rarest shingles a text item (prompt or result) is indexed under. */
	nominateWithText: Type.Integer({ minimum: 1 }),
	/** Document frequency above which a tool-call shingle is dropped from the index. */
	maxFreqToolCalls: Type.Integer({ minimum: 2 }),
	/** Document frequency above which a text shingle is dropped from the index. */
	maxFreqText: Type.Integer({ minimum: 2 }),
	/** Minimum normalised token count for a tool call to enter near-miss nomination. */
	minTokensToolCalls: Type.Integer({ minimum: 1 }),
	/** Minimum normalised token count for a tool result to enter near-miss nomination. */
	minTokensResults: Type.Integer({ minimum: 1 }),
	/** Minimum normalised token count (after stop-word removal) for a prompt to enter near-miss nomination. */
	minTokensPrompts: Type.Integer({ minimum: 1 }),

	// ── detector toggles ──
	detectToolCalls: Type.Boolean(),
	detectToolResults: Type.Boolean(),
	detectUserPrompts: Type.Boolean(),

	// ── output ──
	/** Minimum members per cluster before it is surfaced as a proposal. */
	minClusterSize: Type.Integer({ minimum: 2 }),
	/** Maximum clusters reported per node, ranked by similarity then size. */
	topClusters: Type.Integer({ minimum: 1 }),
	/** Maximum tokens kept of a tool result before head/tail truncation with a middle hash placeholder. */
	maxResultTokens: Type.Integer({ minimum: 100 }),
	/**
	 * Maximum sibling sessions folded into a unit's source set when clustering
	 * across sessions sharing the session's `cwd`. Bounds both extraction cost
	 * and the pooled corpus size; sessions beyond the cap (deterministic id order)
	 * are invisible to this analyzer until they re-identify its units.
	 */
	maxSessions: Type.Integer({ minimum: 1 }),
});
export type SimilarityClusterConfig = Static<typeof SimilarityClusterConfig>;

export const DEFAULT_SIMILARITY_CLUSTER_CONFIG: SimilarityClusterConfig = {
	shingleWidthToolCalls: 4,
	shingleWidthPrompts: 5,
	shingleWidthResults: 6,
	thresholdToolCalls: 0.15,
	thresholdPrompts: 0.25,
	thresholdResults: 0.3,
	nominateWithToolCalls: 12,
	nominateWithText: 20,
	maxFreqToolCalls: 50,
	maxFreqText: 100,
	// The issue specifies min_nodes=10 for tool calls, but a normalised shell
	// command ("bash command git diff HEAD~1") is ~5 tokens — at 10 most real
	// commands would be ineligible for near-miss nomination and only exact
	// duplicates would ever surface. 6 keeps one-line commands visible while
	// still excluding single-token noise.
	minTokensToolCalls: 6,
	minTokensResults: 50,
	minTokensPrompts: 8,

	detectToolCalls: true,
	detectToolResults: true,
	detectUserPrompts: true,

	minClusterSize: 3,
	topClusters: 100,
	maxResultTokens: 4000,
	// v1 scale envelope (~1,000 sessions): extraction is cheap, but pooling every
	// sibling's items into one pipeline per session costs O(siblings × items);
	// 200 keeps a corpus-wide repo group tractable while still spanning "this month".
	maxSessions: 200,
};
