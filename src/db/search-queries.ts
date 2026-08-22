/**
 * Content and pattern search over the indexed corpus (issue #194).
 *
 * Two FTS5 indexes back the search surface, both maintained by triggers at
 * write time so no reindex step exists or is needed:
 *
 *   - `messages_fts` — the session corpus: user and assistant message text and
 *     the assistant's private reasoning (external content over `messages`).
 *   - `proposals_fts` — the proposal store: title, summary, detail, evidence
 *     (external content over `proposals`).
 *
 * The query is honest FTS5 MATCH syntax passed through verbatim — quoted
 * phrases, implicit AND across terms, OR/NOT, NEAR, column filters
 * (`title:foo`), and prefix terms (`term*`). A malformed query is an Error
 * with a user-facing message, never a silent empty result: an empty result
 * reads as "the corpus does not contain this", which is a different claim.
 *
 * Ranking is bm25 (lower is better), merged across both record kinds so one
 * result list answers "where does this appear in my corpus at all".
 */

import type { AsyncDatabase } from "./async-db.js";

/** Snippet highlight markers wrapped around each matched term. */
export const SNIPPET_OPEN = "⟦";
export const SNIPPET_CLOSE = "⟧";

/** Which record kinds a search covers. Default is both. */
export type SearchKind = "all" | "messages" | "proposals";

/** One matched message in the session corpus. */
export interface MessageSearchHit {
	kind: "message";
	message_id: string;
	session_id: string;
	role: string;
	source: string;
	/** bm25 rank, lower is better. */
	rank: number;
	/** Excerpt of the matching column with SNIPPET_OPEN/CLOSE around matches. */
	snippet: string;
	/** Which indexed column the snippet came from. */
	field: "content_text" | "content_thinking";
}

/** One matched proposal in the proposal store. */
export interface ProposalSearchHit {
	kind: "proposal";
	proposal_id: string;
	session_id: string;
	title: string;
	severity: string;
	status: string;
	analyzer_id: string | null;
	/** bm25 rank, lower is better. */
	rank: number;
	snippet: string;
	field: "title" | "summary" | "detail" | "evidence";
}

export type SearchHit = MessageSearchHit | ProposalSearchHit;

export interface SearchResult {
	query: string;
	hits: SearchHit[];
	/** Hits of each kind before the merged limit was applied. */
	message_matches: number;
	proposal_matches: number;
	/** Hits dropped by the limit. */
	omitted_by_limit: number;
}

export interface SearchOptions {
	kind?: SearchKind;
	limit?: number;
	/** Filter both record kinds by the harness source of their session (`pi` | `claude`). */
	source?: string;
}

/** Hard cap on hits fetched per kind before merging — the read path is bounded. */
const MAX_PER_KIND = 500;

interface FtsMessageRow {
	message_id: string;
	session_id: string;
	role: string;
	source: string;
	rank: number;
	text_snippet: string | null;
	thinking_snippet: string | null;
}

interface FtsProposalRow {
	proposal_id: string;
	session_id: string;
	title: string;
	severity: string;
	status: string;
	analyzer_id: string | null;
	rank: number;
	title_snippet: string | null;
	summary_snippet: string | null;
	detail_snippet: string | null;
	evidence_snippet: string | null;
}

const hasMark = (s: string | null): s is string => s !== null && s.includes(SNIPPET_OPEN);

/**
 * Run the corpus search. Throws an Error with a user-facing message when the
 * query is empty or not valid FTS5 MATCH syntax.
 */
export async function searchCorpus(db: AsyncDatabase, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
	const q = query.trim();
	if (q.length === 0) {
		throw new Error("empty search query (FTS5 MATCH syntax: terms, \"quoted phrases\", a*, AND/OR/NOT, NEAR, column:term)");
	}
	const kind = opts.kind ?? "all";
	const limit = opts.limit ?? 50;
	const wantMessages = kind !== "proposals";
	const wantProposals = kind !== "messages";

	const messageHits: MessageSearchHit[] = [];
	let messageMatches = 0;
	if (wantMessages) {
		const sourceClause = opts.source ? " AND m.source = ?" : "";
		const params: (string | number)[] = opts.source ? [q, opts.source, MAX_PER_KIND] : [q, MAX_PER_KIND];
		let rows: FtsMessageRow[];
		try {
			rows = (await db
				.prepare(
					`SELECT m.id AS message_id, m.session_id, m.role, m.source,
						bm25(messages_fts) AS rank,
						snippet(messages_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 16) AS text_snippet,
						snippet(messages_fts, 1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 16) AS thinking_snippet
					FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
					WHERE messages_fts MATCH ?${sourceClause}
					ORDER BY rank LIMIT ?`,
				)
				.all(...params)) as FtsMessageRow[];
		} catch (err) {
			throw wrapFtsError(err, q);
		}
		messageMatches = rows.length;
		for (const r of rows) {
			if (hasMark(r.text_snippet)) {
				messageHits.push({ ...hit(r), snippet: r.text_snippet, field: "content_text" });
			} else if (hasMark(r.thinking_snippet)) {
				messageHits.push({ ...hit(r), snippet: r.thinking_snippet, field: "content_thinking" });
			} else {
				// No column carried a marker (possible with certain phrase/NEAR
				// queries); fall back to the text column's excerpt rather than
				// rendering a snippet with no visible match.
				messageHits.push({ ...hit(r), snippet: r.text_snippet ?? "", field: "content_text" });
			}
		}
	}

	const proposalHits: ProposalSearchHit[] = [];
	let proposalMatches = 0;
	if (wantProposals) {
		const sourceClause = opts.source ? " AND s.source = ?" : "";
		const join = opts.source ? " JOIN sessions s ON s.id = p.session_id" : "";
		const params: (string | number)[] = opts.source ? [q, opts.source, MAX_PER_KIND] : [q, MAX_PER_KIND];
		let rows: FtsProposalRow[];
		try {
			rows = (await db
				.prepare(
					`SELECT p.id AS proposal_id, p.session_id, p.title, p.severity, p.status, p.analyzer_id,
						bm25(proposals_fts) AS rank,
						snippet(proposals_fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 16) AS title_snippet,
						snippet(proposals_fts, 1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 16) AS summary_snippet,
						snippet(proposals_fts, 2, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 16) AS detail_snippet,
						snippet(proposals_fts, 3, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 16) AS evidence_snippet
					FROM proposals_fts JOIN proposals p ON p.rowid = proposals_fts.rowid${join}
					WHERE proposals_fts MATCH ?${sourceClause}
					ORDER BY rank LIMIT ?`,
				)
				.all(...params)) as FtsProposalRow[];
		} catch (err) {
			throw wrapFtsError(err, q);
		}
		proposalMatches = rows.length;
		const fields = ["title", "summary", "detail", "evidence"] as const;
		for (const r of rows) {
			const snippets = [r.title_snippet, r.summary_snippet, r.detail_snippet, r.evidence_snippet];
			const idx = snippets.findIndex(hasMark);
			const picked = idx >= 0 ? idx : 0;
			proposalHits.push({
				kind: "proposal",
				proposal_id: r.proposal_id,
				session_id: r.session_id,
				title: r.title,
				severity: r.severity,
				status: r.status,
				analyzer_id: r.analyzer_id,
				rank: r.rank,
				snippet: snippets[picked] ?? r.title,
				field: fields[picked]!,
			});
		}
	}

	// One merged list, best bm25 first; ties break by kind then id so the
	// ordering is deterministic across runs.
	const merged: SearchHit[] = [...messageHits, ...proposalHits].sort(
		(a, b) => a.rank - b.rank || a.kind.localeCompare(b.kind) || idOf(a).localeCompare(idOf(b)),
	);
	const omitted = merged.length > limit ? merged.length - limit : 0;

	return {
		query: q,
		hits: merged.slice(0, limit),
		message_matches: messageMatches,
		proposal_matches: proposalMatches,
		omitted_by_limit: omitted,
	};
}

function idOf(h: SearchHit): string {
	return h.kind === "message" ? h.message_id : h.proposal_id;
}

function hit(r: FtsMessageRow): Omit<MessageSearchHit, "snippet" | "field"> {
	return {
		kind: "message",
		message_id: r.message_id,
		session_id: r.session_id,
		role: r.role,
		source: r.source,
		rank: r.rank,
	};
}

/**
 * Re-throw a SQLite error from a MATCH evaluation as a user-facing message
 * with the supported syntax. Anything that is not a query-syntax problem is
 * rethrown untouched — a real database failure must stay loud and specific.
 */
function wrapFtsError(err: unknown, query: string): Error {
	if (err instanceof Error && (/fts5|syntax error|unterminated string|no such column/i.test(err.message))) {
		return new Error(
			`invalid search query "${query}": ${err.message}. ` +
				"FTS5 MATCH syntax: terms (implicit AND), \"quoted phrase\", prefix term* , OR / NOT / AND, NEAR(a b, n), column:term (messages: content_text, content_thinking; proposals: title, summary, detail, evidence).",
		);
	}
	throw err;
}
