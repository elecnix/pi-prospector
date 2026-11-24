import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The plan-compliance section: the four scores as percent distributions, one value per session. */
describe("fingerprint: plan compliance", () => {
	let g: GraphSeed;
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 6; i++) {
			await g.analysed(`s${i}`, "plan-compliance", { pc: i < 3 ? 1 : 0.5, ppc: 1, poc: 1, ppf: 0.25, digest_line: "hunter2" });
		}
	});
	after(() => g.close());

	it("spreads each score over percent buckets", async () => {
		const s = await g.section("objective", "planCompliance");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 6);
		const pc = s["compliance"] as { unit: string; p50: number; buckets: Array<{ from: number; sessions: number }> };
		assert.equal(pc.unit, "percent");
		assert.equal(pc.p50, 75);
		assert.equal(pc.buckets.reduce((n, b) => n + b.sessions, 0), 6);
		assert.equal((s["phaseFidelity"] as { p50: number }).p50, 25);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
