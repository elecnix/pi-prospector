/**
 * A background word stops counting, in any language, without a word list
 * (issue #321).
 *
 * A corpus's frustration ranking was dominated by `do`, `no`, `never`, `cannot`
 * and `still` — ordinary instruction words that appear in nearly every prompt.
 * The first fix was a hand-written list of English function words, which was
 * wrong twice over: it could not reach any language but English, and it decided
 * by spelling a property the corpus can measure for itself.
 *
 * What those words have in common is not their language. It is that a large
 * share of turns carries them, so they cannot distinguish one turn from another.
 * That share is document frequency, and it is measurable for `do`, `putain`, and
 * `まだ` alike.
 *
 * This file pins the two halves of the contract:
 *
 *   - The graph keeps the facts. A turn that contains `do` still gets a hit node
 *     saying so; nothing is hidden and nothing is retracted.
 *   - The readers price them. A hit whose term is carried by more than a tenth of
 *     the corpus's turns contributes nothing — here, `do`, which the model even
 *     called a frustration signal.
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
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { frictionAccumulationAnalyzer, FRICTION_ACCUMULATION_DEF } from "../../src/analyze/analyzers/friction-accumulation/index.js";
import { pricedHits } from "../../src/analyze/hit-reading.js";
import { MIN_DOCUMENTS } from "../../src/analyze/term-specificity.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** Both are called frustration by the model: the corpus, not the model, decides `do`. */
const FRUSTRATION_TERMS = new Set(["do", "putain"]);

/** `do` in six of twenty turns; `putain` in one. Nothing here knows which is English. */
function corpus(): Array<{ role: "user" | "assistant"; text: string }> {
	const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (let i = 0; i < MIN_DOCUMENTS; i++) {
		const user = i === 7 ? "putain the parser is broken" : i < 6 ? `do the thing, pass ${i}` : `pass ${i}`;
		messages.push({ role: "user", text: user }, { role: "assistant", text: `done ${i}` });
	}
	return messages;
}

describe("a background word stops counting, in any language", () => {
	it("keeps the hit as a fact but prices it at nothing in the readers", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", corpus());

			const llm = createMockLLM({
				responder: (req: LLMRequest) => {
					const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
					const frustrated = FRUSTRATION_TERMS.has(term);
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
			await framework.register(frictionAccumulationAnalyzer);
			await framework.run("s1");

			// ── The facts stay. ────────────────────────────────────────────────
			const hits = await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1");
			const signals = hits.map((n) => (JSON.parse(n.content_json) as { signal: string }).signal);
			assert.ok(signals.includes("do"), `the turn containing 'do' keeps its hit: ${[...new Set(signals)].join(", ")}`);
			assert.ok(signals.includes("putain"), "the turn containing 'putain' keeps its hit");

			// ── The reading prices them. ────────────────────────────────────────
			const priced = await pricedHits(db, hits);
			const pricedSignals = priced.map((n) => (JSON.parse(n.content_json) as { signal: string }).signal);
			assert.ok(
				!pricedSignals.includes("do"),
				`a word carried by 6 of 20 turns is background and must not count: ${[...new Set(pricedSignals)].join(", ")}`,
			);
			assert.ok(pricedSignals.includes("putain"), "a word carried by 1 of 20 turns still counts");

			// It is priced, not merely kept: the ranking weights by how unusual it is.
			const putain = priced.find((n) => (JSON.parse(n.content_json) as { signal: string }).signal === "putain");
			const weight = (JSON.parse(putain!.content_json) as { weight: number }).weight;
			assert.ok(weight > 0 && weight < 1, `a term in 5% of turns keeps a fraction of its weight, got ${weight}`);

			// ── The accumulated friction agrees with the reading. ───────────────
			const accumulated = (await getNodesByAnalyzer(db, FRICTION_ACCUMULATION_DEF.id, "s1")).map(
				(n) => JSON.parse(n.content_json) as { turn_contributions: Array<{ frustration_weight: number }> },
			);
			assert.ok(accumulated.length > 0, "the accumulation ran");
			const frustrationTotal = accumulated[0]!.turn_contributions.reduce((sum, t) => sum + t.frustration_weight, 0);
			assert.ok(frustrationTotal > 0, "the rare term still moves the accumulated friction");
			assert.ok(
				frustrationTotal < 6 * 0.5,
				`the six 'do' turns contribute nothing: total ${frustrationTotal} must stay below six full-weight hits`,
			);
		} finally {
			await close();
		}
	});
});
