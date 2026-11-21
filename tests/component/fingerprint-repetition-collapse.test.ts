import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The repetition-collapse section: steps that looped on repeated text, and those that delivered nothing. */
describe("fingerprint: repetition collapse", () => {
	let g: GraphSeed;
	const step = (channel: string, delivered: boolean) => ({ message_id: "hunter2", user_message_id: "hunter2", pair_index: 0, channel, measure: { motif: "hunter2" }, reasoning_chars: 9000, delivered, model: "hunter2" });
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 5; i++) {
			await g.analysed(`s${i}`, "repetition-collapse", { judged_step_count: 20, collapsed: [step("reasoning", false), step("answer", true)], collapsed_step_count: 2, undelivered_step_count: 1, undelivered_cost_usd: null, improvement_proposals: [] });
		}
		for (let i = 0; i < 3; i++) await g.analysed(`clean${i}`, "repetition-collapse", { judged_step_count: 20, collapsed: [], collapsed_step_count: 0, undelivered_step_count: 0, undelivered_cost_usd: null, improvement_proposals: [] });
	});
	after(() => g.close());

	it("counts judged, collapsed and undelivered steps, and collapsed steps by channel", async () => {
		const s = await g.section("objective", "repetitionCollapse");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 8);
		assert.equal(s["judgedSteps"], 160);
		assert.equal(s["collapsedSteps"], 10);
		assert.equal(s["undeliveredSteps"], 5);
		assert.equal(s["sessionsWithCollapse"], 5);
		assert.deepEqual(s["byChannel"], [
			{ channel: "answer", count: 5, sessions: 5 },
			{ channel: "reasoning", count: 5, sessions: 5 },
		]);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
