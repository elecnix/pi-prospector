import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The compaction section: summaries graded against the checklist, and the leads they lost. */
describe("fingerprint: compaction summaries", () => {
	let g: GraphSeed;
	const summary = (unresolved: boolean) => ({
		message_id: "hunter2",
		message_ordinal: 3,
		facet_coverage: { conclusions_present: true, source_references: { total_leads: 2, retained_leads: 1 }, unresolved_items: unresolved, abandoned_directions: false },
		covered_facet_count: unresolved ? 3 : 2,
		leads_total: 2,
		leads_retained: 1,
		leads_lost: [{ type: "path", value: "/home/secret/path" }],
	});
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 6; i++) {
			await g.analysed(`s${i}`, "compression-checklist", { summaries: [summary(true), summary(i < 5)], summary_count: 2, fully_covered_count: 0, leads_lost_count: 2, improvement_proposals: [] }, "1.1");
		}
		// Never compacted: measured, with nothing to grade.
		for (let i = 0; i < 4; i++) await g.analysed(`plain${i}`, "compression-checklist", null, "1.1");
		// Last run at 1.1 in fill mode, which left its 1.0 node current: not measured.
		await g.analysed("filled", "compression-checklist", null, "1.1");
		await g.node("filled", "compression-checklist", { summaries: [summary(true)], summary_count: 1, fully_covered_count: 0, leads_lost_count: 9, improvement_proposals: [] }, "1.0");
	});
	after(() => g.close());

	it("counts summaries, covered facets, and lost leads", async () => {
		const s = await g.section("objective", "compaction");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 10);
		assert.equal(s["compactedSessions"], 6);
		assert.equal(s["summaries"], 12);
		assert.equal(s["fullyCovered"], 0);
		assert.equal(s["leadsLost"], 12);
		assert.deepEqual(s["summariesByFacet"], [
			{ facet: "conclusions_present", count: 12, sessions: 6 },
			{ facet: "unresolved_items", count: 11, sessions: 6 },
		]);
		const text = JSON.stringify(s);
		assert.ok(!text.includes("hunter2") && !text.includes("/home"));
	});
});
