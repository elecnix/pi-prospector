/**
 * Reading a corpus's frustration hits with the operator's mutes honoured.
 *
 * A mute is external human input: the operator says "not that one" about a term
 * the lexicon flagged. Two things follow from it, and they are separate:
 *
 *   - **Future matches.** `turn-frustration`'s `plan()` skips a muted term, so
 *     no new hit node is produced for it.
 *   - **Past hits.** A muted term's existing hit nodes stay in the graph — the
 *     graph is append-only and a node is never deleted — but they must stop
 *     *counting*. A reader that summed them would report a term the operator
 *     has explicitly rejected as one of the corpus's loudest signals, which is
 *     the opposite of what the mute was for.
 *
 * This module is the read side of that second half. It is deliberately a
 * *filter*, not a retraction: it changes what a reader counts, never what the
 * graph holds. Retracting the nodes themselves (and undoing it on unmute) is a
 * separate concern, tracked in issue #325.
 *
 * Two readers need it, and both need it *at the point the number is computed*,
 * because the mute is a property of the corpus, not of any one node:
 *
 *   - `friction-accumulation`, which sums hit weights into a session's
 *     accumulated friction.
 *   - the session digest, which counts the turns carrying a frustration signal
 *     and lists the terms that carried them.
 *
 * A muted term's hits are *excluded*, not zeroed: exclusion is what "stops
 * counting" means, and it leaves the unmute symmetric — unmuting restores the
 * term to the counts without anything having to be recomputed.
 *
 * ## The current generation
 *
 * A mute and its unmute each produce a *new* hit node under a new recipe, and
 * the graph is append-only: the muted-era hit stays live beside the unmute-era
 * one, superseded by a `revises` edge rather than deleted. A reader that took
 * every live hit would therefore count the same signal twice after an unmute.
 *
 * So every reader here reads the **current generation** — the newest node per
 * logical hit — which is what the `current_nodes` view already resolves for
 * the rest of the system. The hit's logical identity is its (turn, signal)
 * pair, which is also its source set: the turn's message plus the signal.
 */

import { type AsyncDatabase } from "./async-db.js";
import type { AnalysisNodeRow } from "../analyze/types.js";

/**
 * The signal of one frustration hit, or `null` when the node does not carry one.
 *
 * A *lexicon* hit's signal is the term. A *paralinguistic* hit's signal is a
 * marker name (`shouting`, `repeated_punctuation`, `elongation`) and is never
 * muted by a term: a mute says "not that word", not "not the way this person
 * shouts". The marker is namespaced by the same prefix the hit's source ref
 * uses, so a mute of the literal marker name cannot silence it by accident.
 */
export function hitSignal(node: AnalysisNodeRow): string | null {
	let props: Record<string, unknown>;
	try {
		props = JSON.parse(node.content_json) as Record<string, unknown>;
	} catch {
		return null;
	}
	const source = typeof props["signal_source"] === "string" ? (props["signal_source"] as string) : "";
	const signal = typeof props["signal"] === "string" ? (props["signal"] as string) : "";
	if (signal.length === 0) return null;
	return source === "lexicon" ? signal.toLowerCase() : `paralinguistic:${signal}`;
}

/**
 * The current generation of a set of hit nodes: the newest node per logical
 * hit.
 *
 * A hit's logical identity is its (turn, signal) pair, which is exactly its
 * source set — the turn's message plus the signal. Two live nodes with the
 * same source set are two generations of one hit: the earlier one was revised
 * by the later, and the graph keeps it as lineage.
 *
 * Collapsing here is what keeps an unmute symmetric. The unmute produces a new
 * hit node under the unmute-era recipe and leaves the muted-era one live, so a
 * reader that took every live hit would count the signal twice — once from the
 * muted era and once from the unmute era.
 *
 * Error nodes are left alone. An error node is a failed unit, not a hit, and
 * a reader that reports hits has no use for one. A reader that lists the
 * graph does: an error is exactly what the operator needs to see, so it keeps
 * its own nodes and collapses the hits on its own.
 *
 * The newest node wins, decided by `created_at` and then by `id`, so the
 * result does not depend on the order the rows arrive in.
 */
export function currentHits(nodes: readonly AnalysisNodeRow[]): AnalysisNodeRow[] {
	const newest = new Map<string, AnalysisNodeRow>();
	for (const node of nodes) {
		if (node.node_kind === "error") continue;
		const current = newest.get(node.source_set_hash);
		if (!current || isNewer(node, current)) newest.set(node.source_set_hash, node);
	}
	return [...newest.values()];
}

/**
 * The current generation of a set of nodes, keeping the error nodes.
 *
 * The listing reader shows the whole graph, an error node included, so it
 * collapses the hits and passes the rest through untouched.
 */
export function currentNodesKeepingErrors(nodes: readonly AnalysisNodeRow[]): AnalysisNodeRow[] {
	const errors = nodes.filter((node) => node.node_kind === "error");
	return [...currentHits(nodes), ...errors];
}

/** Whether `a` was created after `b`, with the id breaking a tie. */
function isNewer(a: AnalysisNodeRow, b: AnalysisNodeRow): boolean {
	if (a.created_at !== b.created_at) return a.created_at > b.created_at;
	return a.id > b.id;
}
