/**
 * Prior-occurrence recall: raw evidence from earlier sessions (RAW-RAG).
 *
 * A friction turn is far more actionable when the synthesiser can see that the
 * same correction was already made in an earlier session. Cross-session
 * contrast (cross-session.ts) hands it a distilled digest of smooth siblings —
 * a request snippet and a verdict. This module hands it the opposite: the raw
 * text of the earlier turns that resemble this session's friction turns,
 * unsummarised.
 *
 * Why raw, and why no memory layer
 * ────────────────────────────────
 * Bao et al., "Is Complex Agentic Memory Always Needed? Naive RAG Is Stronger
 * Than We Thought" (arXiv:2610.30755), compare a naive baseline — fixed-size
 * overlapping windows of raw history, a first-stage retrieval, a rerank, and the
 * survivors handed to the reader in chronological order — against extraction,
 * summary and graph memories. The baseline ranks first in six of seven settings,
 * and each memory-management addition they bolt onto it lowers accuracy. Their
 * diagnosis is that information discarded or distorted at ingestion cannot be
 * recovered by retrieval, and that useful evidence includes the order and
 * dependencies around a value, not only the value. So: no extraction, no
 * summary, no new table. The index is `messages_fts`, which already exists.
 *
 * Differences from the paper, stated rather than hidden
 * ─────────────────────────────────────────────────────
 * - First stage is FTS5 bm25, not dense embeddings; second stage is a
 *   deterministic distinct-query-term overlap, not a cross-encoder. Both are
 *   local, need no model call and no new dependency, and are reproducible —
 *   which a content-addressed node requires. They are weaker than the paper's
 *   retrievers; this module makes no claim about their accuracy.
 * - Windows are in characters (1024 ≈ 256 tokens, 128 ≈ 32 tokens), and a
 *   message is windowed at read time, so no window is ever stored.
 *
 * Content-addressing
 * ──────────────────
 * Each recalled window enters the unit's source set as a `message`-kind ref whose
 * id is the message id plus a hash of the exact window text, so the node's
 * identity commits to what the synthesiser was shown. Only messages that began
 * before the target session did are eligible: a session synced later must not
 * re-identify the overviews of sessions that preceded it. Derived from raw
 * messages, never from analysis nodes, so it is order-independent and acyclic.
 */

import { Type, type Static } from "typebox";
import { type AsyncDatabase } from "../../../db/async-db.js";
import { SourceRef } from "../../types.js";
import { shortHash } from "../../input-hash.js";
import type { RecallConfig } from "./config.js";

export const RecalledWindow = Type.Object({
	messageId: Type.String(),
	sessionId: Type.String(),
	role: Type.String(),
	timestamp: Type.String(),
	/** The exact raw text of the window. */
	text: Type.String(),
	/** Hash of `text`; embedded in the source ref so identity commits to the content. */
	contentHash: Type.String(),
	/** Share of the query's distinct terms the window contains (the rerank score). */
	overlap: Type.Number(),
});
export type RecalledWindow = Static<typeof RecalledWindow>;

export const PriorOccurrences = Type.Object({
	windows: Type.Array(RecalledWindow),
	sourceRefs: Type.Array(SourceRef),
	/** Why nothing was recalled when recall was on but could not run; null otherwise. */
	unavailable: Type.Union([Type.String(), Type.Null()]),
});
export type PriorOccurrences = Static<typeof PriorOccurrences>;

const NONE: PriorOccurrences = { windows: [], sourceRefs: [], unavailable: null };

/** A friction turn the recall is asked about. */
export const RecallQuery = Type.Object({ messageId: Type.String(), text: Type.String() });
export type RecallQuery = Static<typeof RecallQuery>;

/** Most distinct terms one FTS query carries; keeps the MATCH expression bounded. */
const MAX_QUERY_TERMS = 12;

/** Lowercased word tokens of four or more characters — enough to retrieve on, not to judge with. */
export function queryTerms(text: string): string[] {
	const seen = new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? []);
	// Longest first: long tokens are the rarer, more discriminating ones. Alphabetical
	// breaks ties so the expression, and therefore the identity, is reproducible.
	return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, MAX_QUERY_TERMS);
}

/** An FTS5 expression matching any of `terms` in the message text; null when there are none. */
export function matchExpression(terms: readonly string[]): string | null {
	if (terms.length === 0) return null;
	return `content_text : (${terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")})`;
}

/** Fixed-size overlapping windows of `text`. Text that fits in one window is one window. */
export function windowText(text: string, windowChars: number, overlapChars: number): string[] {
	if (windowChars <= 0) throw new Error(`recallWindowChars must be positive, got ${windowChars}`);
	if (overlapChars < 0 || overlapChars >= windowChars) {
		throw new Error(`recallOverlapChars must be in [0, recallWindowChars), got ${overlapChars} against ${windowChars}`);
	}
	if (text.length <= windowChars) return text.trim().length > 0 ? [text] : [];
	const step = windowChars - overlapChars;
	const windows: string[] = [];
	for (let start = 0; start < text.length; start += step) {
		windows.push(text.slice(start, start + windowChars));
		if (start + windowChars >= text.length) break;
	}
	return windows;
}

/** Share of `terms` that occur in `window` (case-insensitive). */
export function overlapScore(window: string, terms: readonly string[]): number {
	if (terms.length === 0) return 0;
	const hay = window.toLowerCase();
	let hit = 0;
	for (const t of terms) if (hay.includes(t)) hit++;
	return hit / terms.length;
}

interface CandidateRow {
	id: string;
	session_id: string;
	role: string;
	timestamp: string;
	content_text: string;
	rank: number;
}

/** When the session began: its earliest timestamped message, or null if none carries one. */
async function sessionStart(db: AsyncDatabase, sessionId: string): Promise<string | null> {
	const row = (await db
		.prepare("SELECT MIN(timestamp) AS t FROM messages WHERE session_id = ? AND timestamp IS NOT NULL")
		.get(sessionId)) as { t: string | null } | undefined;
	return row?.t ?? null;
}

/**
 * Raw windows from earlier sessions that resemble the given friction turns.
 *
 * For each query: bm25 over `messages_fts` takes the top `recallCandidates`
 * messages from OTHER sessions that began before this one; each candidate's best
 * window (most query terms) is scored by term overlap. The best `recallTopK`
 * windows across all queries are returned in chronological order.
 */
export async function selectPriorOccurrences(
	db: AsyncDatabase,
	sessionId: string,
	queries: readonly RecallQuery[],
	config: RecallConfig,
): Promise<PriorOccurrences> {
	if (!config.recallPriorOccurrences || queries.length === 0) return NONE;
	const start = await sessionStart(db, sessionId);
	if (start === null) {
		// Without a start there is no "earlier": recalling anyway would let a later
		// sync change this session's identity. Say so instead of returning a quiet empty.
		return { ...NONE, unavailable: "session has no timestamped messages, so 'earlier sessions' is undefined" };
	}

	const stmt = db.prepare(
		"SELECT m.id, m.session_id, m.role, m.timestamp, m.content_text, bm25(messages_fts) AS rank " +
			"FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid " +
			"WHERE messages_fts MATCH ? AND m.session_id <> ? AND m.role IN ('user', 'assistant') " +
			"AND m.timestamp IS NOT NULL AND m.timestamp < ? AND m.content_text IS NOT NULL " +
			"ORDER BY rank ASC, m.id ASC LIMIT ?",
	);

	const best = new Map<string, RecalledWindow & { rank: number }>();
	for (const q of queries.slice(0, Math.max(0, config.recallMaxQueries))) {
		const terms = queryTerms(q.text);
		const expr = matchExpression(terms);
		if (expr === null) continue;
		const rows = (await stmt.all(expr, sessionId, start, config.recallCandidates)) as CandidateRow[];
		for (const row of rows) {
			let top: { text: string; overlap: number } | null = null;
			for (const w of windowText(row.content_text, config.recallWindowChars, config.recallOverlapChars)) {
				const overlap = overlapScore(w, terms);
				if (top === null || overlap > top.overlap) top = { text: w, overlap };
			}
			if (top === null || top.overlap === 0) continue;
			const key = `${row.id}:${shortHash(top.text)}`;
			const prior = best.get(key);
			if (prior && prior.overlap >= top.overlap) continue;
			best.set(key, {
				messageId: row.id,
				sessionId: row.session_id,
				role: row.role,
				timestamp: row.timestamp,
				text: top.text,
				contentHash: shortHash(top.text),
				overlap: top.overlap,
				rank: row.rank,
			});
		}
	}

	const chosen = [...best.values()]
		.sort((a, b) => b.overlap - a.overlap || a.rank - b.rank || a.messageId.localeCompare(b.messageId))
		.slice(0, Math.max(0, config.recallTopK))
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.messageId.localeCompare(b.messageId));

	const windows: RecalledWindow[] = chosen.map(({ rank: _rank, ...w }) => w);
	const sourceRefs = windows.map((w) => ({ kind: "message" as const, id: `${w.messageId}:${w.contentHash}` }));
	return { windows, sourceRefs, unavailable: null };
}

/** The block appended to the reduce prompt, or "" when nothing was recalled. */
export function formatRecallContext(windows: readonly RecalledWindow[]): string {
	if (windows.length === 0) return "";
	const lines = [
		"Raw text from EARLIER sessions that resembles this session's friction turns, oldest first.",
		"If an earlier turn shows the same correction or failure, this is a recurrence: say so, cite the session,",
		"and prefer a standing-instruction proposal over a one-off remark. Do not claim recurrence the text does not show.",
		"",
	];
	for (const w of windows) {
		lines.push(`--- session ${w.sessionId.slice(0, 8)} · ${w.timestamp} · ${w.role} ---`, w.text.trim());
	}
	return lines.join("\n");
}
