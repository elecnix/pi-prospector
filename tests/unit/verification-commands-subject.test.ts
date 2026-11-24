import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairEdges, type LineageHead } from "../../src/analyze/lineage.js";
import { verificationCommandsAnalyzer } from "../../src/analyze/analyzers/verification-commands/index.js";

/** Two commands judged by two runs of one session are two subjects: neither verdict replaces the other. */
describe("verification-commands lineage", () => {
	const head = (id: string, command: string, at: string): LineageHead => ({
		id,
		session_id: "s",
		output_key: `o-${id}`,
		run_id: `r-${id}`,
		created_at: at,
		analyzer_version_id: "1.0",
		anchor_ref: "s",
		content_json: JSON.stringify({ command, verdict: "full" }),
	});

	it("keeps both verdicts when a grown session adds a command", () => {
		const heads = [head("a", "tox", "2026-01-01"), head("b", "just gate", "2026-01-02")];
		assert.deepEqual(repairEdges(heads, verificationCommandsAnalyzer.subjectOfNode), []);
	});

	it("links two generations of one command", () => {
		const heads = [head("a", "tox", "2026-01-01"), head("b", "tox", "2026-01-02")];
		assert.deepEqual(repairEdges(heads, verificationCommandsAnalyzer.subjectOfNode), [{ fromNodeId: "b", toOutputKey: "o-a" }]);
	});
});
