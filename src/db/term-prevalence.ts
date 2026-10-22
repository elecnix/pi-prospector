/**
 * How often each frustration signal fires across the corpus.
 *
 * A term's weight has to depend on the corpus, and the corpus grows. That rules
 * out storing the weight in a hit node: a node is written once and reused
 * whenever its source set and recipe are unchanged, so a weight frozen at
 * creation would keep pricing a word by the corpus as it was when it was first
 * seen — `do` cost nothing on a corpus of five turns and would go on costing
 * nothing after five thousand. Folding the count into the node's identity
 * instead would change every hit's identity on every new session, which is a
 * recompute of the whole corpus per sync.
 *
 * So the count is a query, evaluated when a reader computes a number. It is a
 * pure function of the graph, it costs one grouped scan, and it is always
 * current.
 *
 * Two counts are needed, and they are deliberately taken over different node
 * kinds:
 *
 *   - **documents** — analysed turns, from `turn-pair-core`. This is the
 *     denominator, and it must count turns that carried *no* signal: a share
 *     measured only over signal-carrying turns would say every term in the
 *     lexicon is common.
 *   - **hit documents** — distinct turns each *lexicon* signal fired on. Marker
 *     hits are excluded on purpose: `shouting` is not background vocabulary, and
 *     a session where the user shouts in most turns is exactly the session a
 *     reader should see. Markers have no spelling, so there is nothing about
 *     them to price.
 *
 * Counting *distinct turns* rather than nodes is what makes this safe in an
 * append-only graph: a signal's superseded generations all name the same turn,
 * so a revise or an unmute cannot inflate the count.
 */

import { type AsyncDatabase } from "./async-db.js";
import { prep } from "./prepared.js";

/** A signal's reach across the corpus, ready to be turned into a weight. */
export interface TermPrevalence {
	/** Analysed turns in the corpus — the denominator of a document share. */
	documents: number;
	/** Distinct turns each lexicon signal fired on, keyed by the signal. */
	hitDocuments: Map<string, number>;
}

/**
 * Count how many analysed turns the corpus holds, and how many carry each
 * lexicon signal.
 *
 * @param documentAnalyzerId the analyzer whose nodes define "an analysed turn"
 * @param hitAnalyzerId the analyzer whose nodes carry the signals
 */
export async function termPrevalence(
	db: AsyncDatabase,
	documentAnalyzerId: string,
	hitAnalyzerId: string,
): Promise<TermPrevalence> {
	const documentRow = (await prep(db, `
		SELECT COUNT(DISTINCT json_extract(content_json, '$.user_message_id')) AS documents
		FROM live_nodes
		WHERE analyzer_id = ? AND node_kind <> 'error'
			AND json_extract(content_json, '$.user_message_id') IS NOT NULL
	`).all(documentAnalyzerId)) as Array<{ documents: number | null }>;

	const rows = (await prep(db, `
		SELECT json_extract(content_json, '$.signal') AS signal,
			COUNT(DISTINCT json_extract(content_json, '$.user_message_id')) AS hit_documents
		FROM live_nodes
		WHERE analyzer_id = ? AND node_kind <> 'error'
			AND json_extract(content_json, '$.signal_source') = 'lexicon'
			AND json_extract(content_json, '$.signal') IS NOT NULL
		GROUP BY signal
	`).all(hitAnalyzerId)) as Array<{ signal: string | null; hit_documents: number | null }>;

	const hitDocuments = new Map<string, number>();
	for (const row of rows) {
		if (typeof row.signal !== "string" || row.signal.length === 0) continue;
		hitDocuments.set(row.signal, Number(row.hit_documents ?? 0));
	}

	return { documents: Number(documentRow[0]?.documents ?? 0), hitDocuments };
}
