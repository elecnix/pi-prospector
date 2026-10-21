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

import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";

/** True when no live node revises the row aliased `n`. Backs the `current_nodes` view. */
export const NOT_REVISED_LIVE = `NOT EXISTS (
	SELECT 1 FROM analysis_edges e JOIN live_nodes s ON s.id = e.from_node_id
	WHERE e.edge_kind = '${EDGE_KINDS.REVISES}' AND e.to_ref_id = n.output_key)`;

/**
 * The SQL expression for a mute instance: an assertion row's `asserted_at` as a
 * millisecond epoch.
 *
 * A `mutes` edge's `ordinal` carries the mute instance that created it, so the
 * edge says "this edge belongs to the mute in force". The instance is derived
 * from the assertion's own `asserted_at`, which a re-mute replaces, so two
 * mutes of the same term are two instances.
 *
 * The resolution is milliseconds, not seconds: two mutes inside one second are
 * two different judgements, and a second-resolution instance would let the
 * second mute claim the first mute's edges. The expression is the same one the
 * SQLite epoch gives, so the value a query computes matches the value the
 * writer stored.
 *
 * The alias names the assertions row in the calling query, because SQLite
 * resolves a column through the alias a table is joined under.
 */
export const muteInstanceOrdinalSql = (assertionsAlias = "a"): string =>
	`CAST((julianday(${assertionsAlias}.asserted_at) - 2440587.5) * 86400000 AS INTEGER)`;

/** The expression for a mute instance, for a query that joins `assertions a`. */
export const MUTE_INSTANCE_ORDINAL_SQL = muteInstanceOrdinalSql("a");

/**
 * True when no ACTIVE mute silences the row aliased `n` (#325).
 *
 * A `mutes` edge records that a human assertion silenced a node's conclusion —
 * "this node's conclusion is silenced by that human assertion". The assertion
 * is append-only: unmuting supersedes it (`superseded_at`), which makes the
 * edge inert again, so the node counts once more. The edge is never deleted, so
 * the mark's history stays inspectable.
 *
 * The edge's `ordinal` carries the *mute instance* that created it: the
 * assertion's `asserted_at` at the moment of the mute. An assertion row is one
 * logical judgement — (kind, key, verdict) — and a re-mute reactivates that
 * same row. Without the instance, a re-mute would revive the previous mute's
 * edges and silence conclusions the new mute never marked, which is how a
 * second mute quietly unsilences a conclusion that was drawn under no mute at
 * all. The instance is what says "this edge belongs to the mute in force".
 *
 * A muted node is live (it still exists, still verifies, still carries its
 * lineage) but it is not a *current* finding: the operator has said this
 * conclusion does not count, so it must leave every aggregate read.
 */
export const NOT_MUTED_LIVE = `NOT EXISTS (
	SELECT 1 FROM analysis_edges e JOIN assertions a ON a.id = e.to_ref_id
	WHERE e.edge_kind = '${EDGE_KINDS.MUTES}'
	  AND e.to_ref_kind = '${REF_KINDS.ASSERTION}'
	  AND e.from_node_id = n.id
	  AND a.subject_kind = 'term' AND a.verdict = 'muted' AND a.superseded_at IS NULL
	  AND e.ordinal = ${MUTE_INSTANCE_ORDINAL_SQL})`;

/**
 * The as-of twin of {@link NOT_REVISED_LIVE}: true when no node that existed and
 * was unretracted at T revises the row aliased `n`. Binds T twice.
 */
export const NOT_REVISED_AS_OF = `NOT EXISTS (
	SELECT 1 FROM analysis_edges e JOIN analysis_nodes s ON s.id = e.from_node_id
	WHERE e.edge_kind = '${EDGE_KINDS.REVISES}' AND e.to_ref_id = n.output_key
	  AND s.created_at <= ? AND (s.retracted_at IS NULL OR s.retracted_at > ?))`;

/**
 * The as-of twin of {@link NOT_MUTED_LIVE}: true when no mute that was active
 * at T silences the row aliased `n`. A mute is active at T when it was asserted
 * by T and had not been superseded by T. Binds T twice.
 */
export const NOT_MUTED_AS_OF = `NOT EXISTS (
	SELECT 1 FROM analysis_edges e JOIN assertions a ON a.id = e.to_ref_id
	WHERE e.edge_kind = '${EDGE_KINDS.MUTES}'
	  AND e.to_ref_kind = '${REF_KINDS.ASSERTION}'
	  AND e.from_node_id = n.id
	  AND a.subject_kind = 'term' AND a.verdict = 'muted'
	  AND a.asserted_at <= ? AND (a.superseded_at IS NULL OR a.superseded_at > ?)
	  AND e.ordinal = ${MUTE_INSTANCE_ORDINAL_SQL})`;
