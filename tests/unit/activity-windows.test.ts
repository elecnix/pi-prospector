/**
 * Unit tests for activity-windows detection and the concurrency fold. Pure
 * functions, no database, no mocks: hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals, scanActivity } from "../../src/analyze/analyzers/activity-windows/detect.js";
import { foldConcurrency } from "../../src/analyze/analyzers/activity-windows/concurrency.js";
import { makeMessageRow as row } from "./helpers.js";

const T = (s: string) => `2026-10-01T${s}.000Z`;
const ms = (s: string) => Date.parse(T(s));

describe("mergeIntervals", () => {
	it("merges overlapping and touching intervals and drops empty ones", () => {
		assert.deepEqual(mergeIntervals([[5, 9], [0, 3], [3, 4], [8, 12], [20, 20]]), [[0, 4], [5, 12]]);
	});
});

describe("scanActivity", () => {
	it("counts a gap up to the idle cap and splits at a longer one", () => {
		const scan = scanActivity([
			row({ id: "a", timestamp: T("10:00:00") }),
			row({ id: "b", timestamp: T("10:02:00") }),
			row({ id: "c", timestamp: T("11:00:00") }),
			row({ id: "d", timestamp: T("11:00:30") }),
		]);
		assert.deepEqual(scan.windows, [
			{ start: T("10:00:00"), end: T("10:07:00") },
			{ start: T("11:00:00"), end: T("11:00:30") },
		]);
		assert.equal(scan.active_seconds, 450);
	});

	it("keeps a long tool call active for its whole span", () => {
		const scan = scanActivity([
			row({ id: "a", role: "assistant", timestamp: T("10:00:00"), tool_calls: JSON.stringify([{ id: "x", name: "bash", arguments: { command: "make" } }]) }),
			row({
				id: "b",
				role: "toolResult",
				timestamp: T("10:30:00"),
				tool_results: JSON.stringify([{ toolCallId: "x", toolName: "bash", isError: false, textLength: 0 }]),
			}),
		]);
		assert.deepEqual(scan.windows, [{ start: T("10:00:00"), end: T("10:30:00") }]);
	});

	it("counts messages with no timestamp and never treats them as instant", () => {
		const scan = scanActivity([row({ id: "a", timestamp: null }), row({ id: "b", timestamp: "not a date" }), row({ id: "c", timestamp: T("10:00:00") })]);
		assert.equal(scan.untimed_message_count, 2);
		assert.deepEqual(scan.windows, []);
	});
});

describe("foldConcurrency", () => {
	it("counts sessions, the peak overlap, and agent minutes per hour", () => {
		const rows = foldConcurrency([
			{ sessionId: "a", windows: [[ms("10:00:00"), ms("10:40:00")]] },
			{ sessionId: "b", windows: [[ms("10:20:00"), ms("10:50:00")]] },
			{ sessionId: "c", windows: [[ms("10:55:00"), ms("11:10:00")]] },
		]);
		assert.deepEqual(rows, [
			{ bucket_start: T("10:00:00"), sessions: 3, peak_concurrent: 2, active_minutes: 40 + 30 + 5 },
			{ bucket_start: T("11:00:00"), sessions: 1, peak_concurrent: 1, active_minutes: 10 },
		]);
	});

	it("does not count two sessions that only touch as overlapping", () => {
		const [row0] = foldConcurrency([
			{ sessionId: "a", windows: [[ms("10:00:00"), ms("10:10:00")]] },
			{ sessionId: "b", windows: [[ms("10:10:00"), ms("10:20:00")]] },
		]);
		assert.equal(row0?.peak_concurrent, 1);
	});

	it("folds by day and returns nothing for no sessions", () => {
		const rows = foldConcurrency([{ sessionId: "a", windows: [[ms("01:00:00"), ms("23:00:00")]] }], "day");
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.active_minutes, 22 * 60);
		assert.deepEqual(foldConcurrency([]), []);
	});
});
