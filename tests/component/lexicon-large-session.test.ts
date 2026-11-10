/**
 * A session whose user text is larger than the call stack can spread.
 *
 * `rankTerms` used to collect its tokens with `tokens.push(...tokenize(text))`.
 * A spread passes every token as a separate argument, so a single user message
 * of about a megabyte — a pasted log, a long brief — overflowed the stack and
 * threw `RangeError: Maximum call stack size exceeded` before the analyzer could
 * nominate anything. The failure was deterministic for that session, and its new
 * vocabulary never reached review.
 *
 * The regression is pinned at the largest unit a session can carry: one user
 * message with more tokens than the engine allows arguments.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import {
	lexiconCandidatesAnalyzer,
	LEXICON_CANDIDATES_DEF,
	type LexiconCandidatesProperties,
} from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";

/** Repeated prose: four distinct terms per sentence, 240,000 tokens in all. */
const HUGE_USER_TEXT = "some ordinary words here. ".repeat(60_000);

describe("lexicon-candidates on a session larger than the stack", () => {
	it("nominates the session instead of overflowing", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "huge");
			await insertMessages(db, "huge", [{ role: "user", text: HUGE_USER_TEXT }]);

			const llm = createMockLLM({
				responder: () => ({
					text: "x",
					structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "r" },
				}),
			});
			const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await framework.register(lexiconCandidatesAnalyzer);

			const summary = await framework.run("huge");
			assert.deepEqual(summary.errors, [], "the session is read, not reported as failed");
			assert.equal(summary.nodesProduced, 1);

			const nodes = await getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "huge");
			assert.equal(nodes.length, 1, "the session has a candidate list");
			const props = JSON.parse(nodes[0]!.content_json) as LexiconCandidatesProperties;
			assert.equal(props.user_message_count, 1);
			assert.equal(props.total_token_count, 240_000);
			assert.deepEqual(
				props.terms.map((t) => t.term).sort(),
				["here", "ordinary", "some", "words"],
			);
		} finally {
			await close();
		}
	});
});
