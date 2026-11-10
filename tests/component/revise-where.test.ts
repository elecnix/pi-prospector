/**
 * `reviseWhere`: a revise narrowed by what the prior node concluded.
 *
 * The scenario is a lexicon whose category list grew. Only the terms filed under
 * the category that split need a new verdict, so a run asks for the version
 * reason *and* a match on the prior verdict's category. Every other stale term
 * keeps its node and stays stale, and missing work is still filled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, classifyCallsFor } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import {
	frustrationLexiconAnalyzer,
	FRUSTRATION_LEXICON_DEF,
	type FrustrationLexiconProperties,
} from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import {
	turnFrustrationAnalyzer,
	TURN_FRUSTRATION_DEF,
	type TurnFrustrationProperties,
} from "../../src/analyze/analyzers/turn-frustration/index.js";
import type { Analyzer, LLMRequest } from "../../src/analyze/types.js";

/** A model's verdicts by term; anything unlisted is ordinary vocabulary. */
function lexiconModel(categories: Record<string, string>) {
	return createMockLLM({
		responder: (req: LLMRequest) => {
			const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const category = categories[term];
			return {
				text: "x",
				structured: {
					polarity: category ? "frustration" : "neutral",
					category: category ?? "none",
					language: "en",
					confidence: 0.9,
					rationale: "r",
				},
			};
		},
	});
}

/** The same analyzer one minor version back: what the graph was filled with. */
function previousMinor(analyzer: Analyzer): Analyzer {
	return { ...analyzer, version: { ...analyzer.version, minor: analyzer.version.minor - 1 } };
}

async function framework(db: AsyncDatabase, llm: ReturnType<typeof lexiconModel>, analyzers: Analyzer[]) {
	const fw = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
	for (const a of analyzers) await fw.register(a);
	return fw;
}

async function currentContent<T>(db: AsyncDatabase, analyzerId: string): Promise<T[]> {
	const rows = (await db
		.prepare("SELECT content_json FROM current_nodes WHERE analyzer_id = ? AND node_kind != 'error'")
		.all(analyzerId)) as Array<{ content_json: string }>;
	return rows.map((r) => JSON.parse(r.content_json) as T);
}

const BEFORE = { dumbass: "profanity", merde: "profanity", ugh: "dissatisfaction" };
const AFTER = { dumbass: "insult", merde: "profanity", ugh: "dissatisfaction" };

async function seedPreviousGeneration(db: AsyncDatabase): Promise<void> {
	await insertSession(db, "s1");
	await insertMessages(db, "s1", [
		{ role: "user", text: "ugh, dumbass, merde" },
		{ role: "assistant", text: "fixing" },
	]);
	const fw = await framework(db, lexiconModel(BEFORE), [
		turnPairCoreAnalyzer,
		lexiconCandidatesAnalyzer,
		previousMinor(frustrationLexiconAnalyzer),
		previousMinor(turnFrustrationAnalyzer),
	]);
	await fw.run("s1");
}

const CURRENT = [turnPairCoreAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer];

describe("reviseWhere narrows a revise by the prior node's content", () => {
	it("re-judges only the terms whose current verdict is profanity", async () => {
		const { db, close } = await tempDb();
		try {
			await seedPreviousGeneration(db);
			const llm = lexiconModel(AFTER);
			const fw = await framework(db, llm, CURRENT);

			await fw.run("s1", { revise: ["minor"], reviseWhere: [{ key: "category", raw: "profanity" }] });

			assert.equal(classifyCallsFor(llm, "dumbass"), 1, "a profanity term is re-judged");
			assert.equal(classifyCallsFor(llm, "merde"), 1, "a profanity term is re-judged");
			assert.equal(classifyCallsFor(llm, "ugh"), 0, "a term under another category keeps its verdict");
			assert.equal(classifyCallsFor(llm, "fixing"), 0, "assistant text is never nominated");

			const verdicts = new Map(
				(await currentContent<FrustrationLexiconProperties>(db, FRUSTRATION_LEXICON_DEF.id)).map((p) => [p.term, p.category]),
			);
			assert.equal(verdicts.get("dumbass"), "insult");
			assert.equal(verdicts.get("merde"), "profanity");
			assert.equal(verdicts.get("ugh"), "dissatisfaction");

			// The re-judged verdict is a new version beside the old one, never a mutation.
			const revises = (await db
				.prepare(
					"SELECT COUNT(*) AS n FROM analysis_edges e JOIN analysis_nodes n ON n.id = e.from_node_id " +
						"WHERE e.edge_kind = 'revises' AND n.analyzer_id = ?",
				)
				.get(FRUSTRATION_LEXICON_DEF.id)) as { n: number };
			assert.equal(revises.n, 2, "one revises edge per re-judged term");

			// Every other stale term is still stale: the filter only narrowed the run.
			const scan = await fw.scan("s1");
			const stillStale = scan
				.filter((c) => c.analyzerId === FRUSTRATION_LEXICON_DEF.id && c.status === "stale")
				.map((c) => (c.unit.meta as { term: string }).term);
			assert.ok(stillStale.includes("ugh"), "ugh is left stale for a later, wider revise");
			assert.ok(!stillStale.includes("dumbass") && !stillStale.includes("merde"));
		} finally {
			await close();
		}
	});

	it("refreshes the category a turn's hit copied from the re-judged verdict", async () => {
		const { db, close } = await tempDb();
		try {
			await seedPreviousGeneration(db);
			const fw = await framework(db, lexiconModel(AFTER), CURRENT);

			await fw.run("s1", { revise: ["minor"], reviseWhere: [{ key: "category", raw: "profanity" }] });

			const hits = new Map(
				(await currentContent<TurnFrustrationProperties>(db, TURN_FRUSTRATION_DEF.id))
					.filter((h) => h.signal_source === "lexicon")
					.map((h) => [h.signal, h.category]),
			);
			assert.equal(hits.get("dumbass"), "insult", "the hit carries the new category");
			assert.equal(hits.get("merde"), "profanity");
			assert.equal(hits.get("ugh"), "dissatisfaction", "a hit under another category is left alone");
		} finally {
			await close();
		}
	});

	it("still fills missing work, which no prior node can filter", async () => {
		const { db, close } = await tempDb();
		try {
			await seedPreviousGeneration(db);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [
				{ role: "user", text: "idiot" },
				{ role: "assistant", text: "fixing" },
			]);
			const llm = lexiconModel({ ...AFTER, idiot: "insult" });
			const fw = await framework(db, llm, CURRENT);

			await fw.run("s2", { revise: ["minor"], reviseWhere: [{ key: "category", raw: "profanity" }] });

			assert.equal(classifyCallsFor(llm, "idiot"), 1, "a term the corpus never judged is judged");
		} finally {
			await close();
		}
	});
});

/** The same analyzer at a chosen minor version, so a test can seed several generations. */
function atMinor(analyzer: Analyzer, minor: number): Analyzer {
	return { ...analyzer, version: { ...analyzer.version, minor } };
}

describe("reviseWhere reaches a category carried by an earlier generation", () => {
	/**
	 * The filter exists to narrow a version bump to the conclusions it can move.
	 * A hit's latest node was drawn by the old version, which copied the old
	 * category into it; when an intervening generation already moved the hit to a
	 * different category, the latest node no longer matches — yet the earlier
	 * generation is exactly the evidence the filter was aimed at. Leaving it out
	 * strands the hit below the current version until a whole-corpus revise.
	 */
	it("selects a version-stale hit whose latest node no longer carries the category", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "ugh, dumbass, merde" },
				{ role: "assistant", text: "fixing" },
			]);

			// Generation 0: every hit copies the categories of that day.
			const seed = await framework(db, lexiconModel(BEFORE), [
				turnPairCoreAnalyzer,
				lexiconCandidatesAnalyzer,
				atMinor(frustrationLexiconAnalyzer, 5),
				atMinor(turnFrustrationAnalyzer, 10),
			]);
			await seed.run("s1");

			// Generation 1: a scoped revise re-judges `dumbass` as `insult`, so the
			// hit's latest node now carries `insult` while its earlier one still
			// carries `profanity`.
			const middle = await framework(db, lexiconModel(AFTER), [
				turnPairCoreAnalyzer,
				lexiconCandidatesAnalyzer,
				atMinor(frustrationLexiconAnalyzer, 6),
				atMinor(turnFrustrationAnalyzer, 11),
			]);
			await middle.run("s1", { revise: ["minor"], reviseWhere: [{ key: "category", raw: "profanity" }] });

			// Generation 2 is current. The same filter must still reach that hit.
			const llm = lexiconModel(AFTER);
			const now = await framework(db, llm, CURRENT);
			await now.run("s1", { revise: ["minor"], reviseWhere: [{ key: "category", raw: "profanity" }] });

			const rows = (await db
				.prepare(
					"SELECT analyzer_version_id AS version, content_json FROM current_nodes " +
						"WHERE analyzer_id = ? AND node_kind != 'error'",
				)
				.all(TURN_FRUSTRATION_DEF.id)) as Array<{ version: string; content_json: string }>;
			const hits = new Map(
				rows.map((r) => {
					const props = JSON.parse(r.content_json) as TurnFrustrationProperties;
					return [props.signal, { version: r.version, category: props.category }];
				}),
			);
			assert.deepEqual(
				hits.get("dumbass"),
				{ version: "1.12", category: "insult" },
				"a hit whose earlier node carried profanity is redrawn",
			);
			assert.equal(hits.get("merde")?.version, "1.12", "a hit whose latest node carries profanity is redrawn");
			assert.equal(hits.get("ugh")?.version, "1.10", "a hit that never carried profanity is left stale");
			assert.equal(classifyCallsFor(llm, "dumbass"), 1, "its term is re-judged too");
			assert.equal(classifyCallsFor(llm, "ugh"), 0, "a term that never carried profanity is left alone");
		} finally {
			await close();
		}
	});
});
