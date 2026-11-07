/**
 * The frustration hits a reader may count.
 *
 * Reading hits is not "select the nodes". Three separate judgements decide
 * whether a hit contributes a number, and a reader that makes only some of them
 * gets a wrong total in a way nothing else catches:
 *
 *   1. **Which generation.** An unmute or a revise writes a *new* hit node and
 *      leaves the old one live, superseded by a `revises` edge. Taking every
 *      live node counts the same signal twice, so a reader takes the newest node
 *      per logical hit. (`currentHits`.)
 *   2. **Whether the term is muted.** A mute is the operator saying "not that
 *      one", recorded as a `mutes` edge from the silenced hit to the assertion
 *      (#325). The hit nodes stay — the graph is append-only — but they must stop
 *      counting. (`getMutedNodeIds` and `withoutMutedNodes`, the one predicate
 *      every reader filters on.)
 *   3. **Whether the term is background.** A word carried by a large share of
 *      the corpus's turns cannot distinguish one turn from another, and a
 *      ranking that totals weights lets such a word win on volume alone. The
 *      share is measured from the corpus, in any language, with no vocabulary.
 *
 *   4. **Whose words.** A hit records how many of its occurrences the person
 *      typed (`typed_count` of `count`). A swear word inside a quote, a pasted
 *      log or a brief another agent wrote says nothing about how the person
 *      feels, so the reading scales the weight by the typed share and drops a hit
 *      with none. A hit drawn before the origin fields existed has no
 *      `typed_count` and is read as it always was.
 *
 * The four compose in that order, and this module exists so they are composed
 * **once**. Every reader that computes a number from hits calls `pricedHits`;
 * none of them re-implements the sequence, so none of them can drift from
 * another's idea of what counts.
 *
 * Hits priced at zero are dropped rather than returned with a zero weight. Every
 * reader here asks "did this signal fire on this turn", and a zero-weight hit
 * answers yes to a question the corpus has already answered no to.
 */

import { type AsyncDatabase } from "../db/async-db.js";
import { getMutedNodeIds, withoutMutedNodes } from "../db/assertions.js";
import { currentHits, currentNodesKeepingErrors, hitSignal } from "../db/muted-terms.js";
import { termPrevalence } from "../db/term-prevalence.js";
import { TURN_FRUSTRATION_DEF } from "./analyzers/turn-frustration/index.js";
import { TURN_PAIR_CORE_DEF } from "./analyzers/turn-pair-core/index.js";
import { termSpecificity } from "./term-specificity.js";
import type { AnalysisNodeRow } from "./types.js";

/** How much of the three-stage read a caller wants. */
export interface PricedHitsOptions {
	/** Override the background-vocabulary cut. Defaults to `DEFAULT_MAX_DOCUMENT_SHARE`. */
	maxDocumentShare?: number;
	/**
	 * Keep every live generation instead of collapsing to the newest per hit.
	 *
	 * Only a listing that was explicitly asked for `--all-versions` wants this:
	 * it is showing the graph's lineage, so every generation is a fact it asked
	 * to see. It still prices, because a background word is not a fact anyone
	 * asked for.
	 */
	keepGenerations?: boolean;
	/**
	 * Keep the error nodes.
	 *
	 * A reader that computes a number has no use for a failed unit, but a listing
	 * does: an error is exactly what the operator needs to see.
	 */
	keepErrorNodes?: boolean;
}

/**
 * The hits a reader may count, each carrying its corpus-derived weight.
 *
 * The returned rows are a **reading, not the graph**: the `weight` in each
 * `content_json` is the hit's stored weight scaled by the term's specificity,
 * and a hit priced at zero is absent. A caller that shows the graph (the node
 * listing) must not use this — it reads the rows as stored.
 */
export async function pricedHits(
	db: AsyncDatabase,
	nodes: readonly AnalysisNodeRow[],
	options: PricedHitsOptions = {},
): Promise<AnalysisNodeRow[]> {
	const mutedIds = await getMutedNodeIds(db);
	const collapsed = options.keepGenerations
		? [...nodes]
		: options.keepErrorNodes
			? currentNodesKeepingErrors(nodes)
			: currentHits(nodes);
	const current = withoutMutedNodes(collapsed, mutedIds);
	if (current.length === 0) return [];

	const prevalence = await termPrevalence(db, TURN_PAIR_CORE_DEF.id, TURN_FRUSTRATION_DEF.id);

	const priced: AnalysisNodeRow[] = [];
	for (const node of current) {
		const typed = typedShare(node);
		if (typed <= 0) continue;
		const signal = hitSignal(node);
		// A marker hit (`shouting`, `repeated_punctuation`, `elongation`) has no
		// spelling and no lexicon entry: it is not vocabulary, so there is no share
		// to take and nothing to price. Its signal id is namespaced, which is what
		// distinguishes it from a term.
		if (signal === null || signal.startsWith("paralinguistic:")) {
			priced.push(typed === 1 ? node : withWeight(node, typed));
			continue;
		}
		const specificity = termSpecificity(prevalence.hitDocuments.get(signal) ?? 0, prevalence.documents, options.maxDocumentShare);
		if (specificity <= 0) continue;
		if (specificity * typed === 1) {
			priced.push(node);
			continue;
		}
		priced.push(withWeight(node, specificity * typed));
	}
	return priced;
}

/** The share of the hit's occurrences that the person typed, or 1 for a hit with no origin fields. */
function typedShare(node: AnalysisNodeRow): number {
	let props: Record<string, unknown>;
	try {
		props = JSON.parse(node.content_json) as Record<string, unknown>;
	} catch {
		return 1;
	}
	const typed = props["typed_count"];
	const count = props["count"];
	if (typeof typed !== "number" || typeof count !== "number" || count <= 0) return 1;
	return Math.min(1, typed / count);
}

/**
 * A copy of the row whose stored weight is scaled by `factor`.
 *
 * The input row is never mutated: callers hold rows that other readers share,
 * and the graph itself is immutable.
 */
function withWeight(node: AnalysisNodeRow, factor: number): AnalysisNodeRow {
	let props: Record<string, unknown>;
	try {
		props = JSON.parse(node.content_json) as Record<string, unknown>;
	} catch {
		return node;
	}
	const stored = typeof props["weight"] === "number" ? (props["weight"] as number) : 0;
	return { ...node, content_json: JSON.stringify({ ...props, weight: stored * factor }) };
}
