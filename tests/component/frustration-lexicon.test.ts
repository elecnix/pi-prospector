/**
 * The learned frustration lexicon: nomination, corpus-wide caching, and turn hits.
 *
 * The central property under test is that the analysis graph *is* the dictionary.
 * A word is adjudicated by a model exactly once for the whole corpus, because a
 * unit keyed on the word alone has one `input_key` everywhere and `input_key` is
 * unique table-wide.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, lexiconMock, classifyCallsFor } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { lexiconCandidatesAnalyzer, LEXICON_CANDIDATES_DEF } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import {
	frustrationLexiconAnalyzer,
	FRUSTRATION_LEXICON_DEF,
	type FrustrationLexiconProperties,
} from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";

/** Terms our stub model calls frustration; everything else comes back neutral. */
const FRUSTRATED_TERMS = new Set(["putain", "faux", "wrong", "🤬"]);

async function frameworkFor(db: Parameters<typeof getNodesByAnalyzer>[0], llm: ReturnType<typeof lexiconMock>) {
	const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	return framework;
}


describe("lexicon-candidates", () => {
	it("nominates the user's vocabulary, ranked and capped, ignoring assistant text", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "wrong wrong again" },
				{ role: "assistant", text: "apologies, correcting the mistake now" },
				{ role: "user", text: "still wrong" },
			]);

			const llm = lexiconMock(FRUSTRATED_TERMS);
			const framework = await frameworkFor(db, llm);
			await framework.run("s1", { analyzerIds: [LEXICON_CANDIDATES_DEF.id] });

			const nodes = await getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "s1");
			assert.equal(nodes.length, 1, "one nomination node per session");
			const props = JSON.parse(nodes[0]!.content_json) as { terms: Array<{ term: string; count: number }> };
			assert.deepEqual(props.terms[0], { term: "wrong", count: 3 });
			const terms = props.terms.map((t) => t.term);
			assert.equal(terms.includes("again"), true);
			assert.equal(terms.includes("apologies"), false, "assistant vocabulary is never nominated");
		} finally {
			await close();
		}
	});
});

describe("frustration-lexicon", () => {
	it("adjudicates each term once and stores the verdict as a node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain c'est encore faux" }]);

			const llm = lexiconMock(FRUSTRATED_TERMS);
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");

			const termNodes = await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1");
			const byTerm = new Map(
				termNodes.map((n) => {
					const p = JSON.parse(n.content_json) as FrustrationLexiconProperties;
					return [p.term, p];
				}),
			);

			assert.equal(byTerm.get("putain")?.polarity, "frustration");
			assert.equal(byTerm.get("faux")?.polarity, "frustration");
			assert.equal(byTerm.get("encore")?.polarity, "neutral");
			assert.equal(classifyCallsFor(llm, "putain"), 1);
		} finally {
			await close();
		}
	});

	it("re-running a session costs nothing — every term is already current", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain c'est encore faux" }]);

			const llm = lexiconMock(FRUSTRATED_TERMS);
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");
			const afterFirst = llm.calls.length;
			assert.ok(afterFirst > 0, "the first run adjudicates");

			await framework.run("s1");
			assert.equal(llm.calls.length, afterFirst, "the second run makes no model calls at all");
		} finally {
			await close();
		}
	});

	it("THE CACHE: a term adjudicated in one session is free in every other", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain c'est faux" }]);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "putain, toujours faux" }]);

			const llm = lexiconMock(FRUSTRATED_TERMS);
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");
			await framework.run("s2");

			assert.equal(classifyCallsFor(llm, "putain"), 1, "adjudicated once for the whole corpus");
			assert.equal(classifyCallsFor(llm, "faux"), 1);
			assert.equal(classifyCallsFor(llm, "toujours"), 1, "a term new to s2 is still adjudicated");

			// The verdict lives in exactly one node, owned by the session that paid for it.
			const s1Terms = (await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1"))
				.map((n) => (JSON.parse(n.content_json) as FrustrationLexiconProperties).term);
			const s2Terms = (await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s2"))
				.map((n) => (JSON.parse(n.content_json) as FrustrationLexiconProperties).term);
			assert.equal(s1Terms.includes("putain"), true);
			assert.equal(s2Terms.includes("putain"), false, "s2 reuses s1's verdict rather than making its own");
			assert.equal(s2Terms.includes("toujours"), true);
		} finally {
			await close();
		}
	});

	it("anchors a term node to the session that triggered its classification", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);

			const llm = lexiconMock(FRUSTRATED_TERMS);
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");

			const node = (await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1"))[0]!;
			const edges = (await db
				.prepare("SELECT to_ref_kind, to_ref_id, edge_kind FROM analysis_edges WHERE from_node_id = ?")
				.all(node.id)) as unknown as Array<{ to_ref_kind: string; to_ref_id: string; edge_kind: string }>;
			assert.ok(
				edges.some((e) => e.edge_kind === "anchors" && e.to_ref_kind === "session" && e.to_ref_id === "s1"),
				"the term links back to the session that surfaced it",
			);
		} finally {
			await close();
		}
	});

	it("survives two sessions racing to adjudicate the same new term", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "putain" }]);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "putain" }]);

			const llm = lexiconMock(FRUSTRATED_TERMS);
			const framework = await frameworkFor(db, llm);
			// Concurrent runs mirror how `prospect analyze` fans sessions out. Both see
			// the term as missing and both insert the same input_key; the loser must
			// treat that as "already done", not as a failure.
			await Promise.all([framework.run("s1"), framework.run("s2")]);

			const errors = (await db
				.prepare("SELECT COUNT(*) AS n FROM analysis_nodes WHERE node_kind = 'error'")
				.get()) as unknown as { n: number };
			assert.equal(errors.n, 0, "an identity collision is idempotency, not an error");

			const putain = (await db
				.prepare(
					"SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = ? AND content_json LIKE '%\"putain\"%'",
				)
				.get(FRUSTRATION_LEXICON_DEF.id)) as unknown as { n: number };
			assert.equal(putain.n, 1, "exactly one verdict node exists for the term");
		} finally {
			await close();
		}
	});
});
