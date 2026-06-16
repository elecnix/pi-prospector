import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer, type TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

async function runCore(db: import("better-sqlite3").Database, sessionId: string): Promise<TurnPairCoreProperties[]> {
	const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
	fw.register(turnPairCoreAnalyzer);
	await fw.run(sessionId, {});
	const rows = db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core' ORDER BY rowid")
		.all() as Array<{ content_json: string }>;
	return rows.map((r) => JSON.parse(r.content_json) as TurnPairCoreProperties);
}

describe("turn-pair-core scoring", () => {
	it("scores a clean turn with low friction", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [
				{ role: "user", text: "please add a test" },
				{ role: "assistant", text: "added", toolCalls: [{ name: "edit" }] },
			]);
			const props = await runCore(db, "s1");
			assert.equal(props.length, 1);
			assert.equal(props[0]!.correction_detected, false);
			assert.equal(props[0]!.high_signal, false);
			assert.equal(props[0]!.friction_score, 0);
		} finally {
			close();
		}
	});

	it("flags corrections, tool failures, waste, and empty responses", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s1");
			insertMessages(db, "s1", [
				// pair 0: correction + tool failure
				{ role: "user", text: "no, that's wrong, use yarn" },
				{ role: "assistant", text: "ok", toolCalls: [{ name: "bash" }] },
				{ role: "toolResult", toolResults: [{ toolName: "bash", isError: true, textLength: 10 }] },
				// pair 1: huge tool output (waste) + empty assistant response
				{ role: "user", text: "show me the file" },
				{ role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 50000 }] },
			]);
			const props = await runCore(db, "s1");
			assert.equal(props.length, 2);

			const p0 = props[0]!;
			assert.equal(p0.correction_detected, true);
			assert.equal(p0.tool_failure_count, 1);
			assert.ok(p0.friction_score >= 0.5);
			assert.equal(p0.high_signal, true);

			const p1 = props[1]!;
			assert.ok(p1.tool_waste_bytes > 0);
			assert.equal(p1.empty_response, true);
			assert.ok(p1.friction_score > 0);
		} finally {
			close();
		}
	});
});
