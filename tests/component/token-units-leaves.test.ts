import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession } from "./helpers.js";
import { buildLeaves } from "../../src/analyze/analyzers/token-units/leaves.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";

/**
 * The leaf's `source` field is the coding harness label rendered from the
 * session's recorded source. A session whose source is absent or orphaned must
 * read as "unknown", never silently as a host name — the hardening this feature
 * exists for.
 */

function tokenNode(sessionId: string, unit: number): AnalysisNodeRow {
	const segments = [
		{
			ordinal: 0,
			user_message_id: "u1",
			started_at: "2026-08-14T10:00:00Z",
			ended_at: "2026-08-14T10:05:00Z",
			totals: { input: unit, output: 0, cache_read: 0, cache_write: 0, equivalents: unit, mite: unit / 1_000_000, calls: 1 },
			models: ["m"],
		},
	];
	return {
		id: `node-${sessionId}`,
		session_id: sessionId,
		analyzer_id: "token-units",
		analyzer_version_id: "v",
		config_id: "cfg",
		run_id: "run",
		node_kind: "metric",
		content_json: JSON.stringify({
			session_id: sessionId,
			unit: "MITE",
			equivalents_per_mite: 1_000_000,
			weights: { input: 1, output: 15, cache_read: 0.1, cache_write: 1.25 },
			totals: segments[0]!.totals,
			by_model: { m: segments[0]!.totals },
			segments,
			coverage: { assistant_rows: 1, calls_without_usage: 0, rows_without_key: 0, billed_calls: 1 },
		}),
		source_set_hash: "sset",
		input_key: `ik-${sessionId}`,
		output_key: `ok-${sessionId}`,
		config_fingerprint: "cfg",
		model_used: null,
		cost_usd: null,
		tokens_used: null,
		duration_ms: null,
		created_at: "2026-08-14T12:00:00Z",
	};
}

describe("buildLeaves harness source", () => {
	it("labels leaves by harness, and an orphaned source as unknown, never Pi", () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s-orphan", "/tmp/orphan.jsonl", "", "");
			await insertSession(db, "s-bad", "/tmp/bad.jsonl", "", "bogus");
			// A node whose session row does not exist at all: the strongest orphan.
			await insertSession(db, "s-pi", "/tmp/pi.jsonl", "", "pi");
			await insertSession(db, "s-cl", "/tmp/cl.jsonl", "", "claude");

			const result = buildLeaves({
				db,
				tokenNodes: [
					tokenNode("s-pi", 100),
					tokenNode("s-cl", 200),
					tokenNode("s-orphan", 300),
					tokenNode("s-bad", 400),
					tokenNode("s-ghost", 500),
				],
				classNodes: [],
				previews: false,
			});

			const bySession = new Map(result.leaves.map((l) => [l.sessionId, l.source]));
			assert.equal(bySession.get("s-pi"), "Pi");
			assert.equal(bySession.get("s-cl"), "Claude");
			assert.equal(bySession.get("s-orphan"), "unknown", "an absent source must not read as pi");
			assert.equal(bySession.get("s-bad"), "unknown", "an unknown source must not read as pi");
			assert.equal(bySession.get("s-ghost"), "unknown", "a missing session must not read as pi");
		} finally {
await close();
		}
	});
});