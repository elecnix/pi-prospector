import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distribution, guardGroups, quantile } from "../../src/fingerprint/guard.js";

const EDGES = [0, 5, 15, 30] as const;

describe("quantile", () => {
	it("interpolates between neighbouring values", () => {
		assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
		assert.equal(quantile([10], 0.9), 10);
		assert.equal(quantile([1, 2, 3, 4, 5], 0.9), 4.6);
	});
});

describe("distribution", () => {
	it("withholds a population smaller than the minimum", () => {
		assert.deepEqual(distribution([1, 2, 3, 4], EDGES, "minutes", 5), { status: "withheld", reason: "below-min-group-size" });
	});

	it("keeps buckets that meet the minimum and reports the open top edge as null", () => {
		const values = [...Array(5).fill(1), ...Array(6).fill(20)];
		const d = distribution(values, EDGES, "minutes", 5);
		assert.equal(d.status, "ok");
		if (d.status !== "ok") return;
		assert.equal(d.sessions, 11);
		assert.deepEqual(d.buckets, [
			{ from: 0, to: 5, sessions: 5 },
			{ from: 5, to: 15, sessions: 0 },
			{ from: 15, to: 30, sessions: 6 },
			{ from: 30, to: null, sessions: 0 },
		]);
	});

	it("merges a small bucket into its smaller neighbour until every bucket is empty or at least the minimum", () => {
		const values = [...Array(2).fill(1), ...Array(6).fill(7), ...Array(3).fill(20), ...Array(8).fill(40)];
		const d = distribution(values, EDGES, "minutes", 5);
		assert.equal(d.status, "ok");
		if (d.status !== "ok") return;
		for (const b of d.buckets) assert.ok(b.sessions === 0 || b.sessions >= 5, `bucket ${b.from} holds ${b.sessions}`);
		assert.equal(d.buckets.reduce((n, b) => n + b.sessions, 0), values.length);
		// Merging only joins neighbours, so the edges stay in order and contiguous.
		for (let i = 1; i < d.buckets.length; i++) assert.equal(d.buckets[i]!.from, d.buckets[i - 1]!.to);
	});

	it("reports percentiles of the raw values", () => {
		const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], EDGES, "prompts", 5);
		assert.equal(d.status, "ok");
		if (d.status !== "ok") return;
		assert.equal(d.p50, 5.5);
		assert.equal(d.p90, 9.1);
	});
});

describe("guardGroups", () => {
	const ids = (...n: string[]) => new Set(n);

	it("keeps a group drawn from enough sessions", () => {
		const out = guardGroups([{ key: "a", count: 9, sessionIds: ids("1", "2", "3", "4", "5") }], 5);
		assert.deepEqual(out, [{ key: "a", count: 9, sessions: 5 }]);
	});

	it("folds small groups into other, counting each session once", () => {
		const out = guardGroups(
			[
				{ key: "a", count: 9, sessionIds: ids("1", "2", "3", "4", "5") },
				{ key: "b", count: 2, sessionIds: ids("1", "6", "7") },
				{ key: "c", count: 3, sessionIds: ids("6", "8", "9") },
			],
			5,
		);
		assert.deepEqual(out, [
			{ key: "a", count: 9, sessions: 5 },
			{ key: "other", count: 5, sessions: 5 },
		]);
	});

	it("drops other when it is still under the minimum", () => {
		const out = guardGroups(
			[
				{ key: "a", count: 9, sessionIds: ids("1", "2", "3", "4", "5") },
				{ key: "b", count: 2, sessionIds: ids("1", "6") },
			],
			5,
		);
		assert.deepEqual(out, [{ key: "a", count: 9, sessions: 5 }]);
	});

	it("adds a small group to a real group already called other", () => {
		const out = guardGroups(
			[
				{ key: "other", count: 4, sessionIds: ids("1", "2", "3", "4", "5") },
				{ key: "b", count: 1, sessionIds: ids("6") },
			],
			5,
		);
		assert.deepEqual(out, [{ key: "other", count: 5, sessions: 6 }]);
	});
});
