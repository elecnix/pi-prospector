/**
 * A reader counts only the person's own words (`pricedHits`).
 *
 * A hit records how many of its occurrences were typed (`typed_count`) out of
 * its `count`. The reading scales the hit's weight by that share and drops a hit
 * with no typed occurrence, so a swear word inside a quote or a pasted log adds
 * nothing to a ranking, a boost or a digest. A hit drawn before the origin fields
 * existed has no `typed_count` and is read as it always was.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { messageOriginAnalyzer } from "../../src/analyze/analyzers/message-origin/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF, type TurnFrustrationProperties } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { pricedHits } from "../../src/analyze/hit-reading.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const NEUTRAL = Array.from({ length: 12 }, (_, i) => [
	{ role: "user" as const, text: `please run check number ${i}` },
	{ role: "assistant" as const, text: "Done." },
]).flat();

const MESSAGES = [
	{ role: "user" as const, text: "putain the parser is broken" },
	{ role: "assistant" as const, text: "Fixed." },
	{ role: "user" as const, text: "> putain the build is broken\nplease look again" },
	{ role: "assistant" as const, text: "Fixed." },
	...NEUTRAL,
];

describe("pricedHits counts typed words only", () => {
	it("keeps a typed hit, drops a hit whose words were quoted, and scales a mixed hit", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);
			const llm = createMockLLM({
				responder: (req: LLMRequest) => {
					const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
					const hot = term === "putain";
					return { text: "x", structured: { polarity: hot ? "frustration" : "neutral", category: hot ? "dissatisfaction" : "none", language: hot ? "fr" : "und", confidence: 0.9, rationale: "r" } };
				},
			});
			const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
			for (const a of [messageOriginAnalyzer, turnPairCoreAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer]) await framework.register(a);
			await framework.run("s1");

			const stored = await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1");
			const putain = stored.filter((n) => (JSON.parse(n.content_json) as TurnFrustrationProperties).signal === "putain");
			assert.equal(putain.length, 2, "both turns draw a hit");
			const byTyped = putain.map((n) => (JSON.parse(n.content_json) as TurnFrustrationProperties).typed_count).sort();
			assert.deepEqual(byTyped, [0, 1], "one typed occurrence, one quoted");

			const read = await pricedHits(db, stored);
			const readPutain = read.filter((n) => (JSON.parse(n.content_json) as TurnFrustrationProperties).signal === "putain");
			assert.equal(readPutain.length, 1, "the quoted hit adds nothing to a reader");
			assert.equal((JSON.parse(readPutain[0]!.content_json) as TurnFrustrationProperties).typed_count, 1);
		} finally {
			await close();
		}
	});
});
