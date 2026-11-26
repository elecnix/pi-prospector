import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { concurrencyBucket, peakConcurrency } from "../../src/analyze/analyzers/activity-windows/fingerprint.js";

const H = 3_600_000;
const day = Date.parse("2026-03-02T00:00:00.000Z");

describe("activity-windows fingerprint folds", () => {
	it("gives each session the most sessions active at once while it was", () => {
		const peaks = peakConcurrency([
			{ id: "a", windows: [[day, day + 3 * H]] },
			{ id: "b", windows: [[day + H, day + 2 * H]] },
			{ id: "c", windows: [[day + 1.5 * H, day + 4 * H]] },
			// Touches c at an instant only: not overlapping.
			{ id: "d", windows: [[day + 4 * H, day + 5 * H]] },
		]);
		assert.deepEqual(Object.fromEntries(peaks), { a: 3, b: 3, c: 3, d: 1 });
	});

	it("names a peak by a fixed bucket", () => {
		assert.deepEqual([1, 2, 3, 4, 5, 9, 10, 19, 20, 49, 50, 400].map(concurrencyBucket), ["1", "2", "3-4", "3-4", "5-9", "5-9", "10-19", "10-19", "20-49", "20-49", "50-or-more", "50-or-more"]);
	});
});
