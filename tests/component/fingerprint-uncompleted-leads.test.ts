import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The uncompleted-leads section: leads tool output surfaced, and those no later call pursued, by type. */
describe("fingerprint: uncompleted leads", () => {
	let g: GraphSeed;
	const node = (path: number, url: number) => ({
		lead_count: 10,
		completed_count: 10 - path - url,
		uncompleted_count: path + url,
		uncompleted_by_type: { path, url },
		leads: [{ type: "path", value: "/home/secret/path", source_message_id: "hunter2", tool_call_ordinal: 0, status: "uncompleted", completed_by_message_id: null }],
		improvement_proposals: [],
	});
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 6; i++) await g.analysed(`s${i}`, "uncompleted-leads", node(2, i < 5 ? 1 : 0), "1.1");
	});
	after(() => g.close());

	it("counts surfaced and uncompleted leads, by type", async () => {
		const s = await g.section("objective", "uncompletedLeads");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 6);
		assert.equal(s["leads"], 60);
		assert.equal(s["uncompleted"], 17);
		assert.deepEqual(s["uncompletedByType"], [
			{ leadType: "path", count: 12, sessions: 6 },
			{ leadType: "url", count: 5, sessions: 5 },
		]);
		const text = JSON.stringify(s);
		assert.ok(!text.includes("hunter2") && !text.includes("/home"));
	});
});
