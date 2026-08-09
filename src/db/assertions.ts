/**
 * Data access for the generic assertions relation.
 *
 * Assertions are external human input (same category as proposal decisions and
 * conversation messages), NOT derived analysis. Each row is a *judgement* about
 * a content-addressed subject (`subject_kind` + `subject_key`): a mute is
 * `subject_kind='term'`, `verdict='muted'`; a proposal decision is
 * `subject_kind='proposal'`, `subject_key=<input_key>`,
 * `verdict=accepted|rejected|accepted_modified`; a shared remediation is
 * `subject_kind='remediation'`. The next kind of operator feedback is a new
 * `verdict` value, never new schema.
 *
 * Identity is content-addressed: an assertion's `id` is
 * `H(subject_kind | subject_key | verdict)`, so an edge referencing it (the
 * `mutes` edge) is reproducible across a wipe/recompute — exactly as decisions
 * key on the proposal's input_key. One logical assertion per
 * (subject_kind, subject_key, verdict); its lifecycle is active until
 * `superseded_at` is set (unmute). Nothing is ever deleted.
 *
 * Issue #73 folds proposal_decisions and remediations onto this same relation
 * with identical semantics: decisions are written as `proposal` assertions, a
 * remediation as a `remediation` assertion, and decisions group under a shared
 * remediation via `remediation_id` (= the remediation's `subject_key`). The old
 * tables are kept, still written, as the reversible rollback until a separate
 * change drops them.
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

/** The subject kinds an assertion can be about. Extensible. */
export const ASSERTION_SUBJECT_KINDS = {
	TERM: "term",
	PROPOSAL: "proposal",
	REMEDIATION: "remediation",
} as const;
export type AssertionSubjectKind = (typeof ASSERTION_SUBJECT_KINDS)[keyof typeof ASSERTION_SUBJECT_KINDS];

/** The verdict a remediation record is stored under. */
export const REMEDIATION_VERDICT = "remediation";

export interface AssertionRow {
	id: string;
	subject_kind: string;
	subject_key: string;
	verdict: string;
	reason: string | null;
	asserted_at: string;
	asserted_by: string | null;
	superseded_at: string | null;
	/** Decision qualifiers (proposal assertions only). Null elsewhere. */
	disposition: string | null;
	actual_change: string | null;
	harness_ref: string | null;
	remediation_id: string | null;
}

/** The explicit SELECT column list for an assertion row. */
const ASSERTION_COLS =
	"id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at, " +
	"disposition, actual_change, harness_ref, remediation_id";

/** Content-addressed identity of one assertion: H(subject_kind | subject_key | verdict). */
export function assertionId(subjectKind: string, subjectKey: string, verdict: string): string {
	return shortHash(`assertion(${subjectKind}|${subjectKey}|${verdict})`);
}

/**
 * Record a judgement, persist-side idempotent: an existing assertion for the
 * same (kind, key, verdict) is refreshed (the latest lifecycle wins: reason,
 * time, by, qualifiers) and stays one row. Muting an already-muted term, or a
 * proposal that already carries that verdict, never duplicates. Returns the
 * assertion id.
 */
export function upsertAssertion(
	db: Database.Database,
	params: {
		subjectKind: string;
		subjectKey: string;
		verdict: string;
		reason?: string | null;
		assertedAt?: string;
		assertedBy?: string | null;
		disposition?: string | null;
		actualChange?: string | null;
		harnessRef?: string | null;
		remediationId?: string | null;
	},
): string {
	const id = assertionId(params.subjectKind, params.subjectKey, params.verdict);
	prep(db, `
		INSERT INTO assertions (id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at, disposition, actual_change, harness_ref, remediation_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			reason = excluded.reason,
			asserted_at = excluded.asserted_at,
			asserted_by = excluded.asserted_by,
			superseded_at = NULL,
			disposition = excluded.disposition,
			actual_change = excluded.actual_change,
			harness_ref = excluded.harness_ref,
			remediation_id = excluded.remediation_id
	`).run(
		id,
		params.subjectKind,
		params.subjectKey,
		params.verdict,
		params.reason ?? null,
		params.assertedAt ?? new Date().toISOString(),
		params.assertedBy ?? null,
		params.disposition ?? null,
		params.actualChange ?? null,
		params.harnessRef ?? null,
		params.remediationId ?? null,
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
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE superseded_at IS NULL ORDER BY subject_kind ASC, subject_key ASC, verdict ASC`).all() as AssertionRow[];
}

/** Currently-active assertions restricted to the given subject kinds. */
export function getActiveAssertionsForKinds(db: Database.Database, subjectKinds: readonly string[]): AssertionRow[] {
	if (subjectKinds.length === 0) return [];
	const placeholders = subjectKinds.map(() => "?").join(", ");
	return prep(
		db,
		`SELECT ${ASSERTION_COLS} FROM assertions WHERE superseded_at IS NULL AND subject_kind IN (${placeholders}) ORDER BY subject_key ASC, verdict ASC`,
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
		return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? ORDER BY asserted_at DESC, subject_key ASC`).all(subjectKind) as AssertionRow[];
	}
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions ORDER BY asserted_at DESC, subject_key ASC`).all() as AssertionRow[];
}

// ───────────────────────────── decision assertions ─────────────────────────────

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

/** Every decision assertion (subject_kind='proposal'), newest asserted first. */
export function getProposalAssertions(db: Database.Database): AssertionRow[] {
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? ORDER BY asserted_at DESC, rowid DESC`).all(
		ASSERTION_SUBJECT_KINDS.PROPOSAL,
	) as AssertionRow[];
}

/** A proposal's decision assertions, oldest first (one per verdict in practice). */
export function getProposalAssertionsForKey(db: Database.Database, inputKey: string): AssertionRow[] {
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? AND subject_key = ? ORDER BY asserted_at ASC, rowid ASC`).all(
		ASSERTION_SUBJECT_KINDS.PROPOSAL,
		inputKey,
	) as AssertionRow[];
}

/** The decisions made under one shared remediation, oldest first. */
export function getProposalAssertionsByRemediation(db: Database.Database, remediationId: string): AssertionRow[] {
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? AND remediation_id = ? ORDER BY asserted_at ASC, rowid ASC`).all(
		ASSERTION_SUBJECT_KINDS.PROPOSAL,
		remediationId,
	) as AssertionRow[];
}

/** The remediation assertion for a remediation id (its subject_key), if any. */
export function getRemediationAssertion(db: Database.Database, remediationId: string): AssertionRow | undefined {
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? AND subject_key = ?`).get(
		ASSERTION_SUBJECT_KINDS.REMEDIATION,
		remediationId,
	) as AssertionRow | undefined;
}

/** Every remediation assertion, newest first. */
export function getAllRemediationAssertions(db: Database.Database): AssertionRow[] {
	return prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? ORDER BY asserted_at DESC, rowid DESC`).all(
		ASSERTION_SUBJECT_KINDS.REMEDIATION,
	) as AssertionRow[];
}

// ──────────────────────── migration from the legacy tables ────────────────────────

/**
 * Fold existing proposal_decisions and remediations onto the assertions
 * relation (issue #73). Additive and idempotent: each legacy decision/remediation
 * becomes one assertion, keyed by content so it re-attaches to a regenerated
 * proposal after a wipe. The legacy tables are left untouched — they remain the
 * reversible rollback until a separate change drops them. If the legacy corpus
 * ever holds two decisions for the same (input_key, verdict), the latest by
 * decided_at wins (the decision corpus is "latest by decided_at", matching the
 * legacy read path).
 */
export function migrateDecisionsToAssertions(db: Database.Database): { decisions: number; remediations: number } {
	let decisions = 0;
	// Newest first so, on a collision, the first (authoritative) row wins.
	const legacy = prep(db, `
		SELECT proposal_input_key, decision, disposition, rationale, actual_change, harness_ref, remediation_id, decided_at
		FROM proposal_decisions ORDER BY decided_at DESC, rowid DESC
	`).all() as Array<{
		proposal_input_key: string;
		decision: string;
		disposition: string | null;
		rationale: string | null;
		actual_change: string | null;
		harness_ref: string | null;
		remediation_id: string | null;
		decided_at: string;
	}>;
	const insertDecision = prep(db, `
		INSERT OR IGNORE INTO assertions (id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at, disposition, actual_change, harness_ref, remediation_id)
		VALUES (?, ?, ?, ?, ?, ?, 'operator', NULL, ?, ?, ?, ?)
	`);
	for (const d of legacy) {
		const id = assertionId(ASSERTION_SUBJECT_KINDS.PROPOSAL, d.proposal_input_key, d.decision);
		const res = insertDecision.run(
			id,
			ASSERTION_SUBJECT_KINDS.PROPOSAL,
			d.proposal_input_key,
			d.decision,
			d.rationale,
			d.decided_at,
			d.disposition,
			d.actual_change,
			d.harness_ref,
			d.remediation_id,
		);
		if (res.changes > 0) decisions++;
	}

	let remediations = 0;
	const legacyRems = prep(db, "SELECT id, description, actual_change, created_at FROM remediations ORDER BY created_at ASC, rowid ASC").all() as Array<{
		id: string;
		description: string;
		actual_change: string | null;
		created_at: string;
	}>;
	const insertRemediation = prep(db, `
		INSERT OR IGNORE INTO assertions (id, subject_kind, subject_key, verdict, reason, asserted_at, asserted_by, superseded_at, disposition, actual_change, harness_ref, remediation_id)
		VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)
	`);
	for (const r of legacyRems) {
		const id = assertionId(ASSERTION_SUBJECT_KINDS.REMEDIATION, r.id, REMEDIATION_VERDICT);
		const res = insertRemediation.run(id, ASSERTION_SUBJECT_KINDS.REMEDIATION, r.id, REMEDIATION_VERDICT, r.description, r.created_at, r.actual_change);
		if (res.changes > 0) remediations++;
	}

	return { decisions, remediations };
}

export interface DecisionMigrationReconcile {
	legacyDecisions: number;
	assertionDecisions: number;
	legacyRemediations: number;
	assertionRemediations: number;
	/** Legacy decisions with no matching assertion (input_key + verdict). */
	missingDecisions: string[];
	/** Assertion decisions with no matching legacy row (input_key + verdict). */
	extraAssertions: string[];
	/** Legacy remediations with no matching assertion. */
	missingRemediations: string[];
}

/**
 * Verify the decisions/remediations migration by content, not "it ran":
 * every legacy decision must have an assertion with the identical verdict and
 * content key, and vice versa; same for remediations. Returns counts and the
 * exact keys that fail to round-trip. Used by tests and `prospect verify` to
 * prove parity before the legacy tables are ever dropped.
 */
export function reconcileDecisionsMigration(db: Database.Database): DecisionMigrationReconcile {
	const legacy = prep(db, "SELECT proposal_input_key, decision FROM proposal_decisions").all() as Array<{ proposal_input_key: string; decision: string }>;
	const assertion = prep(db, "SELECT subject_key, verdict FROM assertions WHERE subject_kind = ?").all(ASSERTION_SUBJECT_KINDS.PROPOSAL) as Array<{
		subject_key: string;
		verdict: string;
	}>;

	const legacyKey = (k: string, v: string) => `${k}\u0000${v}`;
	const legacySet = new Set(legacy.map((d) => legacyKey(d.proposal_input_key, d.decision)));
	const assertSet = new Set(assertion.map((a) => legacyKey(a.subject_key, a.verdict)));
	const missingDecisions = legacy.filter((d) => !assertSet.has(legacyKey(d.proposal_input_key, d.decision))).map((d) => legacyKey(d.proposal_input_key, d.decision));
	const extraAssertions = assertion.filter((a) => !legacySet.has(legacyKey(a.subject_key, a.verdict))).map((a) => legacyKey(a.subject_key, a.verdict));

	const remLegacy = prep(db, "SELECT id FROM remediations").all() as Array<{ id: string }>;
	const remAssertion = prep(db, "SELECT subject_key FROM assertions WHERE subject_kind = ?").all(ASSERTION_SUBJECT_KINDS.REMEDIATION) as Array<{ subject_key: string }>;
	const remLegacySet = new Set(remLegacy.map((r) => r.id));
	const remAssertSet = new Set(remAssertion.map((r) => r.subject_key));
	const missingRemediations = remLegacy.filter((r) => !remAssertSet.has(r.id)).map((r) => r.id);

	return {
		legacyDecisions: legacy.length,
		assertionDecisions: assertion.length,
		legacyRemediations: remLegacy.length,
		assertionRemediations: remAssertion.length,
		missingDecisions,
		extraAssertions,
		missingRemediations,
	};
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