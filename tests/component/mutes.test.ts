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
import { getNodesByAnalyzer, getEdgesFrom } from "../../src/db/analysis-queries.js";
import {
	muteTerm,
	unmuteTerm,
} from "../../src/commands/mutes.js";
import { getActiveAssertions, getMutedTerms, isTermMuted, listAssertions, supersedeAssertion } from "../../src/db/assertions.js";
import { verifyNodes } from "../../src/commands/verify.js";
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
			// recreated and its old node stays as lineage.
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
