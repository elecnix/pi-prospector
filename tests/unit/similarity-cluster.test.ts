/**
 * Unit tests for the similarity-cluster analyzer's pure pipeline and
 * tokenisers (issue #145). No DB, no LLM, no fixtures — hand-written strings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenizePrompt, tokenizeResult, tokenizeToolCall } from "../../src/analyze/analyzers/similarity-cluster/tokenize.js";
import {
	clusterItems,
	lcsLength,
	rankFindings,
	hashTokens,
	type ClusterItem,
	type DetectorParams,
} from "../../src/analyze/analyzers/similarity-cluster/pipeline.js";

function item(key: string, tokens: string[]): ClusterItem {
	return {
		key,
		sessionId: `s-${key}`,
		messageId: `m-${key}`,
		turnOrdinal: 0,
		tokens,
		hash: hashTokens(tokens),
	};
}

const CALL_PARAMS: DetectorParams = { shingleWidth: 4, threshold: 0.15, nominateWith: 12, maxFreq: 50, minTokens: 6 };
const RESULT_PARAMS: DetectorParams = { shingleWidth: 6, threshold: 0.3, nominateWith: 20, maxFreq: 100, minTokens: 50 };
const PROMPT_PARAMS: DetectorParams = { shingleWidth: 5, threshold: 0.25, nominateWith: 20, maxFreq: 100, minTokens: 8 };

// ─────────────────────────── normalisation ───────────────────────────

describe("similarity-cluster tokenisers", () => {
	it("tool calls: same structure with different string values keeps comparable content", () => {
		const a = tokenizeToolCall("bash", { command: "git diff HEAD~1 --stat" });
		const b = tokenizeToolCall("bash", { command: "git diff main...feature --stat" });
		assert.deepEqual(a.slice(0, 2), ["bash", "command"]);
		assert.equal(a[0], b[0]);
		assert.ok(a.length === b.length, "same argument shape yields same stream length");
	});

	it("tool calls: key order never matters", () => {
		const a = tokenizeToolCall("bash", { command: "npm test", timeout: 120 });
		const b = tokenizeToolCall("bash", { timeout: 300, command: "npm test" });
		assert.deepEqual(a, ["bash", "command", "npm", "test", "timeout", "NUM"]);
		assert.deepEqual(b, a, "sorted keys canonicalise order");
	});

	it("tool calls: different tool name is a structural difference from token zero", () => {
		const a = tokenizeToolCall("bash", { command: "ls" });
		const b = tokenizeToolCall("grep", { pattern: "ls" });
		assert.notEqual(a[0], b[0]);
	});

	it("tool results: identifiers blind-rename to ID so renamed code matches", () => {
		const a = tokenizeResult("function fetchUser(id) {\n\treturn getUserRecord(id);\n}", 4000);
		const b = tokenizeResult("class FetchOrder(sessionId) {\n\treturn getOrderRow(sessionId);\n}", 4000);
		// Both reduce to the same blind-identifier skeleton with NL shape intact.
		assert.deepEqual(b.filter((t) => t !== "ID"), a.filter((t) => t !== "ID"));
	});

	it("tool results: numbers and quoted literals are tagged, not carried verbatim", () => {
		const tokens = tokenizeResult('retry count = 42; message = "attempt failed"', 4000);
		assert.deepEqual(tokens, ["ID", "ID", "=", "NUM", ";", "ID", "=", "STR"]);
	});

	it("user prompts: stop-word removal drops function words but keeps content words", () => {
		const tokens = tokenizePrompt("Don't use sed -i on macOS, use sed -i '' instead please");
		assert.ok(tokens.includes("don"), "content word 'don't' survives as don/'t split");
		assert.ok(tokens.includes("sed"));
		assert.ok(tokens.includes("macos"));
		for (const sw of ["on", "use"]) {
			// 'use' is not a stop word; 'on' is.
			if (sw === "on") assert.ok(!tokens.includes(sw), `stop word '${sw}' removed`);
		}
	});
});

describe("LCS scoring", () => {
	it("computes the classic subsequence length", () => {
		assert.equal(lcsLength(["a", "b", "c", "d"], ["a", "c", "d"]), 3);
		assert.equal(lcsLength([], ["a"]), 0);
		assert.equal(lcsLength(["x"], ["y"]), 0);
	});
});

// ─────────────────────────── clustering ───────────────────────────

describe("similarity-cluster pipeline", () => {
	it("identical tool calls group into ONE exact class regardless of member count", () => {
		const items = [
			item("1", tokenizeToolCall("read", { file_path: "AGENTS.md" }).concat("extra", "tokens")),
			item("2", tokenizeToolCall("read", { file_path: "AGENTS.md" }).concat("extra", "tokens")),
			item("3", tokenizeToolCall("read", { file_path: "AGENTS.md" }).concat("extra", "tokens")),
			item("4", tokenizeToolCall("read", { file_path: "AGENTS.md" }).concat("extra", "tokens")),
		];
		const out = clusterItems(items, CALL_PARAMS, "tool_call");
		const exacts = out.findings.filter((f) => f.exact);
		assert.equal(exacts.length, 1, "n identical items → one finding, not n(n−1)/2");
		assert.equal(exacts[0]!.size, 4);
		assert.equal(exacts[0]!.avg_similarity, 1);
		assert.equal(out.findings.every((f) => f.detector === "tool_call"), true);
	});

	it("near-miss tool calls pair without transitive grouping", () => {
		const base = ["bash", "command", "git", "push", "origin", "feature", "one"];
		const items = [
			item("a", [...base]),
			item("b", ["bash", "command", "git", "push", "origin", "feature", "two"]),
			item("c", ["bash", "command", "git", "push", "origin", "feature", "three"]),
		];
		const out = clusterItems(items, CALL_PARAMS, "tool_call");
		assert.equal(out.findings.filter((f) => !f.exact).length, 3, "all three pairs clear the threshold");
		for (const f of out.findings.filter((f) => !f.exact)) {
			assert.equal(f.size, 2, "never transitively unioned");
			assert.equal(f.similarities.length, 1);
			assert.ok(f.avg_similarity >= 1 - CALL_PARAMS.threshold);
		}
	});

	it("renamed identifiers in results cluster together (blind renaming)", () => {
		const mk = (name: string) =>
			tokenizeResult(
				Array.from({ length: 12 }, (_, i) => `function ${name}${i}(arg${i}) {` +
					`\n\treturn lookup${i}(arg${i}, ${i});\n}`).join("\n"),
				4000,
			);
		const a = mk("alpha");
		const b = mk("beta");
		// Identical skeleton modulo identifier names → identical streams after ID renaming.
		assert.deepEqual(a, b);
		const c = tokenizeResult(
			Array.from({ length: 12 }, (_, i) => `while (queue${i}.length > ${i}) {` +
				`\n\tpush(queue${i}.pop(), priority=${i});\n}`).join("\n"),
			4000,
		);
		const out = clusterItems([item("r1", a), item("r2", b), item("r3", c)], RESULT_PARAMS, "tool_result");
		assert.equal(out.findings.filter((f) => f.exact).length, 1, "renamed twins form an exact class");
		assert.ok(!out.findings.some((f) => f.members.length === 2 && f.members.some((m) => m.message_id === "m-r3")), "different structure stays out");
	});

	it("distinct structures stay quiet", () => {
		// Six control-flow skeletons with genuinely different keyword/operator
		// shapes — under blind renaming only the structure survives, and these
		// structures share almost nothing.
		const skeletons = [
			"if ( value > MAX ) { return clamp ( value ) ; }",
			"while ( queue . length > 0 ) { drain ( queue . pop ( ) ) ; }",
			"try { parse ( input ) ; } catch ( err ) { log ( err ) ; }",
			"switch ( state machine phase transition guard clause entry exit ) { case A : run ; break ; default : halt ; }",
			"await fetch ( url , opts ) . then ( res => res . json ( ) ) ;",
			"map . forEach ( ( k , v ) => set ( k , v * 2 ) ) ;",
		];
		const items = skeletons.map((skel, i) => item(`d${i}`, tokenizeResult(`${skel}\n`.repeat(8), 4000)));
		for (const it of items) assert.ok(it.tokens.length >= RESULT_PARAMS.minTokens, "each body is eligible");
		const out = clusterItems(items, RESULT_PARAMS, "tool_result");
		assert.equal(out.findings.length, 0, "unrelated structures produce no findings");
	});

	it("length-band pruning skips pairs that cannot reach the threshold", () => {
		// A 10-token run embedded contiguously in a 20-token body: the pair IS a
		// genuine candidate (they share shingles), but lo/hi = 0.5 < 0.739, so the
		// band must stop it before any LCS work happens.
		const run = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
		const long = [...Array.from({ length: 5 }, (_, i) => `pad${i}`), ...run, ...Array.from({ length: 5 }, (_, i) => `end${i}`)];
		const short = [...run];
		assert.equal(lcsLength(long, short), 10, "the run overlaps maximally");

		// Control: with a very loose threshold the same pair is scored...
		const loose: DetectorParams = { ...CALL_PARAMS, threshold: 0.9 };
		const looseOut = clusterItems([item("l", long), item("s", short)], loose, "tool_call");
		assert.ok(looseOut.comparisons >= 1, "the pair is a real candidate when the band allows it");

		// …and under the tool-call default the band stops it before scoring.
		const out = clusterItems([item("l", long), item("s", short)], CALL_PARAMS, "tool_call");
		assert.equal(out.comparisons, 0, "pair was pruned before scoring");
		assert.equal(out.findings.length, 0);
	});

	it("short items below minTokens still group exactly but skip near-miss nomination", () => {
		const tiny = tokenizePrompt("fix the build now"); // < 8 tokens after stop-words? ensure exact path
		const items = [
			item("p1", ["fix", "the", "build"]),
			item("p2", ["fix", "the", "build"]),
			item("p3", ["fix", "the", "lint"]),
		];
		const out = clusterItems(items, PROMPT_PARAMS, "user_prompt");
		const exacts = out.findings.filter((f) => f.exact);
		assert.equal(exacts.length, 1);
		assert.deepEqual(exacts[0]!.members.map((m) => m.message_id), ["m-p1", "m-p2"]);
		void tiny;
		assert.equal(out.comparisons, 0, "all items under minTokens → no near-miss scoring");
	});

	it("blind counts items whose every shingle exceeds maxFreq", () => {
		// Six identical boilerplate bodies: every shingle's DF is 6 > maxFreq=5,
		// so nothing survives the frequency cap and every eligible item is blind —
		// reported, never silently assumed clean. (The shared normalised body
		// still forms its exact class; blindness concerns the NEAR-miss index.)
		const params: DetectorParams = { ...CALL_PARAMS, maxFreq: 5 };
		const body = ["bash", "command", "run", "the", "suite", "now", "so", "fast"];
		const items = [0, 1, 2, 3, 4, 5].map((n) => item(`b${n}`, [...body]));
		const out = clusterItems(items, params, "tool_call");
		assert.equal(out.blindCount, items.length, "all-boilerplate corpus reports its blindness");
		assert.equal(out.corpusSize, items.length);
		assert.equal(out.findings.filter((f) => f.exact).length, 1);
	});

	it("ranking puts exact classes first, then similarity then size", () => {
		const ranked = rankFindings(
			[
				{ detector: "user_prompt", size: 2, avg_similarity: 0.9, exact: false, members: [], similarities: [] },
				{ detector: "tool_call", size: 3, avg_similarity: 1, exact: true, members: [], similarities: [] },
				{ detector: "tool_result", size: 9, avg_similarity: 0.95, exact: false, members: [], similarities: [] },
			],
			10,
		);
		assert.deepEqual(ranked.map((f) => [f.exact, f.avg_similarity]), [
			[true, 1],
			[false, 0.95],
			[false, 0.9],
		]);
	});
});
