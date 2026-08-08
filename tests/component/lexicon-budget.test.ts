/**
 * What bounds the lexicon's cost — and what must not be used to bound it.
 *
 * Capping nomination looks like a cost control but is not one. Nomination is
 * deterministic and graph-blind, so it re-offers the same frequency-ranked list
 * every time; a tight cap therefore let ordinary words permanently occupy every
 * slot. Measured over a real corpus, 92% of nomination slots went to terms already
 * judged and 62% of sessions hit the cap with vocabulary left unoffered. It cost
 * nothing to raise, because already-judged entries are free.
 *
 * The tempting fix — budget the *unjudged* entries — is worse than the problem.
 * It makes planning a function of graph state, so every re-run frees the slots the
 * last run filled and buys another batch, forever. That breaks the framework's
 * central invariant. These tests pin both properties: unbounded reach, and
 * idempotency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { lexiconCandidatesAnalyzer, LEXICON_CANDIDATES_DEF, type LexiconCandidatesProperties } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { getNodesByAnalyzer, getLatestNodesByAnalyzerAcrossSessions } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

function build(db: Parameters<typeof getNodesByAnalyzer>[0]) {
	const llm = createMockLLM({
		responder: (_req: LLMRequest) => ({
			text: "x",
			structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "r" },
		}),
	});
	const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
	framework.register(lexiconCandidatesAnalyzer);
	framework.register(frustrationLexiconAnalyzer);
	return { framework, llm };
}

/**
 * `count` distinct, deterministic words. Letters only — a token carrying a digit
 * is an identifier and is dropped by the shape filter before nomination.
 */
function words(prefix: string, count: number): string[] {
	const letter = (n: number): string => String.fromCharCode(97 + (n % 26));
	return Array.from({ length: count }, (_, i) => `${prefix}${letter(Math.floor(i / 26))}${letter(i)}`);
}

/** Adjudications of a single word (phrases carry a space). */
function wordCalls(llm: ReturnType<typeof build>["llm"]): number {
	return llm.calls.filter((c) => !/TERM: \S+ \S+/.test(c.user)).length;
}

describe("lexicon cost", () => {
	it("nominates everything it saw — the ceiling bounds node size, not spend", async () => {
		const { db, close } = tempDb();
		try {
			const vocabulary = words("term", 120);
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: vocabulary.join(" ") }]);

			const { framework } = build(db);
			await framework.run("s1", { analyzerIds: [LEXICON_CANDIDATES_DEF.id] });

			const props = JSON.parse(
				getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "s1")[0]!.content_json,
			) as LexiconCandidatesProperties;
			assert.equal(props.terms.length, 120, "no vocabulary is left unoffered");
		} finally {
			close();
		}
	});

	it("re-running produces nothing new, however much was judged", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: words("alpha", 200).join(" ") }]);

			const { framework, llm } = build(db);
			const first = await framework.run("s1");
			assert.ok(first.nodesProduced > 200, `expected a large first pass, got ${first.nodesProduced}`);
			const spent = llm.calls.length;

			// The regression this guards: a budget over unjudged entries made each pass
			// free the previous pass's slots and buy another batch, without end.
			for (let pass = 0; pass < 3; pass++) {
				const again = await framework.run("s1");
				assert.equal(again.nodesProduced, 0, `pass ${pass + 2} must produce nothing`);
			}
			assert.equal(llm.calls.length, spent, "and must cost nothing");
		} finally {
			close();
		}
	});

	it("a session pays only for vocabulary no earlier session used", async () => {
		const { db, close } = tempDb();
		try {
			const shared = words("alpha", 60);
			const novel = words("beta", 25);

			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: shared.join(" ") }]);
			insertSession(db, "s2");
			insertMessages(db, "s2", [{ role: "user", text: [...shared, ...novel].join(" ") }]);

			const { framework, llm } = build(db);
			await framework.run("s1");
			const afterFirst = wordCalls(llm);
			assert.equal(afterFirst, shared.length, "the first session pays for its own vocabulary");

			await framework.run("s2");
			assert.equal(
				wordCalls(llm) - afterFirst,
				novel.length,
				"the second pays only for what is new — the shared words are free",
			);

			const judged = new Set(
				getLatestNodesByAnalyzerAcrossSessions(db, FRUSTRATION_LEXICON_DEF.id).map(
					(n) => (JSON.parse(n.content_json) as { term: string }).term,
				),
			);
			for (const w of [...shared, ...novel]) {
				assert.equal(judged.has(w), true, `${w} reached the lexicon`);
			}
		} finally {
			close();
		}
	});

	it("judges phrases as well as words, with neither crowding the other out", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [{ role: "user", text: words("gamma", 80).join(" ") }]);

			const { framework, llm } = build(db);
			await framework.run("s1");

			const phrases = llm.calls.length - wordCalls(llm);
			assert.equal(wordCalls(llm), 80, "every word is judged");
			assert.equal(phrases, 79, "and every adjacent bigram — n tokens yield n-1");
		} finally {
			close();
		}
	});
});
