import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The revive-chains section: chains of revived child agents, and the spawns they cost. */
describe("fingerprint: revive chains", () => {
	let g: GraphSeed;
	const node = (chains: number, redundant: number) => ({ chain_count: chains, redundant_spawn_count: redundant, revived_result_count: redundant + chains, chains: [], remedy: "hunter2" });
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 5; i++) await g.analysed(`s${i}`, "revive-chains", node(1, 3), "1.1");
		// Ran at 1.1 and never talked to a child agent: measured, with no chain.
		for (let i = 0; i < 3; i++) await g.analysed(`quiet${i}`, "revive-chains", null, "1.1");
		// Ran only at 1.0, which missed the results of sessions indexed before call ids: not measured.
		await g.analysed("old", "revive-chains", node(0, 0), "1.0");
		// Last run at 1.1 in fill mode, which left its 1.0 node current: not measured.
		await g.analysed("filled", "revive-chains", null, "1.1");
		await g.node("filled", "revive-chains", node(7, 7), "1.0");
	});
	after(() => g.close());

	it("counts chains and redundant spawns over the sessions a version that finds them measured", async () => {
		const s = await g.section("objective", "reviveChains");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 8);
		assert.equal(s["sessionsWithChains"], 5);
		assert.equal(s["chains"], 5);
		assert.equal(s["redundantSpawns"], 15);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
