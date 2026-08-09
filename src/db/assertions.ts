/**
 * Data access for the generic assertions relation.
 *
 * Assertions are external human input (same category as proposal decisions and
 * conversation messages), NOT derived analysis. Each row is a *judgement* about
 * a content-addressed subject (`subject_kind` + `subject_key`): a mute is
 * `subject_kind='term'`, `verdict='muted'`. The next kind of operator feedback
 * is a new `verdict` value, never new schema.
 *
 * Identity is content-addressed: an assertion's `id` is
 * `H(subject_kind | subject_key | verdict)`, so an edge referencing it (the
 * `mutes` edge) is reproducible across a wipe/recompute — exactly as decisions
 * key on the proposal's input_key. One logical assertion per
 * (subject_kind, subject_key, verdict); its lifecycle is active until
 * `superseded_at` is set (unmute). Nothing is ever deleted.
 *
 * All SQL for assertions lives here.
 */

import type Database from "better-sqlite3";
import { prep } from "./prepared.js";
import { shortHash } from "../analyze/input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";
import { computeSourceSetHash } from "../analyze/input-hash.js";
import { findLatestNodeBySourceSet, insertEdge } from "./analysis-queries.js";
import { FRUSTRATION_LEXICON_DEF } from "../analyze/analyzers/frustration-lexicon/index.js";

/** The subject kinds an assertion can be about. Extensible; `term` is the first. */
export type AssertionSubjectKind = "term";

export interface AssertionRow {
	id: string;
	subject_kind: string;
	subject_key: string;
	verdict: string;
	reason: string | null;
	asserted_at: string;
	asserted_by: string | null;
	superseded_at: string | null;
}

/** Content-addressed identity of one assertion: H(subject_kind | subject_key | verdict). */
export function assertionId(subjectKind: string, subjectKey: string, verdict: string): string {
	return shortHash(`assertion(${subjectKind}|${subjectKey}|${verdict})`);
}

/**
 * Record a judgement, persist-side idempotent: muting a term that is already
 * currently muted refreshes the lifecycle (reason/time/by) and stays one row.
 * Re-muting after an unmute reactivates the same content-addressed row, so edges
 * to it stay valid. Returns the assertion id.
 */
export function upsertAssertion(
	db: Database.Database,
	params: {
		subjectKind: string;
		subjectKey: string;
		verdict: string;
		reason?: string | null;
		assertedBy?: string | null;
		assertedAt?: string;
	},
): string {
	const id = assertionId(params.subjectKind, params.subjectKey, params.verdict);
	prep(db, `
		INSERT INTO assertions (id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
		ON CONFLICT(id) DO UPDATE SET
			reason = excluded.reason,
			asserted_at = excluded.asserted_at,
			asserted_by = excluded.asserted_by,
			superseded_at = NULL
	`).run(
		id,
		params.subjectKind,
		params.subjectKey,
		params.verdict,
		params.reason ?? null,
		params.assertedAt ?? new Date().toISOString(),
		params.assertedBy ?? null,
	);
	return id;
}

/**
 * Unmute a subject: mark every currently-active matching assertion superseded.
 * Append-only via `superseded_at` — the original mute row stays inspectable
 * with its reason and asserted_at. Returns the number of rows superseded.
 */
export function supersedeAssertion(
	db: Database.Database,
	params: { subjectKind: string; subjectKey: string; verdict: string; supersededAt?: string },
): number {
	const res = prep(db, `
		UPDATE assertions SET superseded_at = ?
		WHERE subject_kind = ? AND subject_key = ? AND verdict = ? AND superseded_at IS NULL
	`).run(
		params.supersededAt ?? new Date().toISOString(),
		params.subjectKind,
		params.subjectKey,
		params.verdict,
	);
	return res.changes;
}

/** Every currently-active assertion (superseded_at IS NULL). */
export function getActiveAssertions(db: Database.Database): AssertionRow[] {
	return prep(db, `
		SELECT id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at
		FROM assertions WHERE superseded_at IS NULL
		ORDER BY subject_kind ASC, subject_key ASC, verdict ASC
	`).all() as AssertionRow[];
}

/** Currently-active assertions restricted to the given subject kinds. */
export function getActiveAssertionsForKinds(db: Database.Database, subjectKinds: readonly string[]): AssertionRow[] {
	if (subjectKinds.length === 0) return [];
	const placeholders = subjectKinds.map(() => "?").join(", ");
	return prep(
		db,
		`SELECT id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at
		 FROM assertions WHERE superseded_at IS NULL AND subject_kind IN (${placeholders})
		 ORDER BY subject_key ASC, verdict ASC`,
	).all(...subjectKinds) as AssertionRow[];
}

/** The currently-muted terms (subject_kind='term', verdict='muted', active). */
export function getMutedTerms(db: Database.Database): string[] {
	const rows = prep(db, `
		SELECT subject_key FROM assertions
		WHERE subject_kind = 'term' AND verdict = 'muted' AND superseded_at IS NULL
	`).all() as Array<{ subject_key: string }>;
	return rows.map((r) => r.subject_key);
}

/** True when the term is currently muted. */
export function isTermMuted(db: Database.Database, term: string): boolean {
	const row = prep(db, `
		SELECT 1 FROM assertions
		WHERE subject_kind = 'term' AND subject_key = ? AND verdict = 'muted' AND superseded_at IS NULL
		LIMIT 1
	`).get(term);
	return row !== undefined;
}

/** Every assertion row, most recently asserted first, optionally filtered by subject kind. */
export function listAssertions(db: Database.Database, subjectKind?: string): AssertionRow[] {
	if (subjectKind) {
		return prep(db, `
			SELECT id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at
			FROM assertions WHERE subject_kind = ?
			ORDER BY asserted_at DESC, subject_key ASC
		`).all(subjectKind) as AssertionRow[];
	}
	return prep(db, `
		SELECT id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at
		FROM assertions ORDER BY asserted_at DESC, subject_key ASC
	`).all() as AssertionRow[];
}

/**
 * A hash of the active assertion set (subject kind + key + verdict), order-
 * independent. Folded into an analyzer's config fingerprint, so muting marks
 * the nodes of any analyzer that consults those assertions stale for the
 * `config` reason — a plain fill leaves them alone, `--revise config` cleanly
 * recomputes them, and old nodes stay preserved as lineage.
 */
export function computeAssertionFingerprint(rows: readonly AssertionRow[]): string {
	const active = rows.filter((r) => r.superseded_at === null);
	const canonical = active
		.map((r) => `${r.subject_kind}|${r.subject_key}|${r.verdict}`)
		.sort()
		.join("\n");
	return shortHash(`assertions(${canonical})`);
}

/**
 * Attach the `mutes` edge from a subject's governing analysis node to the
 * assertion that mutes it, making human input edge-reachable and traversable
 * with everything else.
 *
 * Today the origin is the frustration-lexicon node for the muted term — walking
 * from the verdict node you can see "this conclusion is muted by assertion X".
 * The edge is created at mute time against the currently-mapped lexicon node;
 * the assertion target is content-addressed, so after a wipe/recompute the
 * edge is re-established the next time the same term is muted. Idempotent: a
 * re-mute never duplicates the edge.
 */
export function attachMuteEdge(db: Database.Database, term: string, assertionId: string): void {
	// Locate the term's frustration-lexicon node by its content-addressed source
	// set (the term alone), the same identity turn-frustration consumes.
	const sourceSetHash = computeSourceSetHash([{ kind: "term", id: term }]);
	const node = findLatestNodeBySourceSet(db, FRUSTRATION_LEXICON_DEF.id, sourceSetHash);
	if (!node) return;
	const existing = prep(db, `
		SELECT 1 FROM analysis_edges
		WHERE from_node_id = ? AND to_ref_id = ? AND edge_kind = ? LIMIT 1
	`).get(node.id, assertionId, EDGE_KINDS.MUTES);
	if (existing) return;
	insertEdge(db, {
		fromNodeId: node.id,
		toRefKind: REF_KINDS.ASSERTION,
		toRefId: assertionId,
		edgeKind: EDGE_KINDS.MUTES,
		ordinal: 0,
	});
}
