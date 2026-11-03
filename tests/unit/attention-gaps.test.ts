/**
 * Unit tests for attention-gaps. Pure functions, no database, no mocks:
 * hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanAttention, type OriginRead } from "../../src/analyze/analyzers/attention-gaps/detect.js";
import { makeMessageRow as row } from "./helpers.js";

const T = (s: string) => `2026-10-01T${s}.000Z`;
const typed: OriginRead = { origin: "typed", decided: true };

describe("scanAttention", () => {
	it("measures from the agent's last activity to each typed message", () => {
		const messages = [
			row({ id: "u1", role: "user", timestamp: T("10:00:00") }),
			row({ id: "a1", role: "assistant", timestamp: T("10:00:20") }),
			row({ id: "r1", role: "toolResult", timestamp: T("10:00:30") }),
			row({ id: "u2", role: "user", timestamp: T("10:01:30") }),
			row({ id: "a2", role: "assistant", timestamp: T("10:01:40") }),
			row({ id: "u3", role: "user", timestamp: T("12:01:40") }),
		];
		const scan = scanAttention(messages, new Map([["u1", typed], ["u2", typed], ["u3", typed]]));
		assert.equal(scan.typed_message_count, 3);
		assert.equal(scan.gap_count, 2, "the first turn has no earlier agent activity");
		assert.equal(scan.unmeasured_typed_count, 1);
		assert.equal(scan.sum_seconds, 60 + 7200);
		assert.equal(scan.median_seconds, 60);
		assert.equal(scan.max_seconds, 7200);
		assert.deepEqual(scan.longest.map((g) => g.user_message_id), ["u3", "u2"]);
		// bounds 10, 60, 300, 1800, 7200 and overflow: 60 s lands in the 60 s bucket, 7200 s in the 7200 s bucket.
		assert.deepEqual(scan.buckets.map((b) => b.count), [0, 1, 0, 0, 1, 0]);
	});

	it("sorts the configured bounds before bucketing", () => {
		const messages = [row({ id: "a1", role: "assistant", timestamp: T("10:00:00") }), row({ id: "u1", role: "user", timestamp: T("11:23:20") })];
		const scan = scanAttention(messages, new Map([["u1", typed]]), { bucketBoundsSeconds: [3600, 10], longestCap: 5 });
		assert.deepEqual(scan.buckets, [{ le_seconds: 10, count: 0 }, { le_seconds: 3600, count: 0 }, { le_seconds: null, count: 1 }]);
		const within = scanAttention(
			[row({ id: "a1", role: "assistant", timestamp: T("10:00:00") }), row({ id: "u1", role: "user", timestamp: T("10:30:00") })],
			new Map([["u1", typed]]),
			{ bucketBoundsSeconds: [3600, 10], longestCap: 5 },
		);
		assert.equal(within.buckets.find((b) => b.le_seconds === 3600)?.count, 1);
	});

	it("ignores messages that are not typed and does not treat a notification as the agent finishing", () => {
		const messages = [
			row({ id: "a1", role: "assistant", timestamp: T("10:00:00") }),
			row({ id: "n1", role: "user", timestamp: T("10:05:00") }),
			row({ id: "u1", role: "user", timestamp: T("10:10:00") }),
			row({ id: "p1", role: "user", timestamp: T("10:11:00") }),
		];
		const scan = scanAttention(
			messages,
			new Map<string, OriginRead>([
				["n1", { origin: "notification", decided: true }],
				["u1", typed],
				["p1", { origin: "pasted", decided: true }],
			]),
		);
		assert.equal(scan.typed_message_count, 1);
		assert.equal(scan.gap_count, 1);
		assert.equal(scan.sum_seconds, 600, "the gap runs from the agent's last activity, not the notification");
	});

	it("counts an undecided message apart and keeps it out of the statistics", () => {
		const messages = [
			row({ id: "a1", role: "assistant", timestamp: T("10:00:00") }),
			row({ id: "u1", role: "user", timestamp: T("10:00:30") }),
		];
		const scan = scanAttention(messages, new Map([["u1", { origin: "typed", decided: false }]]));
		assert.equal(scan.typed_message_count, 0);
		assert.equal(scan.undecided_message_count, 1);
		assert.equal(scan.undecided_gap_count, 1);
		assert.equal(scan.gap_count, 0);
		assert.equal(scan.median_seconds, null);
	});

	it("leaves a typed message with no timestamp unmeasured instead of zero", () => {
		const messages = [row({ id: "a1", role: "assistant", timestamp: T("10:00:00") }), row({ id: "u1", role: "user", timestamp: null })];
		const scan = scanAttention(messages, new Map([["u1", typed]]));
		assert.equal(scan.gap_count, 0);
		assert.equal(scan.unmeasured_typed_count, 1);
	});

	it("returns zero counts and null statistics for a session with no typed message", () => {
		const scan = scanAttention([row({ id: "a1", role: "assistant", timestamp: T("10:00:00") })], new Map());
		assert.equal(scan.typed_message_count, 0);
		assert.equal(scan.median_seconds, null);
		assert.equal(scan.p90_seconds, null);
		assert.deepEqual(scan.longest, []);
	});
});
