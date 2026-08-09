/**
 * A phrase must earn its hit.
 *
 * Run over a real corpus, the phrase feature produced 28,179 hits against the
 * word lexicon's 9,350 — and the top phrases were all redundant with a word that
 * had already fired: `do not` ×563, `is not` ×475, `with no` ×247, and most
 * tellingly `👍 on` ×285 and `with 👍` ×285, where 👍 is itself a praise term and
 * the "phrase" is just that emoji plus whatever word sat beside it.
 *
 * The rule that separates signal from noise is *contribution*: a phrase counts
 * only when it says something its component words do not already say. That is
 * exactly what makes `laisse tomber` worth having — neither `laisse` nor
 * `tomber` carries it — and exactly what makes `do not` worthless once `not` is
 * in the lexicon.
 *
 * Enforced deterministically at match time rather than left to the model, so it
 * holds regardless of which model judged the phrase.
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
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF, type TurnFrustrationProperties } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/**
 * A stub lexicon. `not` and 👍 are word-level signals; `laisse tomber` is an
 * idiom whose parts are neutral — the shape that must survive.
 */
const FLAGGED: Record<string, "frustration" | "praise"> = {
	not: "frustration",
	"👍": "praise",
	"laisse tomber": "frustration",
	"do not": "frustration",
	"👍 on": "praise",
	"trop lent": "frustration",
};

function build(db: Parameters<typeof getNodesByAnalyzer>[0]) {
	const llm = createMockLLM({
		responder: (req: LLMRequest) => {
			const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const pol = FLAGGED[term];
			return {
				text: "x",
				structured: {
					polarity: pol ?? "neutral",
					category: pol ? (pol === "praise" ? "praise" : "negation") : "none",
					language: "und",
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

async function hitsFor(text: string): Promise<TurnFrustrationProperties[]> {
	const { db, close } = tempDb();
	try {
		insertSession(db, "s1");
		insertMessages(db, "s1", [{ role: "user", text }, { role: "assistant", text: "ok" }]);
		const { framework } = build(db);
		await framework.run("s1");
		return getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1").map(
			(n) => JSON.parse(n.content_json) as TurnFrustrationProperties,
		);
	} finally {
		close();
	}
}

describe("phrases must contribute beyond their parts", () => {
	it("keeps an idiom whose component words are neutral", async () => {
		const signals = (await hitsFor("bon, laisse tomber")).map((h) => h.signal);
		assert.deepEqual(signals, ["laisse tomber"], "the motivating case must still fire");
	});

	it("drops a phrase that merely repeats a word already firing", async () => {
		const hits = await hitsFor("do not use that");
		assert.deepEqual(
			hits.map((h) => h.signal),
			["not"],
			"`do not` adds nothing once `not` has fired — one hit, not two",
		);
	});

	it("drops a phrase built from an emoji that already fired", async () => {
		// The real corpus case: `👍 on` ×285 and `with 👍` ×285, both redundant.
		const hits = await hitsFor("👍 on the fix");
		assert.deepEqual(hits.map((h) => h.signal), ["👍"]);
	});

	it("keeps an idiom and a genuinely separate word signal in the same turn", async () => {
		const signals = (await hitsFor("not this. laisse tomber")).map((h) => h.signal).sort();
		assert.deepEqual(signals, ["laisse tomber", "not"], "both carry distinct signal");
	});

	it("keeps two independent idioms", async () => {
		const signals = (await hitsFor("trop lent. laisse tomber")).map((h) => h.signal).sort();
		assert.deepEqual(signals, ["laisse tomber", "trop lent"]);
	});
});
