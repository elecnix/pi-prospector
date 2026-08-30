import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer, type TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

async function runCore(db: import("better-sqlite3").Database, sessionId: string): Promise<TurnPairCoreProperties[]> {
	const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
	await fw.register(turnPairCoreAnalyzer);
	await fw.run(sessionId, {});
	const rows = (await db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core' ORDER BY rowid")
		.all()) as unknown as Array<{ content_json: string }>;
	return rows.map((r) => JSON.parse(r.content_json) as TurnPairCoreProperties);
}

describe("turn-pair-core deliberation paragraphs", () => {
	it("counts multi-paragraph reasoning across steps and emits null when absent", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				// pair 0: reasoning recorded across two assistant messages. Steps are joined
				// by a single newline, so per the documented split rule the last line of one
				// step and the first of the next land in the same paragraph.
				{ role: "user", text: "plan the work" },
				{ role: "assistant", thinking: "first consideration\n\nsecond one" },
				{ role: "assistant", thinking: "continuing that point" },
				// pair 1: no thinking recorded at all
				{ role: "user", text: "go ahead" },
				{ role: "assistant", text: "done" },
			]);
			const props = await runCore(db, "s1");
			assert.equal(props.length, 2);
			assert.equal(props[0]!.deliberation_paragraphs, 2);
			assert.equal(props[1]!.deliberation_paragraphs, null);
		} finally {
			await close();
		}
	});

	it("emits null rather than 0 for a turn whose assistant never reasoned", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "hi" },
				{ role: "assistant", text: "hello" },
			]);
			const props = await runCore(db, "s1");
			assert.equal(props[0]!.deliberation_paragraphs, null);
			assert.notEqual(props[0]!.deliberation_paragraphs, 0);
		} finally {
			await close();
		}
	});

	it("revises cleanly across the version bump and re-runs idempotently", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "think this through" },
				{ role: "assistant", thinking: "a\n\nb", text: "ok" },
			]);
			// Fill with a pre-bump analyzer (minor: 0), as an older install would have.
			const oldFw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
			await oldFw.register({ ...turnPairCoreAnalyzer, version: { ...turnPairCoreAnalyzer.version, minor: 0 } });
			await oldFw.run("s1", {});
			const before = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core'").get()) as { c: number };
			const beforeRows = (await db.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core'").all()) as unknown as Array<{ content_json: string }>;
			assert.equal(beforeRows.length, 1, "the old install filled each unit once");

			// The current (bumped) analyzer revises the stale unit; no crash.
			const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
			await fw.register(turnPairCoreAnalyzer);
			const revised = await fw.run("s1", { revise: ["minor"] });
			assert.ok(revised.nodesRevised >= 1, "the version bump marks the unit for revision");
			const after = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core'").get()) as { c: number };
			assert.ok(after.c > before.c, "a new version node was appended beside the old one");
			const edges = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE edge_kind = 'revises'").get()) as { c: number };
			assert.ok(edges.c >= 1, "the new node carries a revises edge back to its predecessor");

			// Idempotent re-run: same recipe over unchanged inputs adds nothing.
			const rerun = await fw.run("s1", {});
			assert.equal(rerun.nodesProduced + rerun.nodesRevised, 0);
			const finalCount = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core'").get()) as { c: number };
			assert.equal(finalCount.c, after.c);
		} finally {
			await close();
		}
	});
});

describe("turn-pair-core scoring", () => {
	it("scores a clean turn with low friction", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "please add a test" },
				{ role: "assistant", text: "added", toolCalls: [{ name: "edit" }] },
			]);
			const props = await runCore(db, "s1");
			assert.equal(props.length, 1);
			assert.equal(props[0]!.correction_detected, false);
			assert.equal(props[0]!.high_signal, false);
			assert.equal(props[0]!.friction_score, 0);
		} finally {
			await close();
		}
	});

	it("flags corrections, tool failures, waste, and empty responses", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
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
			await close();
		}
	});
});
