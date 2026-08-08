/**
 * Phrases end to end — the exact case from issue #40.
 *
 * `laisse tomber` ("forget it") is clear disengagement. `laisse` and `tomber` are
 * each genuinely neutral, and judging them neutral is *correct*. Before phrase
 * support the signal was simply unreachable: no verdict on any single token could
 * ever surface it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { lexiconCandidatesAnalyzer, LEXICON_CANDIDATES_DEF, type LexiconCandidatesProperties } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF, type TurnFrustrationProperties } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** Only the *phrase* carries frustration; its component words do not. */
const FRUSTRATED_PHRASES = new Set(["laisse tomber", "trop lent"]);

function build(db: Parameters<typeof getNodesByAnalyzer>[0]) {
	const llm = createMockLLM({
		responder: (req: LLMRequest) => {
			const entry = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const frustrated = FRUSTRATED_PHRASES.has(entry);
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
	for (const a of [turnPairCoreAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer]) {
		framework.register(a);
	}
	return { framework, llm };
}

describe("phrase support", () => {
	it("nominates adjacent bigrams alongside single terms", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: "laisse tomber" }, { role: "assistant", text: "ok" }]);

			const { framework } = build(db);
			await framework.run("s1", { analyzerIds: [LEXICON_CANDIDATES_DEF.id] });

			const props = JSON.parse(
				getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "s1")[0]!.content_json,
			) as LexiconCandidatesProperties;
			assert.deepEqual(props.terms.map((t) => t.term).sort(), ["laisse", "tomber"]);
			assert.deepEqual(props.phrases.map((p) => p.term), ["laisse tomber"]);
		} finally {
			close();
		}
	});

	it("detects frustration whose component words are each neutral", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [
				{ role: "user", text: "bon, laisse tomber" },
				{ role: "assistant", text: "understood" },
			]);

			const { framework } = build(db);
			await framework.run("s1");

			// Every single word was judged neutral — correctly.
			const verdicts = getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1").map(
				(n) => JSON.parse(n.content_json) as { term: string; polarity: string },
			);
			const byTerm = new Map(verdicts.map((v) => [v.term, v.polarity]));
			assert.equal(byTerm.get("laisse"), "neutral");
			assert.equal(byTerm.get("tomber"), "neutral");
			assert.equal(byTerm.get("laisse tomber"), "frustration");

			// And the turn is nonetheless flagged, via the phrase.
			const hits = getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1").map(
				(n) => JSON.parse(n.content_json) as TurnFrustrationProperties,
			);
			assert.deepEqual(hits.map((h) => h.signal), ["laisse tomber"]);
			assert.equal(hits[0]!.signal_source, "lexicon_phrase");
			assert.equal(hits[0]!.language, "fr");
		} finally {
			close();
		}
	});

	it("caches a phrase corpus-wide, exactly like a single term", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: "laisse tomber" }, { role: "assistant", text: "ok" }]);
			insertSession(db, "s2");
			insertMessages(db, "s2", [{ role: "user", text: "laisse tomber alors" }, { role: "assistant", text: "ok" }]);

			const { framework, llm } = build(db);
			await framework.run("s1");
			await framework.run("s2");

			const judged = llm.calls.filter((c) => c.user.includes("TERM: laisse tomber")).length;
			assert.equal(judged, 1, "the phrase is judged once for the whole corpus");

			const s2Hits = getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s2").map(
				(n) => JSON.parse(n.content_json) as TurnFrustrationProperties,
			);
			assert.equal(s2Hits.some((h) => h.signal === "laisse tomber"), true, "s2 reuses s1's verdict");
		} finally {
			close();
		}
	});

	it("never forms a phrase across a sentence boundary", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			// "tomber" ends one sentence and "trop" starts the next: `tomber trop` is a
			// seam, not something the user said.
			insertMessages(db, "s1", [
				{ role: "user", text: "ne fais pas tomber. trop lent ici" },
				{ role: "assistant", text: "ok" },
			]);

			const { framework } = build(db);
			await framework.run("s1", { analyzerIds: [LEXICON_CANDIDATES_DEF.id] });

			const props = JSON.parse(
				getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "s1")[0]!.content_json,
			) as LexiconCandidatesProperties;
			const phrases = props.phrases.map((p) => p.term);
			assert.equal(phrases.includes("tomber trop"), false);
			assert.equal(phrases.includes("trop lent"), true);
		} finally {
			close();
		}
	});
});
