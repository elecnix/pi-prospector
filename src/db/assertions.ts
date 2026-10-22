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

import { type AsyncDatabase } from "./async-db.js";
import { prep } from "./prepared.js";
import { shortHash } from "../analyze/input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";
import { computeSourceSetHash } from "../analyze/input-hash.js";
import { findLatestNodeBySourceSet, insertEdge, selectByKeyIn } from "./analysis-queries.js";
import { MUTE_INSTANCE_ORDINAL_SQL, muteInstanceOrdinalSql } from "./current-generation.js";
import { newGcRunId } from "./gc.js";
import { FRUSTRATION_LEXICON_DEF } from "../analyze/analyzers/frustration-lexicon/index.js";

/**
 * The analyzer that emits one hit node per (turn, signal) pair.
 *
 * Named rather than imported: `turn-frustration` reads this module's mute list,
 * so importing its definition here would close an import cycle between the two.
 */
const TURN_FRUSTRATION_ANALYZER_ID = "turn-frustration";

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
export async function upsertAssertion(
	db: AsyncDatabase,
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
): Promise<string> {
	const id = assertionId(params.subjectKind, params.subjectKey, params.verdict);
	await prep(db, `
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
 * Record a term mute, keeping the *mute episode* intact.
 *
 * A mute episode is the span during which a mute has been in force without
 * interruption. It starts when the mute is imposed and ends when it is
 * lifted. The episode's start time is the mute *instance* that the `mutes`
 * edges carry, so it must move exactly when the episode does:
 *
 *   - a mute imposed on an unmuted term starts an episode, so the instance is
 *     the time of the mute;
 *   - a mute re-imposed after an unmute starts a *new* episode, so the
 *     instance is the time of the re-mute, and the previous episode's edges
 *     stay inert;
 *   - a mute restated while it is already in force continues the episode, so
 *     the instance does not move. A restatement is not a new judgement, and
 *     moving the instance would attach a second `mutes` edge to every node
 *     the first one already marks, for no change in what is silenced.
 *
 * The reason and the author still refresh: the latest statement of *why* wins.
 */
export async function upsertMuteAssertion(
	db: AsyncDatabase,
	params: { term: string; reason?: string | null; assertedBy?: string | null },
): Promise<string> {
	const id = assertionId("term", params.term, "muted");
	const existing = (await prep(db, `
		SELECT asserted_at, superseded_at FROM assertions WHERE id = ?
	`).get(id)) as { asserted_at: string; superseded_at: string | null } | undefined;
	const inForce = existing !== undefined && existing.superseded_at === null;
	return upsertAssertion(db, {
		subjectKind: "term",
		subjectKey: params.term,
		verdict: "muted",
		reason: params.reason ?? null,
		// An episode in force keeps its start; a new one starts now.
		assertedAt: inForce ? existing.asserted_at : new Date().toISOString(),
		assertedBy: params.assertedBy ?? "operator",
	});
}

/**
 * Unmute a subject: mark every currently-active matching assertion superseded.
 * Append-only via `superseded_at` — the original mute row stays inspectable
 * with its reason and asserted_at. Returns the number of rows superseded.
 *
 * Superseding a term mute makes the mute inert again: the `mutes` edges that
 * carried it now point at a superseded assertion, so the nodes it silenced
 * count once more (the edge is never deleted, so the mark's history stays
 * inspectable). Nothing is retracted, so there is nothing to restore — the
 * mute never removed a node from the graph, it only stopped counting it.
 */
export async function supersedeAssertion(
	db: AsyncDatabase,
	params: { subjectKind: string; subjectKey: string; verdict: string; supersededAt?: string },
): Promise<number> {
	const res = await prep(db, `
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

/**
 * Retract the conclusions that were drawn *under* a mute (#325).
 *
 * A mute is `config`: it changes the fingerprint of every analyzer that
 * consults it, so a `--revise config` run recomputes those conclusions with
 * the muted term excluded. Those recomputed nodes are correct for the muted
 * setup and wrong for the unmuted one.
 *
 * Unmuting reverts the fingerprint, so the *pre-mute* node's recipe matches
 * again — but the muted-era node revises it, so the pre-mute node stays
 * superseded and the muted-era conclusion remains the current one. That is the
 * mirror image of the problem the mute created, and it has the same fix: the
 * conclusion drawn under a setup that no longer holds is retracted, so the
 * conclusion that *does* hold becomes current again.
 *
 * A node is one of those conclusions when it *read* a silenced hit — the
 * `consumes` edge says "this node was built from that node" — and was written
 * while the mute was in force. Both conditions matter:
 *
 *   - the edge says the conclusion depends on the hit, so an unrelated
 *     conclusion — a secret-leak finding, a trajectory node — is never touched,
 *     even when it was written during the mute;
 *   - the timing says the conclusion was drawn under the mute, which
 *     distinguishes it from the pre-mute conclusion that read the very same
 *     hit.
 *
 * The timing is what lets the mute-era conclusion be found when it landed in a
 * *sibling* unit rather than a revision of the pre-mute one: a silenced hit
 * leaves the readers' source set, so the unit that read it re-identifies and
 * the mute-era conclusion starts a new lineage instead of revising the
 * pre-mute one. There is no `revises` edge to walk back along, and the
 * `consumes` edge is the only link.
 *
 * Retraction is the existing reversible one: the node stays in the graph, its
 * content still verifies, and `prospect retract --undo` can bring it back.
 */
export async function retractConclusionsMadeUnder(
	db: AsyncDatabase,
	term: string,
	now: string,
): Promise<number> {
	// The mute's own lifetime: the assertion and the instance it created.
	const assertion = (await prep(db, `
		SELECT id, asserted_at, superseded_at FROM assertions
		WHERE subject_kind = 'term' AND subject_key = ? AND verdict = 'muted'
		ORDER BY asserted_at DESC LIMIT 1
	`).get(term)) as { id: string; asserted_at: string; superseded_at: string | null } | undefined;
	if (!assertion) return 0;
	const instance = await muteInstanceOrdinal(db, assertion.id);

	// The conclusions that read one of the hits *this* mute silenced, and that
	// the mute did not itself silence.
	//
	// The `consumes` edge names its target by the target's content-addressed
	// output key, so the join goes through the node. The `mutes` edge is
	// constrained to this mute's assertion and to the mute instance that created
	// it, so another term's silenced hits and a previous instance of this term's
	// mute are not candidates.
	//
	// The mark is what says which of the two is the mute-era conclusion. A
	// conclusion that read a silenced hit *before* the mute was asserted carries
	// the mark: the mute silenced it too, because it counted a term the
	// operator has since disowned. A conclusion the framework recomputed *under*
	// the mute carries no mark — it is the conclusion that holds while the mute
	// is in force, and it is the one that has to be retired when the mute is
	// lifted, because the term counts again. So the targets are the unmarked
	// readers of a silenced hit.
	//
	// That distinction is exact, and it needs no clock: the earlier version of
	// this query compared creation times against the mute's window, which
	// misfired whenever a conclusion and the mute landed in the same
	// millisecond.
	const rows = (await prep(db, `
		SELECT DISTINCT c.from_node_id AS id
		FROM analysis_edges c
		JOIN analysis_nodes hit ON hit.output_key = c.to_ref_id
		JOIN analysis_edges m ON m.from_node_id = hit.id
		                   AND m.edge_kind = ?
		                   AND m.to_ref_kind = ?
		                   AND m.to_ref_id = ?
		                   AND m.ordinal = ?
		JOIN analysis_nodes conclusion ON conclusion.id = c.from_node_id
		WHERE c.edge_kind = ? AND c.to_ref_kind = ?
		  AND conclusion.retracted_at IS NULL
		  AND NOT EXISTS (
		    SELECT 1 FROM analysis_edges s
		    WHERE s.from_node_id = conclusion.id
		      AND s.edge_kind = ?
		      AND s.to_ref_kind = ?
		      AND s.to_ref_id = ?
		      AND s.ordinal = ?
		  )
	`).all(
		EDGE_KINDS.MUTES,
		REF_KINDS.ASSERTION,
		assertion.id,
		instance,
		EDGE_KINDS.CONSUMES,
		REF_KINDS.ANALYSIS_NODE,
		EDGE_KINDS.MUTES,
		REF_KINDS.ASSERTION,
		assertion.id,
		instance,
	)) as Array<{ id: string }>;
	const targets = rows.map((r) => r.id);
	if (targets.length === 0) return 0;

	const marks = targets.map(() => "?").join(",");
	const res = await prep(db, `
		UPDATE analysis_nodes SET retracted_at = ?, retracted_by_run = ?
		WHERE retracted_at IS NULL AND id IN (${marks})
	`).run(now, newGcRunId(), ...targets);
	return res.changes;
}

/** Every currently-active assertion (superseded_at IS NULL). */
export async function getActiveAssertions(db: AsyncDatabase): Promise<AssertionRow[]> {
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE superseded_at IS NULL ORDER BY subject_kind ASC, subject_key ASC, verdict ASC`).all()) as AssertionRow[];
}

/** Currently-active assertions restricted to the given subject kinds. */
export async function getActiveAssertionsForKinds(db: AsyncDatabase, subjectKinds: readonly string[]): Promise<AssertionRow[]> {
	return selectByKeyIn<AssertionRow>(db, {
		table: "assertions",
		columns: ASSERTION_COLS,
		keyColumn: "subject_kind",
		keys: subjectKinds,
		where: "superseded_at IS NULL",
		orderBy: "subject_key ASC, verdict ASC",
	});
}

/** The currently-muted terms (subject_kind='term', verdict='muted', active). */
export async function getMutedTerms(db: AsyncDatabase): Promise<string[]> {
	const rows = (await prep(db, `
		SELECT subject_key FROM assertions
		WHERE subject_kind = 'term' AND verdict = 'muted' AND superseded_at IS NULL
	`).all()) as Array<{ subject_key: string }>;
	return rows.map((r) => r.subject_key);
}

/** True when the term is currently muted. */
export async function isTermMuted(db: AsyncDatabase, term: string): Promise<boolean> {
	const row = await prep(db, `
		SELECT 1 FROM assertions
		WHERE subject_kind = 'term' AND subject_key = ? AND verdict = 'muted' AND superseded_at IS NULL
		LIMIT 1
	`).get(term);
	return row !== undefined;
}

/** Every assertion row, most recently asserted first, optionally filtered by subject kind. */
export async function listAssertions(db: AsyncDatabase, subjectKind?: string): Promise<AssertionRow[]> {
	if (subjectKind) {
		return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? ORDER BY asserted_at DESC, subject_key ASC`).all(subjectKind)) as AssertionRow[];
	}
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions ORDER BY asserted_at DESC, subject_key ASC`).all()) as AssertionRow[];
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
export async function getProposalAssertions(db: AsyncDatabase): Promise<AssertionRow[]> {
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? ORDER BY asserted_at DESC, rowid DESC`).all(
		ASSERTION_SUBJECT_KINDS.PROPOSAL,
	)) as AssertionRow[];
}

/** A proposal's decision assertions, oldest first (one per verdict in practice). */
export async function getProposalAssertionsForKey(db: AsyncDatabase, inputKey: string): Promise<AssertionRow[]> {
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? AND subject_key = ? ORDER BY asserted_at ASC, rowid ASC`).all(
		ASSERTION_SUBJECT_KINDS.PROPOSAL,
		inputKey,
	)) as AssertionRow[];
}

/** The decisions made under one shared remediation, oldest first. */
export async function getProposalAssertionsByRemediation(db: AsyncDatabase, remediationId: string): Promise<AssertionRow[]> {
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? AND remediation_id = ? ORDER BY asserted_at ASC, rowid ASC`).all(
		ASSERTION_SUBJECT_KINDS.PROPOSAL,
		remediationId,
	)) as AssertionRow[];
}

/** The remediation assertion for a remediation id (its subject_key), if any. */
export async function getRemediationAssertion(db: AsyncDatabase, remediationId: string): Promise<AssertionRow | undefined> {
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? AND subject_key = ?`).get(
		ASSERTION_SUBJECT_KINDS.REMEDIATION,
		remediationId,
	)) as AssertionRow | undefined;
}

/** Every remediation assertion, newest first. */
export async function getAllRemediationAssertions(db: AsyncDatabase): Promise<AssertionRow[]> {
	return (await prep(db, `SELECT ${ASSERTION_COLS} FROM assertions WHERE subject_kind = ? ORDER BY asserted_at DESC, rowid DESC`).all(
		ASSERTION_SUBJECT_KINDS.REMEDIATION,
	)) as AssertionRow[];
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
export async function migrateDecisionsToAssertions(db: AsyncDatabase): Promise<{ decisions: number; remediations: number }> {
	let decisions = 0;
	// Newest first so, on a collision, the first (authoritative) row wins.
	const legacy = (await prep(db, `
		SELECT proposal_input_key, decision, disposition, rationale, actual_change, harness_ref, remediation_id, decided_at
		FROM proposal_decisions ORDER BY decided_at DESC, rowid DESC
	`).all()) as Array<{
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
		const res = await insertDecision.run(
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
	const legacyRems = (await prep(db, "SELECT id, description, actual_change, created_at FROM remediations ORDER BY created_at ASC, rowid ASC").all()) as Array<{
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
		const res = await insertRemediation.run(id, ASSERTION_SUBJECT_KINDS.REMEDIATION, r.id, REMEDIATION_VERDICT, r.description, r.created_at, r.actual_change);
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
export async function reconcileDecisionsMigration(db: AsyncDatabase): Promise<DecisionMigrationReconcile> {
	const legacy = (await prep(db, "SELECT proposal_input_key, decision FROM proposal_decisions").all()) as Array<{ proposal_input_key: string; decision: string }>;
	const assertion = (await prep(db, "SELECT subject_key, verdict FROM assertions WHERE subject_kind = ?").all(ASSERTION_SUBJECT_KINDS.PROPOSAL)) as Array<{
		subject_key: string;
		verdict: string;
	}>;

	const legacyKey = (k: string, v: string) => `${k}\u0000${v}`;
	const legacySet = new Set(legacy.map((d) => legacyKey(d.proposal_input_key, d.decision)));
	const assertSet = new Set(assertion.map((a) => legacyKey(a.subject_key, a.verdict)));
	const missingDecisions = legacy.filter((d) => !assertSet.has(legacyKey(d.proposal_input_key, d.decision))).map((d) => legacyKey(d.proposal_input_key, d.decision));
	const extraAssertions = assertion.filter((a) => !legacySet.has(legacyKey(a.subject_key, a.verdict))).map((a) => legacyKey(a.subject_key, a.verdict));

	const remLegacy = (await prep(db, "SELECT id FROM remediations").all()) as Array<{ id: string }>;
	const remAssertion = (await prep(db, "SELECT subject_key FROM assertions WHERE subject_kind = ?").all(ASSERTION_SUBJECT_KINDS.REMEDIATION)) as Array<{ subject_key: string }>;
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
 *
 * The same edge is also attached from every *live* `turn-frustration` hit node
 * the term produced (#325). Marking only the lexicon verdict left the hit nodes
 * live and unmarked: every reader kept counting them, so a muted word's hits
 * still added to a session's accumulated friction and still topped the
 * "most frequent frustration" reports. A `mutes` edge from a hit node says
 * "this conclusion is silenced by that human assertion" — exactly what the
 * edge kind means — and it is the mark every reader filters on.
 */
export async function attachMuteEdge(db: AsyncDatabase, term: string, assertionId: string): Promise<void> {
	// Locate the term's frustration-lexicon node by its content-addressed source
	// set (the term alone), the same identity turn-frustration consumes.
	const sourceSetHash = computeSourceSetHash([{ kind: "term", id: term }]);
	const node = await findLatestNodeBySourceSet(db, FRUSTRATION_LEXICON_DEF.id, sourceSetHash);
	if (node) {
		await attachMuteEdgeFrom(db, node.id, assertionId);
	}
	// …and from every live hit node the term produced. A lexicon hit's `signal`
	// is the term itself; a paralinguistic hit's `signal` is a marker name, which
	// can never be a muted lexicon term, so both are matched on the same field.
	for (const hit of await findLiveLexiconHitNodes(db, term)) {
		await attachMuteEdgeFrom(db, hit.id, assertionId);
	}
}

/** Attach one `mutes` edge, unless it is already there. Idempotent. */
async function attachMuteEdgeFrom(db: AsyncDatabase, nodeId: string, assertionId: string): Promise<void> {
	// The edge carries the mute instance that created it, in its ordinal: the
	// assertion's `asserted_at` at the moment of the mute. An assertion row is
	// one logical judgement — (kind, key, verdict) — and a re-mute reactivates
	// that same row, so without the instance a re-mute would revive the
	// previous mute's edges and silence conclusions it never marked. The
	// instance is what says "this edge belongs to the mute in force".
	const instance = await muteInstanceOrdinal(db, assertionId);
	const existing = await prep(db, `
		SELECT 1 FROM analysis_edges
		WHERE from_node_id = ? AND to_ref_id = ? AND edge_kind = ? AND ordinal = ?
		LIMIT 1
	`).get(nodeId, assertionId, EDGE_KINDS.MUTES, instance);
	if (existing) return;
	await insertEdge(db, {
		fromNodeId: nodeId,
		toRefKind: REF_KINDS.ASSERTION,
		toRefId: assertionId,
		edgeKind: EDGE_KINDS.MUTES,
		ordinal: instance,
	});
}

/**
 * The ordinal that identifies a mute instance: the assertion's `asserted_at`
 * as a millisecond epoch.
 *
 * The edge table's `ordinal` is otherwise a position within a node's edge
 * list, and the `mutes` edge has no siblings to order — it is a single
 * relation — so the field is free to carry the instance marker. The mark is
 * compared against the same expression in the `current_nodes` view, so the two
 * always agree.
 *
 * The resolution is milliseconds, not seconds: two mutes inside one second are
 * two different judgements, and a second-resolution instance would let the
 * second mute claim the first mute's edges.
 */
async function muteInstanceOrdinal(db: AsyncDatabase, assertionId: string): Promise<number> {
	const row = (await prep(db, `
		SELECT ${muteInstanceOrdinalSql("assertions")} AS instance
		FROM assertions WHERE id = ?
	`).get(assertionId)) as { instance: number | null } | undefined;
	return row?.instance ?? 0;
}

/**
 * The live `turn-frustration` hit nodes a lexicon term produced (#325).
 *
 * A hit node's identity is its (turn, signal) pair and its content carries the
 * matched `signal`; a lexicon hit's signal *is* the term. Only live nodes are
 * returned: a retracted hit is already out of every live read, so marking it
 * again would be noise.
 */
async function findLiveLexiconHitNodes(
	db: AsyncDatabase,
	term: string,
): Promise<Array<{ id: string }>> {
	return (await prep(db, `
		SELECT id FROM live_nodes
		WHERE analyzer_id = ?
		  AND json_extract(content_json, '$.signal_source') = 'lexicon'
		  AND json_extract(content_json, '$.signal') = ?
	`).all(TURN_FRUSTRATION_ANALYZER_ID, term)) as Array<{ id: string }>;
}

/**
 * The ids of the live nodes whose conclusion an *active* assertion silences
 * (#325) — that is, the nodes carrying a `mutes` edge to an assertion that has
 * not been superseded.
 *
 * An unmute supersedes the assertion (append-only via `superseded_at`), which
 * makes the edge inert again: the node is no longer muted, so it counts once
 * more. The edge is never deleted, so the mark's history stays inspectable.
 *
 * With `asOf`, the mute set is read as it stood at that instant: a mute that was
 * asserted later does not silence anything yet, and a mute that was superseded
 * later had not stopped counting yet. Reading the *current* set for a
 * historical view would rewrite the past.
 */
export async function getMutedNodeIds(db: AsyncDatabase, asOf?: string): Promise<Set<string>> {
	if (asOf) {
		const rows = (await prep(db, `
			SELECT DISTINCT e.from_node_id AS id
			FROM analysis_edges e
			JOIN assertions a ON a.id = e.to_ref_id
			WHERE e.edge_kind = ?
			  AND e.to_ref_kind = ?
			  AND a.subject_kind = 'term'
			  AND a.verdict = 'muted'
			  AND a.asserted_at <= ?
			  AND (a.superseded_at IS NULL OR a.superseded_at > ?)
			  AND e.ordinal = ${MUTE_INSTANCE_ORDINAL_SQL}
		`).all(EDGE_KINDS.MUTES, REF_KINDS.ASSERTION, asOf, asOf)) as Array<{ id: string }>;
		return new Set(rows.map((r) => r.id));
	}
	const rows = (await prep(db, `
		SELECT DISTINCT e.from_node_id AS id
		FROM analysis_edges e
		JOIN assertions a ON a.id = e.to_ref_id
		WHERE e.edge_kind = ?
		  AND e.to_ref_kind = ?
		  AND a.subject_kind = 'term'
		  AND a.verdict = 'muted'
		  AND a.superseded_at IS NULL
		  AND e.ordinal = ${MUTE_INSTANCE_ORDINAL_SQL}
	`).all(EDGE_KINDS.MUTES, REF_KINDS.ASSERTION)) as Array<{ id: string }>;
	return new Set(rows.map((r) => r.id));
}

/**
 * The pure half of {@link getMutedNodeIds}: drop the nodes an active mute
 * silences, keeping the rest in their original order.
 *
 * Readers share this so "does this count a muted hit?" is answered the same
 * way everywhere — a muted term's hits must not reach friction scores, digests,
 * or reports, and each reader deciding for itself is how they drift apart.
 */
export function withoutMutedNodes<T extends { id: string }>(nodes: readonly T[], mutedIds: ReadonlySet<string>): T[] {
	return nodes.filter((n) => !mutedIds.has(n.id));
}

/**
 * Silence the conclusions a muted term's hits produced (#325).
 *
 * A reader that folds a hit into a conclusion draws that conclusion *from* the
 * hit: the `consumes` edge says so. When the hit is silenced, the conclusion
 * it produced is a conclusion about a term the operator said does not count, so
 * it must leave the current generation too — otherwise the reader's old
 * conclusion stays current and keeps counting the silenced hit.
 *
 * The conclusion is marked with the same `mutes` edge, so one predicate covers
 * both the hit and what was drawn from it, and the mark is reversible: an
 * unmute supersedes the assertion, which makes the edge inert again.
 *
 * Only *current* conclusions are marked. A superseded generation is already out
 * of every aggregate read, and marking it would add a mark nothing reads.
 */
export async function silenceConclusionsOfSilencedHits(
	db: AsyncDatabase,
	assertionId: string,
): Promise<number> {
	// The conclusions that consumed a silenced hit. A `consumes` edge names its
	// target by the target's content-addressed output key, while the `mutes`
	// edge starts at the hit's row id — so the join goes through the node.
	//
	// The `mutes` edge is constrained to the mute instance in force, the same
	// way the retraction query constrains it. A hit silenced by an earlier
	// instance of this mute is not silenced by the one in force, so it is not a
	// candidate, and neither are the conclusions that read it.
	const instance = await muteInstanceOrdinal(db, assertionId);
	const consumers = (await prep(db, `
		SELECT DISTINCT c.from_node_id AS id
		FROM analysis_edges c
		JOIN analysis_nodes hit ON hit.output_key = c.to_ref_id
		JOIN analysis_edges m ON m.from_node_id = hit.id
		                   AND m.edge_kind = ?
		                   AND m.to_ref_kind = ?
		                   AND m.to_ref_id = ?
		                   AND m.ordinal = ?
		WHERE c.edge_kind = ? AND c.to_ref_kind = ?
	`).all(
		EDGE_KINDS.MUTES,
		REF_KINDS.ASSERTION,
		assertionId,
		instance,
		EDGE_KINDS.CONSUMES,
		REF_KINDS.ANALYSIS_NODE,
	)) as Array<{ id: string }>;
	if (consumers.length === 0) return 0;

	let marked = 0;
	for (const consumer of consumers) {
		const already = await prep(db, `
			SELECT 1 FROM analysis_edges
			WHERE from_node_id = ? AND to_ref_id = ? AND edge_kind = ? AND ordinal = ?
			LIMIT 1
		`).get(consumer.id, assertionId, EDGE_KINDS.MUTES, instance);
		if (already) continue;
		await insertEdge(db, {
			fromNodeId: consumer.id,
			toRefKind: REF_KINDS.ASSERTION,
			toRefId: assertionId,
			edgeKind: EDGE_KINDS.MUTES,
			ordinal: instance,
		});
		marked++;
	}
	return marked;
}
