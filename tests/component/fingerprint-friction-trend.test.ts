import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The friction-trend section: accumulated friction and the sessions whose friction rose toward the end. */
describe("fingerprint: friction trend", () => {
	let g: GraphSeed;
	const node = (accumulated: number, declining: boolean) => ({
		turn_count: 10,
		accumulated_friction: accumulated,
		mean_friction: accumulated / 10,
		decline_verdict: { first_window_rate: 0, last_window_rate: 0.5, decline_delta: 0.5, decline_detected: declining },
		turn_contributions: [{ user_message_id: "hunter2" }],
		improvement_proposals: [],
	});
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 6; i++) await g.analysed(`s${i}`, "friction-accumulation", node(1.25, i < 5), "1.3");
		// 1.2 still counted pasted text as the person's frustration: not measured.
		for (let i = 0; i < 5; i++) await g.analysed(`old${i}`, "friction-accumulation", node(9, true), "1.2");
	});
	after(() => g.close());

	it("sums friction and counts declining sessions over sessions a current version measured", async () => {
		const s = await g.section("inferred", "frictionTrend");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 6);
		assert.equal(s["accumulatedFriction"], 7.5);
		assert.equal(s["decliningSessions"], 5);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
