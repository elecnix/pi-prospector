import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The phases section: turns by phase, patched sessions, and phase-order signals, from the current nodes. */
describe("fingerprint: phases", () => {
	let g: GraphSeed;
	const phases = (...p: string[]) => p.map((phase, i) => ({ turn_index: i, phase, user_message_id: "hunter2", message_ids: [], sample_commands: ["hunter2"] }));
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 6; i++) {
			await g.analysed(`s${i}`, "phase-trajectory", {
				phases: phases("navigate", "patch", "validate"),
				signals: i < 5 ? [{ signal: "prolonged-stagnation", plan_violation: false, risk_class: "non-blocking" }] : [],
				patched: true,
			}, "1.1");
		}
	});
	after(() => g.close());

	it("counts turns by phase from the current nodes", async () => {
		const s = await g.section("objective", "phases");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 6);
		assert.deepEqual(s["turnsByPhase"], [
			{ phase: "navigate", count: 6, sessions: 6 },
			{ phase: "patch", count: 6, sessions: 6 },
			{ phase: "validate", count: 6, sessions: 6 },
		]);
		assert.equal(s["patchedSessions"], 6);
		assert.deepEqual(s["signals"], [{ signal: "prolonged-stagnation", count: 5, sessions: 5 }]);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
