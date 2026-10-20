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
 */

import { type AsyncDatabase } from "./async-db.js";
import { getMutedTerms } from "./assertions.js";
import type { AnalysisNodeRow } from "../analyze/types.js";

/**
 * The corpus's currently-muted terms, normalised the way the lexicon keys them.
 *
 * A mute whose key is not in the lexicon still matters: it is a statement that
 * the term is not a signal, and it must not contribute to any count.
 */
export async function mutedTerms(db: AsyncDatabase): Promise<Set<string>> {
	return new Set((await getMutedTerms(db)).map((t) => t.trim().toLowerCase()));
}

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
 * The frustration hits of a set of nodes with the muted terms removed.
 *
 * Returns the nodes that still count, in the order they were given, so a reader
 * keeps its own ordering. A node that cannot be parsed, or that carries no
 * signal, is dropped: it cannot be checked against the mute list, and a hit
 * with no signal contributes no weight to anything.
 */
export function unmutedHits(nodes: readonly AnalysisNodeRow[], muted: ReadonlySet<string>): AnalysisNodeRow[] {
	if (muted.size === 0) return [...nodes];
	return nodes.filter((node) => {
		const signal = hitSignal(node);
		// A node with no readable signal cannot be checked against the mute list, so
		// it is left alone: a mute says "not that term", never "this node does not
		// exist".
		if (signal === null) return true;
		return !muted.has(signal);
	});
}
