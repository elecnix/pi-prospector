/**
 * Choosing a cheaper model for the lexicon, and failing loudly when it cannot cope.
 *
 * Judging one word is about the simplest classification there is, so it is the
 * obvious place to spend a small model rather than a frontier one — the whole
 * corpus is ~204k one-shot judgements. But a weaker model may not support forced
 * tool calls, and a verdict is cached *permanently*: silently defaulting to
 * "neutral" would poison the lexicon corpus-wide and make the feature quietly do
 * nothing. A missing structured response must therefore be an error, so the unit
 * stays missing and self-heals on the next run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

async function frameworkWith(
	db: Parameters<typeof getNodesByAnalyzer>[0],
	responder: (req: LLMRequest) => ReturnType<typeof structuredNeutral>,
	overrides?: Record<string, Record<string, unknown>>,
) {
	const llm = createMockLLM({ responder });
	const framework = new AnalyzerFramework({
		db,
		llm: llm.caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: overrides,
	});
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	return { framework, llm };
}

function structuredNeutral() {
	return {
		text: "x",
		structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "r" },
	};
}

describe("lexicon model selection", () => {
	it("refuses to cache a verdict when the model returned no structured output", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			// A model with no usable tool-calling: prose only, no structured arguments.
			const { framework } = await frameworkWith(db, () => ({ text: "Sure! That word seems negative." }) as never);
			const summary = await framework.run("s1");

			assert.ok(summary.errors.length > 0, "the failure is reported, not swallowed");
			const nodes = await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1");
			assert.equal(
				nodes.some((n) => n.node_kind !== "error"),
				false,
				"no verdict node is written — a wrong verdict would be cached corpus-wide, forever",
			);
		} finally {
			await close();
		}
	});

	it("self-heals once the model answers properly", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			const broken = await frameworkWith(db, () => ({ text: "prose" }) as never);
			await broken.framework.run("s1");

			// The unit was never satisfied, so a later run with a capable model fills it.
			const fixed = await frameworkWith(db, structuredNeutral);
			const summary = await fixed.framework.run("s1");
			assert.equal(summary.errors.length, 0);
			assert.ok(
				(await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1")).some((n) => n.node_kind === "classification"),
				"the verdict lands on the retry",
			);
		} finally {
			await close();
		}
	});

	it("lets one analyzer use a different model from the rest", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			const { framework, llm } = await frameworkWith(db, structuredNeutral, {
				"frustration-lexicon": { tier: "openrouter/google/gemma-4-31b-it:free" },
			});
			await framework.run("s1");

			const models = new Set(llm.calls.map((c) => c.model));
			assert.deepEqual(
				[...models],
				["openrouter/google/gemma-4-31b-it:free"],
				"an explicit provider/model spec is honoured in place of a tier name",
			);
		} finally {
			await close();
		}
	});

	it("folds the chosen model into identity, so switching is a config change", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			const cheap = await frameworkWith(db, structuredNeutral, {
				"frustration-lexicon": { tier: "openrouter/google/gemma-4-31b-it:free" },
			});
			await cheap.framework.run("s1");

			// A different model is a different recipe: the unit is stale, not current,
			// so a plain fill leaves it alone and only `--revise config` re-judges it.
			const other = await frameworkWith(db, structuredNeutral, {
				"frustration-lexicon": { tier: "deepseek/deepseek-v4-flash" },
			});
			const plain = await other.framework.run("s1");
			assert.equal(plain.nodesProduced, 0, "a plain fill does not silently re-judge on a model swap");

			const revised = await other.framework.run("s1", { revise: ["config"] });
			assert.ok(revised.nodesRevised > 0, "asking for config revision re-judges under the new model");
		} finally {
			await close();
		}
	});
});
