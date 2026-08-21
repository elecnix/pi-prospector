/**
 * turn-frustration: where a session's turns meet the learned lexicon.
 *
 * Two properties matter most here.
 *
 * 1. *Additivity.* One node per (turn, term) means learning a new word can only
 *    ever add nodes. It never rewrites a source set, so it never strands an
 *    existing node as neither revised nor superseded, and it never forces work
 *    that was already done to be redone.
 * 2. *The lexicon is not a gate.* Frustration that uses none of our vocabulary —
 *    shouting, punctuation storms, elongation — is still detected, because those
 *    markers need neither a lexicon nor a language.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
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
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const FRUSTRATED_TERMS = new Set(["putain", "wrong", "pénible"]);

function build(db: Parameters<typeof getNodesByAnalyzer>[0]) {
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
	framework.register(turnPairCoreAnalyzer);
	framework.register(lexiconCandidatesAnalyzer);
	framework.register(frustrationLexiconAnalyzer);
	framework.register(turnFrustrationAnalyzer);
	return { framework, llm };
}

function hits(db: Parameters<typeof getNodesByAnalyzer>[0], sessionId: string): TurnFrustrationProperties[] {
	return ((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, sessionId)).map(
		(n) => JSON.parse(n.content_json) as TurnFrustrationProperties,
	);
}

describe("turn-frustration", () => {
	it("emits one node per (turn, term) and ignores neutral vocabulary", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "putain that is wrong" },
				{ role: "assistant", text: "fixing" },
			]);

			const { framework } = build(db);
			await framework.run("s1");

			const found = hits(db, "s1");
			assert.deepEqual(found.map((h) => h.signal).sort(), ["putain", "wrong"]);
			assert.equal(found.every((h) => h.signal_source === "lexicon"), true);
			assert.equal(found.every((h) => h.polarity === "frustration"), true);
			assert.equal(found[0]!.language, "fr");
		} finally {
await close();
		}
	});

	it("detects frustration expressed with no lexicon word at all", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "hmmmm ????" },
				{ role: "assistant", text: "let me check" },
			]);

			const { framework } = build(db);
			await framework.run("s1");

			const found = hits(db, "s1");
			assert.ok(found.length > 0, "a turn with no known vocabulary still produces signal");
			assert.equal(found.every((h) => h.signal_source === "paralinguistic"), true);
			assert.deepEqual(found.map((h) => h.signal).sort(), ["elongation", "repeated_punctuation"]);
		} finally {
await close();
		}
	});

	it("is additive: learning a word elsewhere leaves an analysed session untouched", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "that is wrong" }, { role: "assistant", text: "ok" }]);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "putain" }, { role: "assistant", text: "ok" }]);

			const { framework } = build(db);
			await framework.run("s1");

			const before = ((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).map((n) => n.id);
			assert.equal(before.length, 1);

			// s2 teaches the corpus a brand-new frustration word.
			await framework.run("s2");

			// s1 must be entirely unaffected: no node re-identified, nothing to redo.
			const scan = await framework.scan("s1");
			const notCurrent = scan.filter((u) => u.status !== "current");
			assert.deepEqual(notCurrent, [], "growing the lexicon must not invalidate settled work");
			assert.deepEqual(
				((await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).map((n) => n.id),
				before,
				"the existing hit nodes are the same nodes, not replacements",
			);
		} finally {
await close();
		}
	});

	it("picks up a word the corpus learned earlier when a later session uses it", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }, { role: "assistant", text: "ok" }]);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "putain, encore pénible" }, { role: "assistant", text: "ok" }]);

			const { framework, llm } = build(db);
			await framework.run("s1");
			const callsAfterS1 = llm.calls.length;
			await framework.run("s2");

			// Code-unit order, matching the analyzer's locale-independent sort.
			assert.deepEqual(hits(db, "s2").map((h) => h.signal).sort(), ["putain", "pénible"]);
			// `putain` was judged during s1; s2 reuses that verdict without re-asking.
			// Exact match: a phrase entry such as `TERM: putain encore` must not be
			// counted as another adjudication of the single word.
			const putainCalls = llm.calls.filter((c) => c.user === "TERM: putain").length;
			assert.equal(putainCalls, 1);
			assert.ok(llm.calls.length > callsAfterS1, "s2's genuinely new words were still judged");
		} finally {
await close();
		}
	});

	it("anchors each hit to its turn and consumes the term node it matched", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			const ids = insertMessages(db, "s1", [
				{ role: "user", text: "putain" },
				{ role: "assistant", text: "ok" },
			]);

			const { framework } = build(db);
			await framework.run("s1");

			const node = getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")[0]!;
			const edges = db
				.prepare("SELECT to_ref_kind, to_ref_id, edge_kind FROM analysis_edges WHERE from_node_id = ?")
				.all(node.id) as Array<{ to_ref_kind: string; to_ref_id: string; edge_kind: string }>;

			assert.ok(
				edges.some((e) => e.edge_kind === "anchors" && e.to_ref_kind === "message" && e.to_ref_id === ids[0]),
				"the hit points at the turn that contains it",
			);
			assert.ok(
				edges.some((e) => e.edge_kind === "consumes" && e.to_ref_kind === "analysis_node"),
				"the hit points at the lexicon verdict that justified it",
			);
		} finally {
await close();
		}
	});
});
