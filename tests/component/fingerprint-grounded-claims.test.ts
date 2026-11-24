import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";

/** The grounded-claims section: ungrounded claims by kind, and unacted requests by type. */
describe("fingerprint: grounded claims", () => {
	let g: GraphSeed;
	const claim = (kind: string) => ({ user_message_id: "hunter2", pair_index: 0, signal: "ungrounded-claim", claim_kind: kind, claim: "hunter2", request_type: null, detail: "hunter2" });
	const request = (type: string) => ({ user_message_id: "hunter2", pair_index: 1, signal: "unacted-request", claim_kind: "request", claim: "hunter2", request_type: type, detail: "hunter2" });
	before(async () => {
		g = await GraphSeed.open();
		for (let i = 0; i < 6; i++) {
			await g.analysed(`s${i}`, "grounded-claims", claim("count"));
			await g.node(`s${i}`, "grounded-claims", claim("path"));
			await g.node(`s${i}`, "grounded-claims", request("test-run"));
		}
		// A session the analyzer ran on and found nothing in.
		await g.analysed("clean", "grounded-claims", null);
	});
	after(() => g.close());

	it("counts ungrounded claims by kind, and unacted requests by type", async () => {
		const s = await g.section("objective", "groundedClaims");
		assert.equal(s.status, "ok");
		assert.equal(s.sessionsMeasured, 7);
		assert.equal(s["ungroundedClaims"], 12);
		assert.equal(s["unactedRequests"], 6);
		assert.deepEqual(s["byKind"], [
			{ claimKind: "count", count: 6, sessions: 6 },
			{ claimKind: "path", count: 6, sessions: 6 },
		]);
		assert.deepEqual(s["unactedByRequest"], [{ requestType: "test-run", count: 6, sessions: 6 }]);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});
});
