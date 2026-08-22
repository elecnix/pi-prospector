import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
	parseNodeArgs,
	parseFilterSpec,
	valueMatches,
	contentMatchesFilters,
	countsByProp,
	latestPerKey,
	summarizeContent,
	formatNodeLine,
	nodesUsage,
} from "../../src/commands/nodes.js";
import type { AnalyzerDef, AnalysisNodeRow } from "../../src/analyze/types.js";

// ─────────────────────────── fixtures (synthetic) ───────────────────────────

const TYPED_DEF: AnalyzerDef = {
	id: "mock-analyzer",
	label: "Mock",
	description: "synthetic",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: Type.Object({
		term: Type.String(),
		confidence: Type.Number(),
		muted: Type.Boolean(),
		tags: Type.Array(Type.String()),
		verdict: Type.Union([Type.Literal("frustration"), Type.Literal("praise")]),
	}),
};

const UNTYPED_DEF: AnalyzerDef = {
	id: "untyped",
	label: "Untyped",
	description: "synthetic",
	anchorSpan: "full_session",
	dependencies: [],
};

function nodeRow(overrides: Partial<AnalysisNodeRow> = {}): AnalysisNodeRow {
	return {
		id: "n1",
		session_id: "s1",
		analyzer_id: "mock-analyzer",
		analyzer_version_id: "v1",
		config_id: "c1",
		run_id: null,
		node_kind: "classification",
		content_json: "{}",
		source_set_hash: "ss1",
		input_key: "ik1",
		output_key: "outkey-0001",
		config_fingerprint: "",
		model_used: null,
		cost_usd: null,
		tokens_used: null,
		input_tokens: null,
		cached_input_tokens: null,
		output_tokens: null,
		duration_ms: null,
		created_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

// ─────────────────────────── parseNodeArgs ───────────────────────────

describe("parseNodeArgs", () => {
	it("parses the full flag set", () => {
		const q = parseNodeArgs(
			"--analyzer frustration-lexicon --node-kind classification --filter term=putain --counts category " +
				"--latest-per-key term --limit 5 --offset 10 --session s1 --as-of 7d",
		);
		assert.equal(q.analyzerId, "frustration-lexicon");
		assert.equal(q.nodeKind, "classification");
		assert.deepEqual(q.filters, ["term=putain"]);
		assert.equal(q.counts, "category");
		assert.equal(q.latestPerKey, "term");
		assert.equal(q.limit, 5);
		assert.equal(q.offset, 10);
		assert.equal(q.sessionId, "s1");
		assert.equal(q.asOf, "7d");
	});

	it("accepts repeated --filter flags and --flag=value form", () => {
		const q = parseNodeArgs("--all --filter polarity=frustration --filter=category=profanity");
		assert.equal(q.all, true);
		assert.deepEqual(q.filters, ["polarity=frustration", "category=profanity"]);
	});

	it("rejects unknown flags and stray positionals", () => {
		assert.throws(() => parseNodeArgs("--analyzer a --bogus x"), /unknown flag or stray argument/);
		assert.throws(() => parseNodeArgs("stray"), /unknown flag or stray argument/);
	});

	it("rejects flags missing their value", () => {
		assert.throws(() => parseNodeArgs("--analyzer"), /needs a value/);
		assert.throws(() => parseNodeArgs("--counts --limit 3"), /needs a value/);
	});

	it("rejects non-integer limits", () => {
		assert.throws(() => parseNodeArgs("--limit abc"), /non-negative integer/);
		assert.throws(() => parseNodeArgs("--limit -1"), /non-negative integer/);
	});

	it("usage mentions every flag", () => {
		for (const flag of ["--analyzer", "--all", "--node-kind", "--filter", "--counts", "--latest-per-key", "--limit", "--offset"]) {
			assert.ok(nodesUsage().includes(flag), `usage lacks ${flag}`);
		}
	});
});

describe("parseFilterSpec", () => {
	it("splits on the first =", () => {
		assert.deepEqual(parseFilterSpec("term=a=b"), { key: "term", raw: "a=b" });
	});
	it("rejects specs without a key or value", () => {
		assert.throws(() => parseFilterSpec("novalue"), /malformed --filter/);
		assert.throws(() => parseFilterSpec("="), /malformed --filter/);
	});
});

// ─────────────────────────── typed filtering ───────────────────────────

describe("valueMatches", () => {
	it("coerces to the declared number type", () => {
		assert.equal(valueMatches(0.9, { key: "confidence", raw: "0.9" }, TYPED_DEF), true);
		assert.equal(valueMatches(0.9, { key: "confidence", raw: "0.85" }, TYPED_DEF), false);
		assert.equal(valueMatches("0.9", { key: "confidence", raw: "0.9" }, TYPED_DEF), false, "declared number never matches a string value");
	});

	it("throws when a declared numeric filter is not numeric", () => {
		assert.throws(() => valueMatches(1, { key: "confidence", raw: "high" }, TYPED_DEF), /must be numeric/);
	});

	it("coerces to the declared boolean type", () => {
		assert.equal(valueMatches(true, { key: "muted", raw: "true" }, TYPED_DEF), true);
		assert.equal(valueMatches(false, { key: "muted", raw: "true" }, TYPED_DEF), false);
		assert.throws(() => valueMatches(true, { key: "muted", raw: "yes" }, TYPED_DEF), /true or false/);
	});

	it("matches declared strings exactly", () => {
		assert.equal(valueMatches("putain", { key: "term", raw: "putain" }, TYPED_DEF), true);
		assert.equal(valueMatches("putain", { key: "term", raw: "puta" }, TYPED_DEF), false, "no substring matches");
	});

	it("compares declared arrays structurally", () => {
		assert.equal(valueMatches(["a", "b"], { key: "tags", raw: '["a","b"]' }, TYPED_DEF), true);
		assert.equal(valueMatches(["a"], { key: "tags", raw: '["a"]' }, TYPED_DEF), true);
		assert.throws(() => valueMatches(["a"], { key: "tags", raw: "a" }, TYPED_DEF), /must be JSON/);
	});

	it("honours schema constraints beyond the base type (enum)", () => {
		assert.equal(valueMatches("frustration", { key: "verdict", raw: "frustration" }, TYPED_DEF), true);
		assert.throws(() => valueMatches("frustration", { key: "verdict", raw: "angry" }, TYPED_DEF), /does not match the declared schema/);
	});

	it("falls back to best-effort when the analyzer declares no schema", () => {
		assert.equal(valueMatches(3, { key: "tool_failure_count", raw: "3" }, UNTYPED_DEF), true);
		assert.equal(valueMatches(true, { key: "high_signal", raw: "true" }, UNTYPED_DEF), true);
		assert.equal(valueMatches("fr", { key: "language", raw: "fr" }, UNTYPED_DEF), true);
		assert.equal(valueMatches("fr", { key: "language", raw: "en" }, UNTYPED_DEF), false);
		assert.equal(valueMatches({ a: 1 }, { key: "meta", raw: '{"a":1}' }, UNTYPED_DEF), true);
	});

	it("is best-effort for properties an analyzer did not declare", () => {
		assert.equal(valueMatches(7, { key: "undeclared", raw: "7" }, TYPED_DEF), true);
	});
});

describe("contentMatchesFilters", () => {
	it("requires every filter to match", () => {
		const content = { term: "putain", confidence: 0.9, muted: false };
		assert.equal(contentMatchesFilters(content, [{ key: "term", raw: "putain" }, { key: "confidence", raw: "0.9" }], TYPED_DEF), true);
		assert.equal(contentMatchesFilters(content, [{ key: "term", raw: "putain" }, { key: "muted", raw: "true" }], TYPED_DEF), false);
	});
});

// ─────────────────────────── aggregation ───────────────────────────

describe("countsByProp", () => {
	it("groups counts over a property, sorted by count then value", () => {
		const rows = [
			nodeRow({ id: "a", content_json: JSON.stringify({ category: "profanity" }) }),
			nodeRow({ id: "b", content_json: JSON.stringify({ category: "profanity" }) }),
			nodeRow({ id: "c", content_json: JSON.stringify({ category: "negation" }) }),
		];
		assert.deepEqual(countsByProp(rows, "category"), [
			{ value: "profanity", count: 2 },
			{ value: "negation", count: 1 },
		]);
	});

	it("counts nodes lacking the property instead of dropping them", () => {
		const rows = [nodeRow({ content_json: JSON.stringify({ other: 1 }) })];
		assert.deepEqual(countsByProp(rows, "category"), [{ value: "(no category)", count: 1 }]);
	});
});

describe("latestPerKey", () => {
	it("keeps only the newest node per key (newest verdict per term)", () => {
		const rows = [
			nodeRow({ id: "old", output_key: "ok-old", created_at: "2026-01-01T00:00:00Z", content_json: JSON.stringify({ term: "putain", polarity: "frustration" }) }),
			nodeRow({ id: "new", output_key: "ok-new", created_at: "2026-02-01T00:00:00Z", content_json: JSON.stringify({ term: "putain", polarity: "praise" }) }),
			nodeRow({ id: "other", output_key: "ok-other", created_at: "2026-01-15T00:00:00Z", content_json: JSON.stringify({ term: "не то", polarity: "frustration" }) }),
		];
		const { kept, dropped } = latestPerKey(rows, "term");
		assert.equal(dropped, 0);
		assert.equal(kept.length, 2);
		const putain = kept.find((r) => r.id === "new");
		assert.ok(putain, "the newer verdict must win");
	});

	it("breaks ties on output_key so the choice is deterministic", () => {
		const rows = [
			nodeRow({ id: "a", output_key: "aaa", created_at: "2026-01-01T00:00:00Z", content_json: JSON.stringify({ term: "x" }) }),
			nodeRow({ id: "b", output_key: "bbb", created_at: "2026-01-01T00:00:00Z", content_json: JSON.stringify({ term: "x" }) }),
		];
		const { kept } = latestPerKey(rows, "term");
		assert.deepEqual(kept.map((r) => r.id), ["b"]);
	});

	it("reports nodes lacking the key rather than silently dropping them", () => {
		const rows = [
			nodeRow({ content_json: JSON.stringify({ term: "x" }) }),
			nodeRow({ content_json: JSON.stringify({ no_term: true }) }),
		];
		const { kept, dropped } = latestPerKey(rows, "term");
		assert.equal(kept.length, 1);
		assert.equal(dropped, 1);
	});
});

// ─────────────────────────── formatting ───────────────────────────

describe("summarizeContent", () => {
	it("renders scalars as k=v pairs, truncating long strings", () => {
		const s = summarizeContent(JSON.stringify({ term: "putain", confidence: 0.9, muted: false, tags: ["a", "b"] }));
		assert.match(s, /term=putain/);
		assert.match(s, /confidence=0\.9/);
		assert.match(s, /muted=false/);
		assert.match(s, /tags=\[2\]/);
	});

	it("survives unparseable content", () => {
		assert.equal(summarizeContent("{not json"), "(unparseable content)");
	});
});

describe("formatNodeLine", () => {
	it("shows a short output key, kind, session, timestamp and digest", () => {
		const line = formatNodeLine(nodeRow({ content_json: JSON.stringify({ term: "putain" }) }));
		assert.match(line, /^  outkey-0/);
		assert.match(line, /classification/);
		assert.match(line, /term=putain/);
	});
});
