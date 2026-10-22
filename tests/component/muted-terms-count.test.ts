/**
 * A muted term stops counting in the operator-facing views (issue #321).
 *
 * The mute machinery itself — the `mutes` edge, the current-node predicate, and
 * the accumulation dropping a silenced hit's weight — is covered by
 * `mutes.test.ts`. What is left here is the two surfaces the operator reads
 * directly: the frustration ranking (`prospect nodes --counts signal`) and the
 * node listing. Both go through `pricedHits`, so they also honour term
 * specificity, and a background word must not appear in either for the same
 * reason a muted one must not: no reader counts it.
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
import { frictionAccumulationAnalyzer } from "../../src/analyze/analyzers/friction-accumulation/index.js";
import { readNodes } from "../../src/commands/nodes.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { muteTerm, unmuteTerm } from "../../src/commands/mutes.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** The one term our stub model calls frustration. */
const FRUSTRATED_TERMS = new Set(["putain"]);

/** A session whose only lexicon hit is the term the operator will mute. */
const MESSAGES = [
	{ role: "user" as const, text: "putain the parser is broken" },
	{ role: "assistant" as const, text: "Fixed." },
];

async function build(db: Parameters<typeof getNodesByAnalyzer>[0]) {
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
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	await framework.register(turnFrustrationAnalyzer);
	await framework.register(frictionAccumulationAnalyzer);
	return framework;
}

describe("a muted term stops counting", () => {
	it("keeps a muted term out of the frustration ranking, and unmuting puts it back", async () => {
		// The ranking is the operator-facing view of the corpus's loudest signals.
		// A muted term must not appear in it, or the mute achieves nothing the
		// operator can see.
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");

			const ranking = async () => {
				const result = await readNodes(db, {
					analyzerId: TURN_FRUSTRATION_DEF.id,
					filters: [],
					counts: "signal",
				});
				return result.text
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.startsWith("putain:"))
					.map((l) => l.split(":")[0]!);
			};
			assert.deepEqual(await ranking(), ["putain"], "the term is ranked before the mute");

			await muteTerm(db, { term: "putain", by: "operator" });
			await framework.run("s1", { revise: ["config"] });
			assert.deepEqual(await ranking(), [], "a muted term is not ranked");

			await unmuteTerm(db, "putain");
			await framework.run("s1", { revise: ["config"] });
			assert.deepEqual(await ranking(), ["putain"], "unmuting puts the term back, exactly once");
		} finally {
			await close();
		}
	});

	it("keeps a muted term out of a listing across every analyzer", async () => {
		// `prospect nodes --all` reads every analyzer's nodes, so the mute has to
		// be honoured there too, or the operator sees the term in one listing and
		// not in the other.
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");
			await muteTerm(db, { term: "putain", by: "operator" });
			await framework.run("s1", { revise: ["config"] });

			const result = await readNodes(db, { all: true, filters: [] });
			const signals = result.rows
				.filter((r) => r.analyzer_id === TURN_FRUSTRATION_DEF.id)
				.map((r) => (JSON.parse(r.content_json) as { signal: string }).signal);
			assert.deepEqual(signals, [], "a muted term appears in no listing");
		} finally {
			await close();
		}
	});
});
