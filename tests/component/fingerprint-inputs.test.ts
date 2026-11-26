import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";
import { fingerprintOf, leakedSentinels, sectionOf, type Section } from "./fingerprint-seed.js";

/**
 * The sections of analyzers that feed another one, or that judge the corpus and
 * not a session. `hunter2` stands for the text each must never publish.
 */

async function built(kind: "objective" | "inferred", id: string, seed: (g: GraphSeed) => Promise<void>): Promise<Section> {
	const g = await GraphSeed.open();
	try {
		await seed(g);
		const fp = await fingerprintOf(g.t.db);
		assert.deepEqual(leakedSentinels(fp), []);
		return sectionOf(fp, kind, id);
	} finally {
		await g.close();
	}
}

/** Six sessions, one node each. */
const six = (analyzer: string, content: (i: number) => unknown, version = "1.0") => async (g: GraphSeed) => {
	for (let i = 0; i < 6; i++) await g.analysed(`s${i}`, analyzer, content(i), version);
};
const WITHHELD = { status: "withheld", reason: "below-min-group-size" };

describe("fingerprint: vocabulary", () => {
	it("publishes counts of words and never a word", async () => {
		const s = await built("objective", "vocabulary", async (g) => {
			await six("lexicon-candidates", () => ({ terms: [{ term: "hunter2", count: 3 }], phrases: [{ term: "hunter2 x", count: 1 }], user_message_count: 2, distinct_token_count: 60, total_token_count: 100 }), "1.4")(g);
			await g.analysed("quiet", "lexicon-candidates", null, "1.4");
		});
		assert.equal(s.sessionsMeasured, 7);
		assert.equal(s["messagesRead"], 12);
		assert.equal(s["words"], 600);
		assert.equal((s["distinctWords"] as { p50: number }).p50, 60);
	});
});

describe("fingerprint: learned lexicon", () => {
	const verdict = (polarity: string, category: string, language: string) => ({ term: "hunter2", rationale: "hunter2", polarity, category, language, confidence: 0.9 });

	it("counts judged terms by polarity and language, and signal terms by category", async () => {
		const s = await built("inferred", "lexicon", async (g) => {
			await six("frustration-lexicon", () => verdict("neutral", "none", "fr"), "1.7")(g);
			for (let i = 0; i < 6; i++) await g.node(`s${i}`, "frustration-lexicon", verdict("frustration", "insult", "hunter2"), "1.7");
		});
		assert.equal(s["termsJudged"], 12);
		assert.equal(s["signalTerms"], 6);
		assert.deepEqual(s["byPolarity"], [
			{ polarity: "frustration", count: 6, sessions: 6 },
			{ polarity: "neutral", count: 6, sessions: 6 },
		]);
		assert.deepEqual(s["byLanguage"], [
			{ language: "fr", count: 6, sessions: 6 },
			{ language: "other", count: 6, sessions: 6 },
		]);
		assert.deepEqual(s["byCategory"], [{ category: "insult", count: 6, sessions: 6 }]);
	});

	it("is withheld, not zero, when the analyzer ran and judged nothing", async () => {
		assert.deepEqual(await built("inferred", "lexicon", six("frustration-lexicon", () => null)), WITHHELD);
	});
});

describe("fingerprint: verification commands", () => {
	it("counts judged commands by verdict", async () => {
		const s = await built("inferred", "verificationCommands", six("verification-commands", () => ({ command: "hunter2", verdict: "full", confidence: 0.9 })));
		assert.equal(s["commandsJudged"], 6);
		assert.deepEqual(s["byVerdict"], [{ verdict: "full", count: 6, sessions: 6 }]);
	});

	it("is withheld when no decision model judged anything", async () => {
		assert.deepEqual(await built("inferred", "verificationCommands", six("verification-commands", () => null)), WITHHELD);
	});
});

describe("fingerprint: rule restatement", () => {
	it("counts judged proposals by status", async () => {
		const s = await built("inferred", "ruleRestatement", six("rule-restatement", (i) => ({ proposal_input_key: `p${i}`, rule_status: i < 5 ? "gap" : "restated", rule_path: "/home/secret/path", rule_quote: "hunter2", corpus: [] })));
		assert.equal(s["proposalsJudged"], 6);
		// The one restated proposal rests on too few sessions to publish.
		assert.deepEqual(s["byStatus"], [{ status: "gap", count: 5, sessions: 5 }]);
	});
});

describe("fingerprint: regression prevention", () => {
	const verdict = (over: object) => ({ fixes_defect: true, is_regression: true, cause: "hunter2", cause_class: "missing_test", prevention: "hunter2", prevention_class: "add_regression_test", confidence: 0.8, ...over });

	it("applies the synthesis's rules to the verdicts in scope", async () => {
		const s = await built("inferred", "regressionPrevention", async (g) => {
			await six("regression-verdict", () => verdict({}), "1.1")(g);
			await g.analysed("low", "regression-verdict", verdict({ confidence: 0.3 }), "1.1");
			await g.analysed("new", "regression-verdict", verdict({ is_regression: false }), "1.1");
			await g.analysed("old", "regression-verdict", verdict({}), "1.0");
		});
		assert.equal(s.sessionsMeasured, 8);
		assert.equal(s["regressionsCounted"], 6);
		assert.equal(s["recurringClasses"], 1);
		assert.deepEqual(s["byCauseClass"], [{ causeClass: "missing_test", count: 6, sessions: 6 }]);
	});
});

describe("fingerprint: repeats", () => {
	const cluster = (detector: string, exact: boolean, ...hashes: string[]) => ({
		detector,
		size: hashes.length,
		avg_similarity: 1,
		exact,
		members: hashes.map((normalized_hash) => ({ session_id: "s0", message_id: "m", turn_ordinal: 0, normalized_hash, excerpt: "hunter2" })),
		similarities: [],
	});

	it("counts a cluster once however many sessions report it", async () => {
		const s = await built("objective", "repeats", six("similarity-cluster", (i) => ({
			clusters: [cluster("user_prompt", true, "aa", "aa", "aa"), i % 2 ? cluster("tool_call", false, "bb", "cc") : cluster("tool_call", false, "cc", "bb")],
		})));
		assert.equal(s["sessionsReportingAny"], 6);
		assert.equal(s["clusters"], 2);
		assert.deepEqual(s["byKind"], [
			{ kind: "tool_call", match: "near", count: 1, sessions: 6 },
			{ kind: "user_prompt", match: "exact", count: 1, sessions: 6 },
		]);
	});
});

describe("fingerprint: decode collapse", () => {
	const node = (collapsed_count: number | null) => ({
		document_count: 10,
		collapsed_count,
		collapsed_documents: collapsed_count ? [{ message_id: "hunter2", field: "thinking", model: "hunter2", answer_empty: true, control_tokens: ["hunter2"] }] : [],
	});

	it("counts collapsed texts, and leaves out a session whose corpus was too small to judge", async () => {
		const s = await built("objective", "decodeCollapse", async (g) => {
			await six("decode-collapse", () => node(1))(g);
			await g.analysed("clean", "decode-collapse", node(0));
			await g.analysed("unknown", "decode-collapse", node(null));
		});
		assert.equal(s.sessionsMeasured, 7);
		assert.equal(s["textsScored"], 70);
		assert.equal(s["textsCollapsed"], 6);
		assert.equal(s["sessionsWithCollapse"], 6);
		assert.deepEqual(s["collapsedByText"], [{ text: "thinking", answer: "empty", count: 6, sessions: 6 }]);
	});
});

describe("fingerprint: message answers", () => {
	const answer = (choice: string) => ({ type: "choice", choice, confidence: 0.9, probabilities: {} });

	it("counts answers by question and option, and hides a question it does not know", async () => {
		const s = await built("inferred", "messageAnswers", six("message-answers", () => ({
			user_message_id: "hunter2",
			answers: { "prompt-kind.v1": answer("question"), "hunter2.v1": answer("question"), "yes-no.v1": { type: "noul", noul: 1 } },
			asked: {},
		})));
		assert.equal(s["messagesAsked"], 6);
		assert.deepEqual(s["byAnswer"], [
			{ question: "other", choice: "other", count: 6, sessions: 6 },
			{ question: "prompt-kind.v1", choice: "question", count: 6, sessions: 6 },
		].sort((a, b) => a.question.localeCompare(b.question)));
	});

	it("is withheld when no decision model answered", async () => {
		assert.deepEqual(await built("inferred", "messageAnswers", six("message-answers", () => null)), WITHHELD);
	});
});
