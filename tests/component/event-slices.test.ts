/**
 * Component test for event-centered evidence slices (issue #118, after
 * LivePlan §II-B): a turn escalated to the turn-pair-llm classifier must carry
 * the turns since the previous trigger point (here: a stuck-loop trajectory
 * signal), not just the current turn — and the whole flow must stay idempotent,
 * with a bumped version revising cleanly through lineage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TempDb } from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLM } from "../../src/analyze/mock-llm.js";
import { registerAll } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { toolTrajectoryAnalyzer } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";

const SLICE_SESSION = "s-slices";

/**
 * Three identical failing `npm install` calls across three turns. The run of
 * repeats forms a stuck-loop trajectory signal; the third turn's user text is
 * an explicit correction, so turn-pair-core flags it high-signal and the LLM
 * classifier escalates it.
 */
async function seed(db: AsyncDatabase, sessionId: string): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, [
		{ role: "user", text: "install dependencies" },
		{ role: "assistant", text: "running npm install", toolCalls: [{ name: "bash", arguments: { command: "npm install" } }] },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: true, textLength: 40 }] },
		{ role: "user", text: "still broken, run it again" },
		{ role: "assistant", text: "trying again", toolCalls: [{ name: "bash", arguments: { command: "npm install" } }] },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: true, textLength: 40 }] },
		{ role: "user", text: "no, that's wrong, install them properly" },
		{ role: "assistant", text: "understood, fixing the install", toolCalls: [{ name: "bash", arguments: { command: "npm install" } }] },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: true, textLength: 40 }] },
	]);
}

/** Register only the slice-relevant analyzers (frustration chain stays out). */
function builtins() {
	return [turnPairCoreAnalyzer, toolTrajectoryAnalyzer, turnPairLLMAnalyzer];
}

function makeFramework(t: TempDb, mock: MockLLM) {
	return new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
}

describe("event-centered evidence slices (issue #118)", () => {
	it("the escalated classify prompt carries the turns since the previous trigger", async () => {
		const t = await tempDb();
		try {
			await seed(t.db, SLICE_SESSION);
			const mock = createMockLLM({
				responder: () => JSON.stringify({ sentiment: "frustrated", friction_type: "repetition", is_genuine_correction: true, severity: "medium", rationale: "stub" }),
			});
			const fw = makeFramework(t, mock);
			const { errors } = await registerAll(fw, { builtins: builtins() });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(SLICE_SESSION, { analyzerIds: ["turn-pair-llm"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// The deterministic layer detected the loop…
			const trajRow = await t.db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'tool-trajectory'")
				.get() as { content_json: string };
			assert.ok(trajRow, "trajectory node exists");
			const signals = (JSON.parse(trajRow!.content_json) as { signals: Array<{ pattern: string }> }).signals;
			assert.ok(signals.some((s) => s.pattern === "stuck-loop"), "stuck-loop fired");

			// …and the escalated prompt carries the run-up since the previous trigger.
			const classifyCalls = mock.calls.filter((c) => c.system?.includes("classify a single turn"));
			assert.equal(classifyCalls.length, 1, "exactly one turn was escalated");
			const prompt = classifyCalls[0]!.user;
			assert.ok(prompt.includes("PRIOR TURNS SINCE LAST SIGNAL"), prompt);
			// Previous trigger is the stuck-loop's earlier participants at pair #1 →
			// the slice starts there; pair #0 falls before it and stays out.
			assert.ok(prompt.includes("--- prior turn #1 ---"), prompt);
			assert.ok(prompt.includes("still broken, run it again"), prompt);
			assert.ok(!prompt.includes("install dependencies"), "turns before the previous trigger are excluded:\n" + prompt);
		} finally {
			await t.close();
		}
	});

	it("re-running without changes produces no new nodes (idempotency)", async () => {
		const t = await tempDb();
		try {
			await seed(t.db, SLICE_SESSION);
			const mock = createMockLLM({
				responder: () => JSON.stringify({ sentiment: "neutral", friction_type: "none", is_genuine_correction: false, severity: "low", rationale: "stub" }),
			});
			const fw = makeFramework(t, mock);
			await registerAll(fw, { builtins: builtins() });

			const first = await fw.run(SLICE_SESSION, { analyzerIds: ["turn-pair-llm"] });
			assert.equal(first.errors.length, 0, first.errors.join("; "));
			assert.ok(first.nodesProduced >= 1);

			const second = await fw.run(SLICE_SESSION, { analyzerIds: ["turn-pair-llm"] });
			assert.equal(second.errors.length, 0, second.errors.join("; "));
			assert.equal(second.nodesProduced, 0, "a re-run reproduces identity and recomputes nothing");
			const classifyAfterRerun = mock.calls.filter((c) => c.system?.includes("classify a single turn")).length;
			assert.equal(classifyAfterRerun, 1, "no second model call");
		} finally {
			await t.close();
		}
	});

	it("a minor version bump revises cleanly: revises edges link old to new", async () => {
		const t = await tempDb();
		try {
			await seed(t.db, SLICE_SESSION);
			const fillMock = createMockLLM({
				responder: () => JSON.stringify({ sentiment: "neutral", friction_type: "none", is_genuine_correction: false, severity: "low", rationale: "stub" }),
			});
			const fw = makeFramework(t, fillMock);
			await registerAll(fw, { builtins: builtins() });
			await fw.run(SLICE_SESSION, { analyzerIds: ["turn-pair-llm"] });

			// A shipped improvement bumps the version; --revise minor recomputes the
			// stale units into new versions linked back by revises edges.
			const bumped = {
				...turnPairLLMAnalyzer,
				version: { ...turnPairLLMAnalyzer.version, minor: turnPairLLMAnalyzer.version.minor + 1 },
			};
			const reviseMock = createMockLLM({
				responder: () => JSON.stringify({ sentiment: "frustrated", friction_type: "repetition", is_genuine_correction: false, severity: "high", rationale: "revised stub" }),
			});
			const fw2 = makeFramework(t, reviseMock);
			await registerAll(fw2, {
				builtins: [turnPairCoreAnalyzer, toolTrajectoryAnalyzer, bumped],
			});
			const summary = await fw2.run(SLICE_SESSION, { analyzerIds: ["turn-pair-llm"], revise: ["minor"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.ok(summary.nodesRevised >= 1, "the bumped version revises at least one unit");

			const revisedEdges = await t.db
				.prepare("SELECT COUNT(*) AS n FROM analysis_edges WHERE edge_kind = 'revises' AND to_ref_kind = 'analysis_node'")
				.get() as { n: number };
			assert.ok(revisedEdges.n >= 1, "revises edges recorded in the graph");
		} finally {
			await t.close();
		}
	});
});
