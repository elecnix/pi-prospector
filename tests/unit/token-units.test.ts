/**
 * Unit tests for the MITE fold and the class-cost roll-up.
 *
 * The de-duplication case is the one that matters most: Claude Code writes a
 * transcript line per content block and repeats the response's `usage` on every
 * one, so a fold that counts rows rather than calls silently doubles a real
 * corpus. It is asserted here on a fixture shaped exactly like that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WEIGHTS, EQUIVALENTS_PER_MITE } from "../../src/analyze/analyzers/token-units/config.js";
import { foldSessionUnits, scaleTotals, type UsageRow } from "../../src/analyze/analyzers/token-units/fold.js";
import { classCosts, normaliseClass, projectLabel, modelLabel, localDayOf } from "../../src/analyze/analyzers/token-units/leaves.js";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): string {
	return JSON.stringify({ input, output, cacheRead, cacheWrite });
}

function assistant(id: string, providerId: string | null, u: string | null, at = "2026-08-14T10:00:00Z"): UsageRow {
	return { id, role: "assistant", timestamp: at, usage: u, model: "m", provider_message_id: providerId };
}

function user(id: string, at = "2026-08-14T09:59:00Z"): UsageRow {
	return { id, role: "user", timestamp: at, usage: null, model: null, provider_message_id: null };
}

describe("foldSessionUnits — the exchange rate", () => {
	it("weights each token kind and reports the result in MITE", () => {
		const rows = [user("u1"), assistant("a1", "p1", usage(1_000_000, 1_000, 2_000_000, 400_000))];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);

		// 1e6*1 + 1e3*15 + 2e6*0.1 + 4e5*1.25 = 1_000_000 + 15_000 + 200_000 + 500_000
		assert.equal(r.totals.equivalents, 1_715_000);
		assert.equal(r.totals.mite, 1_715_000 / EQUIVALENTS_PER_MITE);
		assert.equal(r.totals.calls, 1);
	});

	it("honours restated weights rather than the defaults", () => {
		const rows = [user("u1"), assistant("a1", "p1", usage(0, 100))];
		const r = foldSessionUnits("s", rows, { input: 1, output: 2, cache_read: 0, cache_write: 0 });
		assert.equal(r.totals.equivalents, 200);
	});
});

describe("foldSessionUnits — de-duplication", () => {
	it("counts one API call once when it spans several transcript rows", () => {
		// One response split across three content-block rows, each repeating usage.
		const rows = [
			user("u1"),
			assistant("row1", "msg_A", usage(100, 10)),
			assistant("row2", "msg_A", usage(100, 10)),
			assistant("row3", "msg_A", usage(100, 10)),
		];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);

		assert.equal(r.totals.calls, 1, "three rows are one billed call");
		assert.equal(r.totals.input, 100);
		assert.equal(r.coverage.assistant_rows, 3);
		assert.equal(r.coverage.billed_calls, 1);
	});

	it("keeps distinct responses distinct even with identical usage", () => {
		const rows = [
			user("u1"),
			assistant("row1", "msg_A", usage(100, 10)),
			assistant("row2", "msg_B", usage(100, 10)),
		];
		assert.equal(foldSessionUnits("s", rows, DEFAULT_WEIGHTS).totals.calls, 2);
	});

	it("falls back to the row id when no provider id was recorded, and says so", () => {
		const rows = [user("u1"), assistant("row1", null, usage(100, 10)), assistant("row2", null, usage(100, 10))];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);
		assert.equal(r.totals.calls, 2);
		assert.equal(r.coverage.rows_without_key, 2, "coverage states the fallback rather than hiding it");
	});

	it("counts a call with no usage as unknown, never as zero", () => {
		const rows = [user("u1"), assistant("row1", "msg_A", null)];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);
		assert.equal(r.coverage.calls_without_usage, 1);
		assert.equal(r.totals.calls, 0, "an unpriced call does not inflate the billed count");
	});

	it("ignores malformed usage JSON without losing the call from coverage", () => {
		const rows = [user("u1"), assistant("row1", "msg_A", "{not json")];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);
		assert.equal(r.coverage.billed_calls, 1);
		assert.equal(r.coverage.calls_without_usage, 1);
	});
});

describe("foldSessionUnits — request segments", () => {
	it("attributes each call to the request that caused it", () => {
		const rows = [
			user("u1"),
			assistant("a1", "p1", usage(100, 0)),
			assistant("a2", "p2", usage(200, 0)),
			user("u2"),
			assistant("a3", "p3", usage(50, 0)),
		];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);

		assert.equal(r.segments.length, 2);
		assert.deepEqual(r.segments.map((s) => s.user_message_id), ["u1", "u2"]);
		assert.equal(r.segments[0]!.totals.input, 300);
		assert.equal(r.segments[1]!.totals.input, 50);
	});

	it("keeps pre-request spend in a preamble segment instead of dropping it", () => {
		const rows = [assistant("a0", "p0", usage(70, 0)), user("u1"), assistant("a1", "p1", usage(30, 0))];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);

		assert.equal(r.segments[0]!.ordinal, -1);
		assert.equal(r.segments[0]!.totals.input, 70);
		assert.equal(r.totals.input, 100, "the preamble is part of the session total");
	});

	it("omits an empty preamble", () => {
		const rows = [user("u1"), assistant("a1", "p1", usage(30, 0))];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);
		assert.deepEqual(r.segments.map((s) => s.ordinal), [0]);
	});

	it("records when a request's last call landed, so a reader can see it straddle midnight", () => {
		const rows = [
			user("u1", "2026-08-14T23:50:00Z"),
			assistant("a1", "p1", usage(10, 0), "2026-08-14T23:55:00Z"),
			assistant("a2", "p2", usage(10, 0), "2026-08-15T00:20:00Z"),
		];
		const seg = foldSessionUnits("s", rows, DEFAULT_WEIGHTS).segments[0]!;
		assert.equal(seg.started_at, "2026-08-14T23:50:00Z");
		assert.equal(seg.ended_at, "2026-08-15T00:20:00Z");
	});

	it("splits totals per serving model", () => {
		const rows: UsageRow[] = [
			user("u1"),
			{ ...assistant("a1", "p1", usage(100, 0)), model: "fast" },
			{ ...assistant("a2", "p2", usage(300, 0)), model: "slow" },
		];
		const r = foldSessionUnits("s", rows, DEFAULT_WEIGHTS);
		assert.equal(r.by_model["fast"]!.input, 100);
		assert.equal(r.by_model["slow"]!.input, 300);
	});

	it("labels a model-less call rather than discarding it", () => {
		const rows: UsageRow[] = [user("u1"), { ...assistant("a1", "p1", usage(100, 0)), model: null }];
		assert.equal(foldSessionUnits("s", rows, DEFAULT_WEIGHTS).by_model["unrecorded"]!.input, 100);
	});
});

describe("classCosts", () => {
	const leaf = (className: string, mite: number) => ({
		sessionId: "s",
		source: "pi",
		project: "p",
		sessionLabel: "s · p",
		className,
		model: "m",
		hour: 9,
		day: "2026-08-14",
		totals: { input: mite, output: 0, cache_read: 0, cache_write: 0, equivalents: mite, mite, calls: 1 },
		preview: "",
	});

	it("rolls leaves up per class, largest first, with shares that sum to one", () => {
		const costs = classCosts([leaf("a", 1), leaf("b", 3), leaf("a", 1)], 5);
		assert.deepEqual(costs.map((c) => c.className), ["b", "a"]);
		assert.equal(costs[0]!.totals.mite, 3);
		assert.equal(costs[1]!.totals.mite, 2);
		assert.equal(costs.reduce((s, c) => s + c.share, 0), 1);
	});

	it("reports a zero share rather than dividing by zero", () => {
		assert.equal(classCosts([leaf("a", 0)], 0)[0]!.share, 0);
	});
});

describe("scaleTotals", () => {
	it("splits a request evenly across the classes it belongs to", () => {
		const totals = { input: 10, output: 20, cache_read: 30, cache_write: 40, equivalents: 100, mite: 0.0001, calls: 2 };
		const half = scaleTotals(totals, 1 / 2);
		assert.equal(half.equivalents, 50);
		assert.equal(half.input, 5);
		assert.equal(half.calls, 1);
	});
});

describe("labels", () => {
	it("groups class names by case and whitespace only", () => {
		assert.equal(normaliseClass("  CI   Status  Notifications. "), "ci status notifications");
	});

	it("leaves near-synonyms separate, which is the point of an open vocabulary", () => {
		assert.notEqual(normaliseClass("CI notifications"), normaliseClass("CI status notifications"));
	});

	it("names a worktree but not the main checkout", () => {
		assert.equal(projectLabel("/Users/x/Source/repo/main", ""), "repo");
		assert.equal(projectLabel("/Users/x/Source/repo/feat-a", ""), "repo/feat-a");
	});

	it("falls back to the last path segment outside a Source tree", () => {
		assert.equal(projectLabel("/tmp/scratch", "fallback"), "scratch");
		assert.equal(projectLabel("", "fallback"), "fallback");
	});

	it("folds routing prefixes so one model is not split three ways", () => {
		assert.equal(modelLabel("ollama/glm-5.2"), "glm-5.2");
		assert.equal(modelLabel("openrouter/z-ai/glm-5.2"), "glm-5.2");
		assert.equal(modelLabel("glm-5.2"), "glm-5.2");
	});

	it("returns null for an unparseable instant instead of a wrong day", () => {
		assert.equal(localDayOf(null), null);
		assert.equal(localDayOf("not a date"), null);
	});
});
