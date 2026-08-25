/**
 * Multi-word lexicon phrases (#40).
 *
 * A phrase is just another corpus-keyed subject: nominated from adjacent tokens
 * within a sentence segment under its own tight cap, judged by exactly the same
 * pipeline as a word (source ref still `{kind: "term", id: "laisse tomber"}`),
 * and matched at turn level over the same token stream. The properties pinned
 * here:
 *
 * 1. Nomination ranks bigrams by frequency and caps them independently of words.
 * 2. The corpus-wide cache works for phrases — judged once for every session.
 * 3. The French case that motivated the issue fires as phrase hits where every
 *    single token is silent.
 * 4. Overlap is additive in existence but longest-match-preferred in weight.
 * 5. Re-running through the framework produces nothing new.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import {
	lexiconCandidatesAnalyzer,
	LEXICON_CANDIDATES_DEF,
	type LexiconCandidatesProperties,
} from "../../src/analyze/analyzers/lexicon-candidates/index.js";
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
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { computeSourceSetHash } from "../../src/analyze/input-hash.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** Entries our stub model calls frustration; everything else comes back neutral. */
const FRUSTRATED_ENTRIES = new Set(["putain", "laisse tomber", "trop lent", "tomber"]);

function phraseMock() {
	return createMockLLM({
		responder: (req: LLMRequest) => {
			const entry = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const frustrated = FRUSTRATED_ENTRIES.has(entry);
			return {
				text: "x",
				structured: {
					polarity: frustrated ? "frustration" : "neutral",
					category: frustrated ? "dissatisfaction" : "none",
					language: frustrated ? "fr" : "und",
					confidence: 0.9,
					rationale: frustrated ? "disengaged dissatisfaction" : "ordinary vocabulary",
				},
			};
		},
	});
}

/** Adjudications of exactly one entry, matched exactly so `laisse` never counts for `laisse tomber`. */
function callsFor(llm: ReturnType<typeof phraseMock>, entry: string): number {
	return llm.calls.filter((c) => c.tool?.name === "classify_term" && c.user === `TERM: ${entry}`).length;
}

async function frameworkFor(
	db: Parameters<typeof getNodesByAnalyzer>[0],
	llm: ReturnType<typeof phraseMock>,
	configOverrides?: Record<string, Record<string, unknown>>,
) {
	const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS, configOverrides });
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	await framework.register(turnFrustrationAnalyzer);
	return framework;
}

describe("phrase nomination (#40)", () => {
	it("nominates adjacent bigrams ranked by frequency, alongside terms", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "laisse tomber. laisse tomber, vraiment" },
				{ role: "assistant", text: "ok" },
			]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1", { analyzerIds: [LEXICON_CANDIDATES_DEF.id] });

			const props = JSON.parse(
				((await getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "s1"))[0])!.content_json,
			) as LexiconCandidatesProperties;
			assert.equal(props.phrases.length > 0, true, "bigrams are nominated");
			assert.deepEqual(props.phrases[0], { term: "laisse tomber", count: 2 }, "ranked by frequency");
			assert.ok(props.phrases.some((p) => p.term === "tomber vraiment"), true);
			assert.equal(props.phrases.every((p) => !p.term.includes(".")), true, "no phrase bridges a sentence");
			assert.equal(props.terms.length, 3, "words keep their own list");
		} finally {
			await close();
		}
	});

	it("caps phrases per session without touching the term cap", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "aa bb cc dd ee ff gg hh" }]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm, { [LEXICON_CANDIDATES_DEF.id]: { maxPhrasesPerSession: 2 } });
			await framework.run("s1", { analyzerIds: [LEXICON_CANDIDATES_DEF.id] });

			const props = JSON.parse(
				((await getNodesByAnalyzer(db, LEXICON_CANDIDATES_DEF.id, "s1"))[0])!.content_json,
			) as LexiconCandidatesProperties;
			assert.equal(props.phrases.length, 2, "the phrase cap binds");
			assert.equal(props.terms.length, 8, "the term cap does not");
		} finally {
			await close();
		}
	});
});

describe("phrase adjudication (#40)", () => {
	it("judges a phrase through the same pipeline, keyed on its term-kind source ref", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "bon je laisse tomber alors" }, { role: "assistant", text: "ok" }]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");

			const nodes = await getNodesByAnalyzer(db, FRUSTRATION_LEXICON_DEF.id, "s1");
			const verdicts = nodes.map((n) => JSON.parse(n.content_json) as FrustrationLexiconProperties);
			const phraseVerdict = verdicts.find((v) => v.term === "laisse tomber");
			assert.ok(phraseVerdict, "the phrase was adjudicated");
			assert.equal(phraseVerdict!.polarity, "frustration");

			// The unit's source set is the phrase alone — same `term` kind as any word.
			const expectedHash = computeSourceSetHash([{ kind: "term", id: "laisse tomber" }]);
			const phraseNode = nodes.find((n) => (JSON.parse(n.content_json) as FrustrationLexiconProperties).term === "laisse tomber")!;
			assert.equal(phraseNode.source_set_hash, expectedHash, "source ref carries the phrase id");
		} finally {
			await close();
		}
	});

	it("caches a phrase verdict corpus-wide, once", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "je laisse tomber" }, { role: "assistant", text: "ok" }]);
			await insertSession(db, "s2");
			await insertMessages(db, "s2", [{ role: "user", text: "laisse tomber, franchement" }, { role: "assistant", text: "ok" }]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");
			await framework.run("s2");

			assert.equal(callsFor(llm, "laisse tomber"), 1, "adjudicated once for the whole corpus");
			assert.equal(callsFor(llm, "laisse"), 1, "the word was judged separately, as itself");
		} finally {
			await close();
		}
	});
});

describe("phrase matching (#40)", () => {
	it("detects laisse tomber / trop lent where single tokens stay silent", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "bon je laisse tomber. c'est trop lent." },
				{ role: "assistant", text: "ok" },
			]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");

			const hits = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))
				.map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties)
				.filter((h) => h.signal_source === "lexicon");
			// Every component word came back neutral except `tomber`, which the stub
			// judges frustrated; its only occurrence here sits inside the phrase span,
			// so longest-match-preferred prices it at zero while the phrase carries
			// the signal.
			const weighted = hits.filter((h) => h.weight > 0);
			assert.deepEqual(weighted.map((h) => h.signal).sort(), ["laisse tomber", "trop lent"]);
			const subsumedTomber = hits.find((h) => h.signal === "tomber");
			if (subsumedTomber) assert.equal(subsumedTomber.weight, 0, "the covered word adds no weight");
			assert.equal(weighted.every((h) => h.polarity === "frustration"), true);
			assert.equal(weighted.every((h) => h.language === "fr"), true);
		} finally {
			await close();
		}
	});
});

describe("overlap policy (#40)", () => {
	it("emits both hits when a term and an extending phrase match, but weights longest-match-preferred", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "bon je laisse tomber" }, { role: "assistant", text: "ok" }]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");

			const hits = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))
				.map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties)
				.filter((h) => h.signal_source === "lexicon");
			const phraseHit = hits.find((h) => h.signal === "laisse tomber");
			const termHit = hits.find((h) => h.signal === "tomber");

			assert.ok(phraseHit, "existence stays additive: both hits exist");
			assert.ok(termHit, "the subsumed term hit is still recorded");
			assert.equal(phraseHit!.weight, 0.5, "the longest match carries full weight");
			assert.equal(termHit!.weight, 0, "a fully-covered shorter match carries no weight");
			assert.equal(termHit!.count, 1, "the occurrence count survives weighting");
		} finally {
			await close();
		}
	});

	it("keeps full weight when some occurrences stand outside any phrase span", async () => {
		const { db, close } = await tempDb();
		try {
			// Tokens: laisse(0) tomber(1) ou(2) tomber(3). The first `tomber` is
			// covered by the phrase span [0,2); the second stands free — the
			// all-or-nothing rule therefore pays the term in full.
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "laisse tomber ou tomber" }, { role: "assistant", text: "ok" }]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");

			const hits = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1"))
				.map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties)
				.filter((h) => h.signal_source === "lexicon");
			const termHit = hits.find((h) => h.signal === "tomber")!;
			const phraseHit = hits.find((h) => h.signal === "laisse tomber")!;
			assert.equal(termHit.count, 2);
			assert.equal(termHit.weight, 0.5, "partially covered → not subsumed → full weight");
			assert.equal(phraseHit.weight, 0.5);
		} finally {
			await close();
		}
	});
});

describe("phrase idempotency (#40)", () => {
	it("re-running a session that learned phrases produces nothing new", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [{ role: "user", text: "je laisse tomber, c'est trop lent" }, { role: "assistant", text: "ok" }]);

			const llm = phraseMock();
			const framework = await frameworkFor(db, llm);
			await framework.run("s1");
			const spent = llm.calls.length;
			const before = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).map((n) => n.id);

			const summary = await framework.run("s1");
			assert.equal(summary.nodesProduced, 0, "re-run produces nothing");
			assert.equal(llm.calls.length, spent, "and re-adjudicates nothing");
			assert.deepEqual(
				(await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).map((n) => n.id),
				before,
				"the same hit nodes remain",
			);
			const scan = await framework.scan("s1");
			assert.deepEqual(scan.filter((u) => u.status !== "current"), [], "everything classifies current");
		} finally {
			await close();
		}
	});
});
