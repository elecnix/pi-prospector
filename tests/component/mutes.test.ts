/**
 * Muting a lexicon term via the generic assertions relation (issue #72).
 *
 * The invariants under test:
 *
 * 1. A muted term stops matching turns, but its previous hit nodes remain and
 *    stay reachable as lineage (never deleted, never moved).
 * 2. Mutating folds a hash of the ACTIVE mute set into turn-frustration's config
 *    fingerprint, so muting marks affected nodes stale/config. A plain fill does
 *    not silently recompute them; `--revise config` cleanly recomputes them
 *    (recreating unmuted terms as new versions, leaving muted terms' hits as
 *    preserved lineage).
 * 3. `prospect verify` stays clean — no node is deleted or modified.
 * 4. Mutes key on the term, so they survive a wipe-and-recompute.
 * 5. Unmuting is append-only via `superseded_at`.
 * 6. A `mutes` edge joins the human mute to the graph (ref kind `assertion`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import {
	turnFrustrationAnalyzer,
	TURN_FRUSTRATION_DEF,
	type TurnFrustrationProperties,
} from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer, getEdgesFrom, listAnalysisNodes, countAnalysisNodes, getAnalysisStats } from "../../src/db/analysis-queries.js";
import {
	muteTerm,
	unmuteTerm,
} from "../../src/commands/mutes.js";
import { getActiveAssertions, getMutedTerms, getMutedNodeIds, isTermMuted, listAssertions, supersedeAssertion } from "../../src/db/assertions.js";
import { verifyNodes } from "../../src/commands/verify.js";
import { frictionAccumulationAnalyzer } from "../../src/analyze/analyzers/friction-accumulation/index.js";
import { toolTrajectoryAnalyzer } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const FRUSTRATED_TERMS = new Set(["putain", "wrong", "pénible"]);

async function build(db: AsyncDatabase) {
	const llm = createMockLLM({
		responder: (req: LLMRequest) => {
			const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const frustrated = FRUSTRATED_TERMS.has(term);
			return {
				text: "x",
				structured: {
					polarity: frustrated ? "frustration" : "neutral",
					category: frustrated ? "dissatisfaction" : "none",
					language: frustrated ? "fr" : "und",
					confidence: 0.9,
					rationale: "r",
				},
			};
		},
	});
	const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	await framework.register(turnFrustrationAnalyzer);
	return { framework, llm };
}

/** The same chain plus the readers that fold frustration hits into a session score. */
async function buildWithReaders(db: AsyncDatabase) {
	const { framework, llm } = await build(db);
	await framework.register(toolTrajectoryAnalyzer);
	await framework.register(frictionAccumulationAnalyzer);
	return { framework, llm };
}

async function tfProps(db: AsyncDatabase, sessionId: string): Promise<TurnFrustrationProperties[]> {
	return (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, sessionId)).map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties);
}

describe("muting a lexicon term", () => {
	it("stops a muted term matching new turns while previous hits remain", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "that is wrong" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");
			assert.deepEqual((await tfProps(db, "s1")).map((h) => h.signal), ["wrong"]);
			const hitNodeId = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))[0]!.id;

			// The operator mutes 'wrong'.
			await muteTerm(db, { term: "wrong", reason: "ordinary grammar for this corpus", by: "operator" });
			assert.equal(await isTermMuted(db, "wrong"), true);

			// A later session that also says "wrong" must now match nothing for it.
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "wrong again" }, { role: "assistant", text: "ok" }]);
			await framework.run("s2");
			assert.deepEqual(await tfProps(db, "s2"), [], "the muted term produces no hit in a new turn");

			// The earlier hit node is untouched and still reachable.
			assert.equal((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).length, 1);
			assert.equal((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))[0]!.id, hitNodeId);
		} finally {
			await close();
		}
	});

	it("marks affected nodes stale/config; a plain fill does not recompute them", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "wrong and putain" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");
			const before = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).map((n) => ({ id: n.id, sig: (JSON.parse(n.content_json) as TurnFrustrationProperties).signal }));
			assert.deepEqual(before.map((b) => b.sig).sort(), ["putain", "wrong"]);
			const beforeFingerprint = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))[0]!.config_fingerprint;

			// Mute one term. cursor: the config fingerprint is a hash of the active
			// assertion set, so it must change.
			await muteTerm(db, { term: "wrong", reason: "grammar", by: "operator" });
			const ver = await verifyNodes(db);
			assert.equal(ver.mismatches.length, 0, "muting modifies no node, so verify stays clean");

			// A plain fill recomputes nothing: the stale units are not touched.
			const fill = await framework.run("s1");
			assert.equal(fill.nodesProduced, 0, "plain fill leaves everything alone");
			assert.equal((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).length, 2, "no node deleted");
			assert.equal((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))[0]!.config_fingerprint, beforeFingerprint, "existing nodes unchanged");

			// `--revise config` recomputes: the unmuted 'putain' gets a fresh node
			// (a new version that revises the old), while the muted 'wrong' is not
			// recreated. Its old node stays in the graph as lineage, but it is
			// silenced: the mute marked it, so it is no longer a *current* finding
			// and no reader counts it (#325).
			const revise = await framework.run("s1", { revise: ["config"] });
			assert.equal(revise.nodesRevised, 1, "only the unmuted term is revised");
			const after = await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1");
			assert.equal(after.length, 3, "the recomputed node is added, not replacing");
			assert.equal(
				after.filter((n) => (JSON.parse(n.content_json) as TurnFrustrationProperties).signal === "wrong").length,
				1,
				"the muted term's hit is preserved exactly once as lineage",
			);
			assert.equal(
				after.filter((n) => (JSON.parse(n.content_json) as TurnFrustrationProperties).signal === "putain").length,
				2,
				"the unmuted term has its old + new version",
			);

			// Verify stays clean after the revise too.
			assert.equal((await verifyNodes(db)).mismatches.length, 0);
		} finally {
			await close();
		}
	});

	it("is content-keyed, so mutes survive a wipe-and-recompute", async () => {
		const { db, close } = await tempDb();
		try {
			await muteTerm(db, { term: "wrong", reason: "corpus taste", by: "operator" });
			// Mutes key on the term, not a row id — re-derive the active set.
			assert.deepEqual(await getMutedTerms(db), ["wrong"]);
			assert.deepEqual((await getActiveAssertions(db)).map((a) => a.subject_key), ["wrong"]);
			// The assertion id is content-addressed, not a random row id.
			assert.match((await getActiveAssertions(db))[0]!.id, /^[0-9a-f]{16}$/);
		} finally {
			await close();
		}
	});

	it("unmutes append-only via superseded_at and restores matching", async () => {
		const { db, close } = await tempDb();
		try {
			await muteTerm(db, { term: "wrong", reason: "not a signal", by: "operator" });
			assert.equal(await isTermMuted(db, "wrong"), true);

			const n = await unmuteTerm(db, "wrong");
			assert.equal(n, 1, "one active mute superseded");
			assert.equal(await isTermMuted(db, "wrong"), false);
			assert.deepEqual(await getMutedTerms(db), []);

			// The mute row stays inspectable (append-only) — just superseded.
			const rows = await listAssertions(db, "term");
			assert.equal(rows.length, 1);
			assert.ok(rows[0]!.superseded_at !== null, "the original mute is superseded, not deleted");

			// Re-muting reactivates the same content-addressed row.
			await muteTerm(db, { term: "wrong" });
			assert.equal(await isTermMuted(db, "wrong"), true);
			assert.equal((await listAssertions(db, "term")).length, 1, "one logical assertion, reactivated");
		} finally {
			await close();
		}
	});

	it("keys a quoted multi-word mute the way the lexicon keys the phrase, and unmutes it", async () => {
		const { db, close } = await tempDb();
		try {
			await muteTerm(db, { term: '"Do  Not"' });
			assert.deepEqual(await getMutedTerms(db), ["do not"]);
			assert.equal(await isTermMuted(db, "do not"), true);

			assert.equal(await unmuteTerm(db, '"do not"'), 1);
			assert.deepEqual(await getMutedTerms(db), []);
		} finally {
			await close();
		}
	});

	it("joins the mute to the graph with a mutes edge", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "that is wrong" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");

			const result = await muteTerm(db, { term: "wrong", by: "operator" });
			// The frustration-lexicon node for 'wrong' should now carry a mutes edge
			// to the assertion.
			const lexNodes = await getNodesByAnalyzer(db, "frustration-lexicon", "s1");
			const edges = (await Promise.all(lexNodes.flatMap((n) => getEdgesFrom(db, n.id)))).flat();
			const mutesEdge = edges.find((e) => e.edge_kind === "mutes");
			assert.ok(mutesEdge, "a mutes edge exists from the lexicon node");
			assert.equal(mutesEdge!.to_ref_kind, "assertion");
			assert.equal(mutesEdge!.to_ref_id, result.assertionId);

			// Idempotent: re-muting does not duplicate the edge.
			await muteTerm(db, { term: "wrong", by: "operator" });
			const allNodes = await getNodesByAnalyzer(db, "frustration-lexicon", "s1");
			const edgeCount = (await Promise.all(allNodes.flatMap((n) => getEdgesFrom(db, n.id)))).flat().filter((e) => e.edge_kind === "mutes").length;
			assert.equal(edgeCount, 1);
		} finally {
			await close();
		}
	});

	it("leaves frustration-lexicon (the judger) out of the mute fingerprint", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "that is wrong" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");
			const lexFpBefore = (await getNodesByAnalyzer(db, "frustration-lexicon", "s1"))[0]!.config_fingerprint;

			await muteTerm(db, { term: "wrong", by: "operator" });

			// Judging a term is unaffected by muting it: the lexicon's fingerprint does
			// not fold in the mute set, so a recompute never re-adjudicates the corpus.
			const fill = await framework.run("s1");
			assert.equal(fill.nodesProduced, 0);
			assert.equal((await getNodesByAnalyzer(db, "frustration-lexicon", "s1"))[0]!.config_fingerprint, lexFpBefore);
		} finally {
			await close();
		}
	});

	it("reports the active mute corpus", async () => {
		const { db, close } = await tempDb();
		try {
			await muteTerm(db, { term: "cannot", by: "operator" });
			await muteTerm(db, { term: "do", by: "agent" });
			await supersedeAssertion(db, { subjectKind: "term", subjectKey: "do", verdict: "muted" });
			const rows = await listAssertions(db, "term");
			assert.equal(rows.length, 2, "both mutes are recorded");
			assert.equal(rows.filter((r) => r.superseded_at === null).length, 1, "one remains active");
		} finally {
			await close();
		}
	});
});

describe("a muted term's existing hits (#325)", () => {
	it("marks every live hit node of the term with a mutes edge", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "wrong again" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");
			const hit = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))[0]!;

			const result = await muteTerm(db, { term: "wrong", by: "operator" });
			assert.equal(result.liveHits, 1, "the mute reports the live hit node it left behind");

			// The hit node now carries the mute: the edge reaches the judgement
			// from the analysed conclusion it silences.
			const edges = await getEdgesFrom(db, hit.id);
			const mutesEdge = edges.find((e) => e.edge_kind === "mutes");
			assert.ok(mutesEdge, "the hit node carries a mutes edge");
			assert.equal(mutesEdge!.to_ref_kind, "assertion");
			assert.equal(mutesEdge!.to_ref_id, result.assertionId);

			// And the reader helper agrees.
			assert.ok((await getMutedNodeIds(db)).has(hit.id));

			// The lexicon verdict node keeps its own mutes edge: judging a word is
			// a corpus-wide conclusion, muting it is about matching.
			const lexNodes = await getNodesByAnalyzer(db, "frustration-lexicon", "s1");
			const lexEdges = (await Promise.all(lexNodes.flatMap((n) => getEdgesFrom(db, n.id)))).flat();
			assert.ok(lexEdges.some((e) => e.edge_kind === "mutes"), "the lexicon verdict keeps its mutes edge");
		} finally {
			await close();
		}
	});

	it("stops counting the muted term's hits in the surface and the stock outputs, and restores them on unmute", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "wrong and putain" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");
			assert.equal(await countAnalysisNodes(db, { analyzerId: TURN_FRUSTRATION_DEF.id }), 2);

			await muteTerm(db, { term: "wrong", by: "operator" });

			// The muted hit is no longer a current finding: the surface read that
			// backs `prospect nodes` reports one hit, not two.
			assert.equal(
				await countAnalysisNodes(db, { analyzerId: TURN_FRUSTRATION_DEF.id }),
				1,
				"the muted term's hit is not counted as a current finding",
			);
			const counted = await listAnalysisNodes(db, { analyzerId: TURN_FRUSTRATION_DEF.id });
			assert.deepEqual(
				counted.map((n) => (JSON.parse(n.content_json) as TurnFrustrationProperties).signal),
				["putain"],
			);

			// It is still in the graph — preserved as lineage, never deleted.
			assert.equal(
				(await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).length,
				2,
				"the muted hit is still live and inspectable",
			);
			assert.equal((await verifyNodes(db)).mismatches.length, 0, "the graph still verifies");

			// Unmuting makes the mark inert again: the hit counts once more.
			await unmuteTerm(db, "wrong");
			assert.equal(await countAnalysisNodes(db, { analyzerId: TURN_FRUSTRATION_DEF.id }), 2);
			assert.equal((await getMutedNodeIds(db)).size, 0, "no node is muted any more");
		} finally {
			await close();
		}
	});

	it("does not report a muted node as a superseded generation", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "wrong" }, { role: "assistant", text: "ok" }]);

			const { framework } = await build(db);
			await framework.run("s1");
			const before = await getAnalysisStats(db);
			// The one `turn-frustration` node is current; the other three are the
			// lexicon chain's, which the mute does not touch.
			const beforeTf = before.nodesByAnalyzer[TURN_FRUSTRATION_DEF.id] ?? 0;
			assert.equal(beforeTf, 1, "one current turn-frustration node");
			assert.equal(before.supersededNodes, 0, "nothing supersedes anything");

			// The mute silences the hit. Nothing *revises* it — the operator said
			// it does not count — so it must not be reported as a superseded
			// generation either: the two populations the difference is computed
			// between have to agree on what "current" means.
			await muteTerm(db, { term: "wrong", by: "operator" });
			const after = await getAnalysisStats(db);
			assert.equal(after.nodesByAnalyzer[TURN_FRUSTRATION_DEF.id] ?? 0, 0, "the muted hit is not a current node");
			assert.equal(after.supersededNodes, 0, "and it is not a superseded generation either");
		} finally {
			await close();
		}
	});

	it("gives friction-accumulation a lexicon friction of 0 for a session whose only hits were the muted term", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "that is wrong" }, { role: "assistant", text: "ok" }]);

			const { framework } = await buildWithReaders(db);
			await framework.run("s1");

			const readAccumulation = async () => {
				// The newest accumulation node: a revise adds a version beside its
				// predecessor, and the newest one is the current conclusion.
				const nodes = await listAnalysisNodes(db, { analyzerId: "friction-accumulation" });
				assert.ok(nodes.length >= 1, "one accumulation node per session");
				return JSON.parse(nodes[0]!.content_json) as {
					accumulated_friction: number;
					turn_contributions: Array<{ frustration_weight: number }>;
				};
			};

			// Before the mute, the hit's weight is part of the session's friction.
			const before = await readAccumulation();
			assert.ok(
				before.turn_contributions.some((c) => c.frustration_weight > 0),
				"the lexicon hit contributes friction before the mute",
			);

			await muteTerm(db, { term: "wrong", by: "operator" });

			// A plain fill leaves the stale accumulation alone; the revise
			// recomputes it, and the muted hit no longer contributes.
			await framework.run("s1", { revise: ["config"] });
			const after = await readAccumulation();
			assert.equal(
				after.turn_contributions.every((c) => c.frustration_weight === 0),
				true,
				"the muted term contributes no lexicon friction after the revise",
			);

			// Unmuting restores the count: the mute was config, so unmuting
			// reverts the fingerprint and the next revise brings the hit back.
			await unmuteTerm(db, "wrong");
			await framework.run("s1", { revise: ["config"] });
			const restored = await readAccumulation();
			assert.ok(
				restored.turn_contributions.some((c) => c.frustration_weight > 0),
				"unmuting restores the term's contribution",
			);
		} finally {
			await close();
		}
	});
});
