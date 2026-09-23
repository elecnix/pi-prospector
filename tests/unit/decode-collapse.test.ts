/**
 * Unit tests for the decode-collapse model and reference corpus (issue #277):
 * pure functions over synthetic text, no database.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NgramCounts, NgramModel, median, quantile, shingles, tokenize } from "../../src/analyze/analyzers/decode-collapse/ngram.js";
import { extractDocuments, type GenerationDocument } from "../../src/analyze/analyzers/decode-collapse/documents.js";
import { ReferenceCorpus } from "../../src/analyze/analyzers/decode-collapse/reference.js";
import { DEFAULT_DECODE_COLLAPSE_CONFIG as CONFIG } from "../../src/analyze/analyzers/decode-collapse/config.js";
import { coherentText, collapsedText, prng } from "../fixtures/decode-collapse-text.js";

function countsOf(order: number, texts: string[]): NgramCounts {
	const counts = new NgramCounts(order);
	for (const t of texts) counts.addDocument(tokenize(t, 10_000));
	return counts;
}

function assistant(id: string, thinking: string | null, text: string | null = null) {
	return { id, role: "assistant", content_text: text, content_thinking: thinking, tool_calls: null, model: "prov/model-a" };
}

function sessionDocs(sessionId: string, rand: () => number, count: number): GenerationDocument[] {
	const rows = Array.from({ length: count }, (_, i) => assistant(`${sessionId}-m${i}`, coherentText(rand), "Done."));
	return extractDocuments(rows, CONFIG);
}

describe("decode-collapse tokenize", () => {
	it("lowercases, splits punctuation, and gives each CJK character its own token", () => {
		assert.deepEqual(tokenize("Read the Config.\n\n这件 x", 100), [["read", "the", "config", "."], ["这", "件", "x"]]);
	});

	it("keeps at most maxTokens tokens, from the start", () => {
		assert.deepEqual(tokenize("a b c\nd e f", 4), [["a", "b", "c"], ["d"]]);
	});
});

describe("decode-collapse n-gram model", () => {
	const texts = ["the cat sat on the mat", "the dog sat on the log", "a cat and a dog"];

	it("is a proper distribution over the vocabulary plus one unseen-word slot", () => {
		const counts = countsOf(3, texts);
		const model = new NgramModel(counts, 0.75);
		const vocabulary = [...counts.grams.keys()].filter((k) => !k.includes("\u0001"));
		for (const history of [["<s>", "<s>"], ["<s>", "the"], ["sat", "on"], ["never", "seen"]]) {
			const total = vocabulary.reduce((sum, w) => sum + model.probability(history, w), 0) + model.probability(history, "zzz-unseen");
			assert.ok(Math.abs(total - 1) < 1e-9, `sums to 1 after ${history.join(" ")}: ${total}`);
		}
	});

	it("subtracting a document's counts scores exactly as a model that never saw it", () => {
		const extra = "the bird sat on the fence";
		const without = new NgramModel(countsOf(3, texts), 0.75);
		const subtracted = new NgramModel(countsOf(3, [...texts, extra]), 0.75, countsOf(3, [extra]));
		for (const line of [["the", "bird", "sat"], ["the", "cat", "sat", "on", "the", "fence"], ["a", "dog"]]) {
			assert.ok(Math.abs(without.linePerplexity(line) - subtracted.linePerplexity(line)) < 1e-9, line.join(" "));
		}
	});

	it("refuses to subtract counts it does not hold", () => {
		assert.throws(() => new NgramModel(countsOf(3, texts), 0.75, countsOf(3, ["an unseen line"])), /not a subset/);
	});

	it("scores coherent text far below collapsed text", () => {
		const rand = prng(7);
		const train = Array.from({ length: 200 }, () => coherentText(rand));
		const model = new NgramModel(countsOf(3, train), 0.75);
		const coherent = model.documentScore(tokenize(coherentText(rand), 2000), 4);
		const collapsed = model.documentScore(tokenize(collapsedText(rand), 2000), 4);
		assert.ok(collapsed > coherent * 50, `collapsed ${collapsed} vs coherent ${coherent}`);
	});

	it("takes the median over lines, so one foreign block does not condemn a coherent turn", () => {
		const rand = prng(11);
		const model = new NgramModel(countsOf(3, Array.from({ length: 200 }, () => coherentText(rand))), 0.75);
		const quoted = `${coherentText(rand, 4)}\n${collapsedText(rand, 1)}`;
		const pure = model.documentScore(tokenize(coherentText(rand, 4), 2000), 4);
		assert.ok(model.documentScore(tokenize(quoted, 2000), 4) < pure * 3);
	});
});

describe("decode-collapse statistics", () => {
	it("median and nearest-rank quantile", () => {
		assert.equal(median([3, 1, 2]), 2);
		assert.equal(median([4, 1, 2, 3]), 2.5);
		assert.equal(quantile([5, 1, 4, 2, 3], 1), 5);
		assert.equal(quantile([5, 1, 4, 2, 3], 0.5), 3);
		assert.throws(() => median([]));
	});

	it("shingles run across line boundaries", () => {
		assert.deepEqual(shingles([["a", "b"], ["c"]], 2), ["a\u0001b", "b\u0001c"]);
	});
});

describe("decode-collapse documents", () => {
	it("cuts reasoning and answer into separate documents, flags an empty answer and leaked control tokens", () => {
		const rand = prng(3);
		const docs = extractDocuments([assistant("m1", collapsedText(rand), "")], CONFIG);
		assert.equal(docs.length, 1);
		assert.equal(docs[0]!.field, "thinking");
		assert.equal(docs[0]!.answer_empty, true);
		assert.ok(docs[0]!.control_tokens.length > 0);
		assert.ok(docs[0]!.control_tokens.every((t) => /^<[^>]+>$/.test(t)));
	});

	it("a message that called a tool did answer", () => {
		const rand = prng(4);
		const row = { ...assistant("m1", coherentText(rand)), tool_calls: JSON.stringify([{ name: "bash" }]) };
		assert.equal(extractDocuments([row], CONFIG)[0]!.answer_empty, false);
	});

	it("skips documents under the token minimum", () => {
		assert.equal(extractDocuments([assistant("m1", "ok, done")], CONFIG).length, 0);
	});
});

describe("decode-collapse reference corpus", () => {
	function corpus(sessions: number, withCollapse?: string) {
		const rand = prng(99);
		const list = Array.from({ length: sessions }, (_, i) => ({ id: `s${String(i).padStart(2, "0")}`, documents: sessionDocs(`s${i}`, rand, 8) }));
		if (withCollapse) {
			const docs = extractDocuments([assistant(`${withCollapse}-bad`, collapsedText(rand), "")], CONFIG);
			list.find((s) => s.id === withCollapse)!.documents.push(...docs);
		}
		return list;
	}

	it("keeps collapsed documents out of training and calibration, with no labels", () => {
		const reference = new ReferenceCorpus(corpus(20, "s03"), CONFIG);
		const scorer = reference.scorerFor("s03");
		assert.equal(scorer.coverage.filtered_documents, 1);
		assert.ok(scorer.ready);
	});

	it("flags a collapsed document of a session inside the reference, scored without its own counts", () => {
		const sessions = corpus(20, "s03");
		const reference = new ReferenceCorpus(sessions, CONFIG);
		const scorer = reference.scorerFor("s03");
		const bad = sessions.find((s) => s.id === "s03")!.documents.at(-1)!;
		assert.equal(scorer.crossSessionShare(bad.tokens), 0);
		assert.ok(scorer.score(bad.tokens)! > scorer.calibration!.threshold);
		for (const doc of sessions.find((s) => s.id === "s03")!.documents.slice(0, -1)) {
			assert.ok(scorer.score(doc.tokens)! <= scorer.calibration!.threshold * 3, "coherent siblings stay near the held-out range");
		}
	});

	it("a held-out session's own documents never set its threshold", () => {
		const reference = new ReferenceCorpus(corpus(20), CONFIG);
		const heldOut = reference.sourceRefs.find((r) => r.id.endsWith(":held"))!.id.split("#")[0]!;
		const own = reference.scorerFor(heldOut).calibration!;
		const other = reference.scorerFor("not-in-reference").calibration!;
		assert.ok(own.held_out_documents < other.held_out_documents);
	});

	it("reports an insufficient corpus instead of guessing", () => {
		const scorer = new ReferenceCorpus(corpus(4), CONFIG).scorerFor("s00");
		assert.equal(scorer.ready, false);
		assert.equal(scorer.score([["a", "b"]]), null);
		assert.equal(scorer.calibration, null);
	});

	it("is a pure function of its sessions", () => {
		assert.equal(new ReferenceCorpus(corpus(12), CONFIG).fingerprint, new ReferenceCorpus(corpus(12), CONFIG).fingerprint);
	});
});
