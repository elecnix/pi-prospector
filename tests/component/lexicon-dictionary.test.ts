/**
 * The user's frustration dictionary in turn-frustration.
 *
 * `lexicon.mode` picks where lexicon hits come from: `model` (the learned
 * lexicon, the default), `dictionary` (only the user's entries, no model
 * calls), or `both`. Each lexicon hit records its source, and when both sources
 * know a term, the user's entry wins.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import {
	frustrationLexiconAnalyzer,
	FRUSTRATION_LEXICON_DEF,
} from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import {
	turnFrustrationAnalyzer,
	TURN_FRUSTRATION_DEF,
	type TurnFrustrationProperties,
} from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { getAnalyzerConfigOverrides } from "../../src/config.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import type { ProspectorConfig } from "../../src/types.js";

const FRUSTRATED_TERMS = new Set(["putain", "wrong"]);

type Db = Parameters<typeof getNodesByAnalyzer>[0];

async function build(db: Db, config: ProspectorConfig) {
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
	const framework = new AnalyzerFramework({
		db,
		llm: llm.caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: getAnalyzerConfigOverrides(config),
	});
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	await framework.register(turnFrustrationAnalyzer);
	return { framework, llm };
}

async function hits(db: Db, sessionId: string): Promise<TurnFrustrationProperties[]> {
	return (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, sessionId))
		.map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties)
		.filter((h) => h.signal_source === "lexicon")
		.sort((a, b) => (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0));
}

async function runOne(config: ProspectorConfig, text: string) {
	const { db, close } = await tempDb();
	try {
		await insertSession(db, "s1");
		await insertMessages(db, "s1", [
			{ role: "user", text },
			{ role: "assistant", text: "ok" },
		]);
		const { framework, llm } = await build(db, config);
		await framework.run("s1");
		return {
			hits: await hits(db, "s1"),
			calls: llm.calls.length,
			verdicts: (await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id)).length,
		};
	} finally {
		await close();
	}
}

describe("lexicon dictionary", () => {
	it("a dictionary-only run makes no model call and matches only the user's entries", async () => {
		const out = await runOne(
			{ lexicon: { mode: "dictionary", dictionary: [{ term: "zut", category: "profanity" }] } },
			"putain zut that is wrong",
		);
		assert.equal(out.calls, 0, "dictionary mode never calls a model");
		assert.equal(out.verdicts, 0, "dictionary mode judges no term");
		assert.deepEqual(
			out.hits.map((h) => [h.signal, h.lexicon_source, h.polarity, h.category, h.language]),
			[["zut", "dictionary", "frustration", "profanity", "und"]],
		);
	});

	it("a both run tags each hit with its source, and the dictionary wins on a shared term", async () => {
		const out = await runOne(
			{
				lexicon: {
					mode: "both",
					dictionary: [
						{ term: "wrong", category: "correction", language: "en" },
						{ term: "zut", category: "profanity", language: "fr" },
					],
				},
			},
			"putain zut that is wrong",
		);
		assert.ok(out.calls > 0, "both mode still asks the model about nominated terms");
		assert.deepEqual(
			out.hits.map((h) => [h.signal, h.lexicon_source, h.category, h.language]),
			[
				["putain", "model", "dissatisfaction", "fr"],
				// The model called `wrong` dissatisfaction; the user's entry wins.
				["wrong", "dictionary", "correction", "en"],
				["zut", "dictionary", "profanity", "fr"],
			],
		);
	});

	it("matches a phrase entry, normalised the way turns are tokenised", async () => {
		const out = await runOne(
			{
				lexicon: {
					mode: "dictionary",
					dictionary: [
						{ term: "Laisse  tomber", category: "dissatisfaction", language: "fr" },
						{ term: "pas encore ça", category: "repetition", language: "fr" },
					],
				},
			},
			"Bon, laisse tomber. Pas encore ça !",
		);
		assert.deepEqual(
			out.hits.map((h) => [h.signal, h.lexicon_source, h.category, h.count]),
			[
				["laisse tomber", "dictionary", "dissatisfaction", 1],
				["pas encore ça", "dictionary", "repetition", 1],
			],
		);
	});

	it("records praise entries with praise polarity", async () => {
		const out = await runOne(
			{ lexicon: { mode: "dictionary", dictionary: [{ term: "nickel", category: "praise" }] } },
			"nickel, merci",
		);
		assert.deepEqual(out.hits.map((h) => [h.signal, h.polarity, h.category]), [["nickel", "praise", "praise"]]);
	});

	it("the default mode leaves existing output unchanged", async () => {
		const text = "putain zut that is wrong";
		const plain = await runOne({}, text);
		// A dictionary without a mode is not used: the mode defaults to `model`.
		const unused = await runOne({ lexicon: { dictionary: [{ term: "zut", category: "profanity" }] } }, text);
		const explicit = await runOne({ lexicon: { mode: "model" } }, text);

		for (const out of [plain, unused, explicit]) {
			assert.deepEqual(
				out.hits.map((h) => [h.signal, h.lexicon_source, h.polarity, h.category, h.language, h.weight]),
				[
					["putain", "model", "frustration", "dissatisfaction", "fr", 0.5],
					["wrong", "model", "frustration", "dissatisfaction", "fr", 0.5],
				],
			);
			assert.equal(out.calls, plain.calls);
			assert.equal(out.verdicts, plain.verdicts);
		}
		assert.deepEqual(getAnalyzerConfigOverrides({ lexicon: { mode: "model", dictionary: [{ term: "zut", category: "profanity" }] } }), {});
	});
});
