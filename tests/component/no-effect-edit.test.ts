/**
 * Component tests for NoEffectEdit (issue #255), exercised end-to-end through
 * the real AnalyzerFramework: tool-trajectory's signal and friction weight,
 * the stuck-loop it feeds, and failure-modes' class for the rejected case.
 *
 * Fixtures are hand-written synthetic sessions. No real session data, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	assertPlainRerunIsNoOpFill,
	type TestMessage,
} from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import type { Analyzer } from "../../src/analyze/types.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import {
	toolTrajectoryAnalyzer,
	TOOL_TRAJECTORY_DEF,
	type ToolTrajectoryProperties,
} from "../../src/analyze/analyzers/tool-trajectory/index.js";
import {
	failureModesAnalyzer,
	FAILURE_MODES_DEF,
	type FailureModesProperties,
} from "../../src/analyze/analyzers/failure-modes/index.js";
import { DEFAULT_TOOL_TRAJECTORY_CONFIG } from "../../src/analyze/analyzers/tool-trajectory/config.js";

/** One user turn in which the agent issues `edit` with `edits` and gets `isError` back. */
function editTurn(id: string, prompt: string, edits: Array<{ oldText: string; newText: string }>, isError = false): TestMessage[] {
	return [
		{ role: "user", text: prompt },
		{ role: "assistant", text: "editing", toolCalls: [{ id, name: "edit", arguments: { path: "src/config.ts", edits } }] },
		{ role: "toolResult", text: isError ? "No changes made to src/config.ts. The replacement produced identical content." : "Successfully replaced 1 block(s) in src/config.ts.", toolResults: [{ toolCallId: id, toolName: "edit", isError, textLength: 60 }] },
	];
}

const SAME = { oldText: "export const retries = 3;", newText: "export const retries = 3;" };
const CHANGE = { oldText: "export const retries = 3;", newText: "export const retries = 5;" };

async function seedAndRun(db: AsyncDatabase, sessionId: string, messages: TestMessage[], analyzers: Analyzer[]): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, messages);
	const fw = mockFramework(db);
	for (const a of analyzers) await fw.register(a);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
}

async function trajectory(db: AsyncDatabase): Promise<ToolTrajectoryProperties> {
	const nodes = await readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
	assert.equal(nodes.length, 1, "expected exactly one trajectory node");
	return JSON.parse(nodes[0]!.content_json) as ToolTrajectoryProperties;
}

describe("no-effect-edit component tests", () => {
	it("a silent no-op edit becomes a signal, a session count, and friction", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRun(db, "noop-once", [...editTurn("c1", "bump retries", [SAME]), ...editTurn("c2", "now really", [CHANGE])], [
				turnPairCoreAnalyzer,
				toolTrajectoryAnalyzer,
			]);
			const props = await trajectory(db);
			const signals = props.signals.filter((s) => s.pattern === "no-effect-edit");
			assert.equal(signals.length, 1, `got ${JSON.stringify(props.signals.map((s) => s.pattern))}`);
			assert.equal(signals[0]!.tool, "edit");
			assert.equal(signals[0]!.messageIds.length, 1);
			assert.match(signals[0]!.description, /src\/config\.ts/);
			assert.equal(props.pattern_counts["no-effect-edit"], 1);
			assert.equal(
				props.trajectory_friction_score,
				DEFAULT_TOOL_TRAJECTORY_CONFIG.noEffectEditWeight * DEFAULT_TOOL_TRAJECTORY_CONFIG.nonBlockingRiskMultiplier,
			);
		} finally {
			await close();
		}
	});

	it("repeated no-op edits to one file also read as a stuck-loop", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRun(
				db,
				"noop-loop",
				[...editTurn("c1", "bump retries", [SAME]), ...editTurn("c2", "it didn't change", [SAME]), ...editTurn("c3", "still 3", [SAME])],
				[turnPairCoreAnalyzer, toolTrajectoryAnalyzer],
			);
			const props = await trajectory(db);
			assert.equal(props.pattern_counts["no-effect-edit"], 3);
			assert.equal(props.pattern_counts["stuck-loop"], 1, "the retries that changed nothing form an unresolved loop");
		} finally {
			await close();
		}
	});

	it("a clean session produces a trajectory node with no signals", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRun(db, "clean", editTurn("c1", "bump retries", [CHANGE]), [turnPairCoreAnalyzer, toolTrajectoryAnalyzer]);
			const props = await trajectory(db);
			assert.deepEqual(props.signals, []);
			assert.equal(props.trajectory_friction_score, 0);
		} finally {
			await close();
		}
	});

	it("a no-op edit the tool rejected is failure-modes' no-effect-edit class, not a trajectory signal", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRun(db, "noop-rejected", editTurn("c1", "bump retries", [SAME], true), [
				turnPairCoreAnalyzer,
				toolTrajectoryAnalyzer,
				failureModesAnalyzer,
			]);
			const props = await trajectory(db);
			assert.equal(props.pattern_counts["no-effect-edit"], undefined);

			const fmNodes = await readAnalyzerNodes(db, FAILURE_MODES_DEF.id);
			assert.equal(fmNodes.length, 1);
			const fm = JSON.parse(fmNodes[0]!.content_json) as FailureModesProperties;
			assert.deepEqual(fm.groups.map((g) => g.class_id), ["no-effect-edit"]);
			assert.equal(fm.groups[0]!.causes[0]!.label, "replacement identical to the original");
		} finally {
			await close();
		}
	});

	it("a plain re-run is an idempotent no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRun(db, "noop-idem", editTurn("c1", "bump retries", [SAME]), [turnPairCoreAnalyzer]);
			await assertPlainRerunIsNoOpFill(mockFramework(db), toolTrajectoryAnalyzer, "noop-idem", () =>
				readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id),
			);
		} finally {
			await close();
		}
	});
});
