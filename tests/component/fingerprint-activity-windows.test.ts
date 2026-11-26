import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

// The part of the day is read on the clock of the process that builds the fingerprint.
process.env["TZ"] = "UTC";

/** The activity-windows section: peak concurrency per session. The parts of the day are not published. */
describe("fingerprint: activity windows", () => {
	let g: GraphSeed;
	const at = (h: number) => new Date(Date.parse("2026-03-02T00:00:00.000Z") + h * 3_600_000).toISOString();
	before(async () => {
		g = await GraphSeed.open();
		// Five sessions side by side in the morning, five alone in the evening, a day apart.
		for (let i = 0; i < 5; i++) await g.analysed(`par${i}`, "activity-windows", { windows: [{ start: at(8), end: at(9) }], active_seconds: 3600, untimed_message_count: 0 });
		for (let i = 0; i < 5; i++) await g.analysed(`solo${i}`, "activity-windows", { windows: [{ start: at(24 * (i + 1) + 19), end: at(24 * (i + 1) + 20) }], active_seconds: 3600, untimed_message_count: 0 });
	});
	after(() => g.close());

	it("buckets sessions by peak concurrency and publishes no part of the day", async () => {
		const s = await g.section("objective", "activityWindows");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 10);
		assert.deepEqual(s["byPeakConcurrency"], [
			{ concurrent: "1", count: 5, sessions: 5 },
			{ concurrent: "5-9", count: 5, sessions: 5 },
		]);
		assert.equal(s["minutesByPartOfDay"], undefined);
	});
});
