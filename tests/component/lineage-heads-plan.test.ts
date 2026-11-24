import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.js";
import { lineageHeadsSql } from "../../src/db/analysis-queries.js";

/**
 * The lineage heads query looks up each head's anchor edge. The lookup must go
 * through the node's own edges (`idx_edges_from`). Through `idx_edges_kind` it
 * reads every `anchors` edge in the graph once per head, so the repair of a
 * corpus with a million nodes never finishes.
 */
describe("lineage heads query plan", () => {
	for (const sessionScoped of [false, true]) {
		it(`finds each head's anchor through the node's own edges (session-scoped: ${sessionScoped})`, async () => {
			const t = await tempDb();
			try {
				const params = sessionScoped ? ["an-analyzer", "a-session"] : ["an-analyzer"];
				const rows = (await t.db
					.prepare(`EXPLAIN QUERY PLAN ${lineageHeadsSql(sessionScoped, true)}`)
					.all(...params)) as Array<{ detail: string }>;
				const edgeSearches = rows.map((r) => r.detail).filter((d) => /\bSEARCH a\b/.test(d));
				assert.equal(edgeSearches.length, 1, `one search of the anchor edges: ${JSON.stringify(rows.map((r) => r.detail))}`);
				assert.match(edgeSearches[0]!, /idx_edges_from/);
			} finally {
				await t.close();
			}
		});
	}
});
