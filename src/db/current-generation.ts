/**
 * The current generation of the analysis graph (#260), as SQL predicates.
 *
 * The graph is append-only, so revising an analyzer leaves every superseded
 * node live. A node is **current** when it is live and no live node revises it
 * — the head of its lineage chain. The `revises` edge is the recomputation's
 * own record of what it replaced, so supersession is read from it rather than
 * guessed from `analyzer_version_id` (wrong after a downgrade) or `created_at`
 * (wrong after a re-run of an older recipe).
 *
 * `revises` edges reference the predecessor's content-addressed `output_key`,
 * served by `idx_edges_to(to_ref_id, edge_kind)`.
 */

import { EDGE_KINDS } from "../analyze/edge-kinds.js";

/** True when no live node revises the row aliased `n`. Backs the `current_nodes` view. */
export const NOT_REVISED_LIVE = `NOT EXISTS (
	SELECT 1 FROM analysis_edges e JOIN live_nodes s ON s.id = e.from_node_id
	WHERE e.edge_kind = '${EDGE_KINDS.REVISES}' AND e.to_ref_id = n.output_key)`;

/**
 * The as-of twin of {@link NOT_REVISED_LIVE}: true when no node that existed and
 * was unretracted at T revises the row aliased `n`. Binds T twice.
 */
export const NOT_REVISED_AS_OF = `NOT EXISTS (
	SELECT 1 FROM analysis_edges e JOIN analysis_nodes s ON s.id = e.from_node_id
	WHERE e.edge_kind = '${EDGE_KINDS.REVISES}' AND e.to_ref_id = n.output_key
	  AND s.created_at <= ? AND (s.retracted_at IS NULL OR s.retracted_at > ?))`;
