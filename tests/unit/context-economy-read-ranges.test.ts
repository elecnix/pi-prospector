/**
 * Unit tests for context-economy's slice-aware redundant-read helpers (#156).
 * Pure functions; hand-computed; no DB, no framework.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	countRedundantReads,
	readRangeFromArgs,
	readRangesOverlap,
} from "../../src/analyze/analyzers/context-economy/index.js";

describe("context-economy readRangeFromArgs", () => {
	it("treats missing offset and limit as a whole-file read [0, ∞)", () => {
		assert.deepEqual(readRangeFromArgs({ path: "/f.ts" }), { start: 0, end: Infinity });
		assert.deepEqual(readRangeFromArgs(undefined), { start: 0, end: Infinity });
	});

	it("uses offset alone as an unbounded tail read", () => {
		assert.deepEqual(readRangeFromArgs({ offset: 200 }), { start: 200, end: Infinity });
	});

	it("bounds an offset+limit slice", () => {
		assert.deepEqual(readRangeFromArgs({ offset: 100, limit: 50 }), { start: 100, end: 150 });
	});

	it("coerces numeric strings and rejects non-numeric or negative values", () => {
		assert.deepEqual(readRangeFromArgs({ offset: "10", limit: "20" }), { start: 10, end: 30 });
		assert.deepEqual(readRangeFromArgs({ offset: "abc" }), { start: 0, end: Infinity });
		assert.deepEqual(readRangeFromArgs({ limit: -5 }), { start: 0, end: Infinity });
	});
});

describe("context-economy readRangesOverlap", () => {
	it("disjoint slices do not overlap", () => {
		assert.equal(readRangesOverlap({ start: 0, end: 100 }, { start: 100, end: 200 }), false);
		assert.equal(readRangesOverlap({ start: 0, end: 100 }, { start: 150, end: 250 }), false);
	});

	it("overlapping slices intersect", () => {
		assert.equal(readRangesOverlap({ start: 0, end: 100 }, { start: 50, end: 150 }), true);
	});

	it("an unbounded range overlaps anything at or after its offset", () => {
		assert.equal(readRangesOverlap({ start: 0, end: Infinity }, { start: 500, end: 600 }), true);
		assert.equal(readRangesOverlap({ start: 300, end: Infinity }, { start: 0, end: 100 }), false);
	});
});

describe("context-economy countRedundantReads", () => {
	interface CountCase {
		name: string;
		args: Array<Parameters<typeof readRangeFromArgs>[0]>;
		expected: number;
	}

	const countCases: CountCase[] = [
		{
			name: "counts zero duplicates for three disjoint slices of one file (issue #156 case 1)",
			args: [
				{ offset: 0, limit: 200 },
				{ offset: 200, limit: 200 },
				{ offset: 400, limit: 200 },
			],
			expected: 0,
		},
		{
			name: "counts both participants of one overlapping pair",
			args: [
				{ offset: 0, limit: 200 },
				{ offset: 100, limit: 200 },
				{ offset: 400, limit: 200 },
			],
			expected: 2,
		},
	];

	for (const c of countCases) {
		it(c.name, () => {
			assert.equal(countRedundantReads(c.args.map(readRangeFromArgs)), c.expected);
		});
	}

	it("whole-file reads overlap every other read of the path", () => {
		const whole = countRedundantReads([
			readRangeFromArgs({}),
			readRangeFromArgs({}),
		]);
		assert.equal(whole, 2);

		const mixed = countRedundantReads([
			readRangeFromArgs({}),
			readRangeFromArgs({ offset: 10_000, limit: 50 }),
		]);
		assert.equal(mixed, 2);
	});
});
