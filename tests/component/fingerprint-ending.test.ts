import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The ending section: how sessions ended, by label and by the rule that decided it. */
describe("fingerprint: session ending", () => {
	let g: GraphSeed;
	const ending = (label: string, rule: string) => ({ label, evidence: { final_message_id: "hunter2", final_role: "assistant", rule, final_assistant_excerpt: "hunter2", verification_found: true, verification_ok: true, verification_pattern: "hunter2" } });
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 5; i++) await g.analysed(`ok${i}`, "session-ending", ending("resolved", "verification_passed"), "1.1");
		for (let i = 0; i < 5; i++) await g.analysed(`cut${i}`, "session-ending", ending("abandoned", "cut_off_mid_work"), "1.1");
		// 1.0 read every session indexed before call ids as abandoned: not measured.
		for (let i = 0; i < 5; i++) await g.analysed(`old${i}`, "session-ending", ending("abandoned", "no_recorded_results"), "1.0");
	});
	after(() => g.close());

	it("counts sessions by label and by rule, from a version that pairs results", async () => {
		const s = await g.section("objective", "ending");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 10);
		assert.deepEqual(s["byLabel"], [
			{ label: "abandoned", count: 5, sessions: 5 },
			{ label: "resolved", count: 5, sessions: 5 },
		]);
		assert.deepEqual(s["byRule"], [
			{ rule: "cut_off_mid_work", count: 5, sessions: 5 },
			{ rule: "verification_passed", count: 5, sessions: 5 },
		]);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
