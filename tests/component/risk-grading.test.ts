/**
 * Component tests for risk-graded trajectory signals (issue #119), exercised
 * end-to-end through the real AnalyzerFramework. No real session data, no network.
 *
 * The fixtures are hand-written synthetic sessions whose agent (a) polls a PR
 * five times (polling-loop, non-blocking) and (b) switches branches
 * main → feature → main (checkout oscillation, blocking). Together they pin
 * down the friction arithmetic: non-blocking contributes weight × 1, blocking
 * weight × 2 by default, and both multipliers are config so changing them marks
 * nodes stale for the `config` reason and revises them behind a revises edge.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	mockFrameworkWithOverrides,
	readAnalyzerNodes,
	assertPlainRerunIsNoOpFill,
	bashCall,
	type TestMessage,
} from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import {
	toolTrajectoryAnalyzer,
	TOOL_TRAJECTORY_DEF,
	type ToolTrajectoryProperties,
} from "../../src/analyze/analyzers/tool-trajectory/index.js";

const DEFAULTS = toolTrajectoryAnalyzer.defaultConfig.configJson as unknown as {
	pollingLoopWeight: number;
	oscillationWeight: number;
	blockingRiskMultiplier: number;
	nonBlockingRiskMultiplier: number;
};

/** A poll of one read-only endpoint, once. */
function poll(text: string): TestMessage[] {
	return [
		{ role: "assistant", text, toolCalls: bashCall("gh pr view 29") },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 200 }] },
	];
}

/** One leg of a branch round-trip. */
function checkout(text: string, branch: string): TestMessage[] {
	return [
		{ role: "assistant", text, toolCalls: bashCall(`git checkout ${branch}`) },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 40 }] },
	];
}

/** Polls five times, then oscillates branches three ways: one signal of each class. */
function thrashSession(): TestMessage[] {
	return [
		{ role: "user", text: "check PR 29 and look around" },
		...poll("checking."),
		...poll("not yet."),
		...poll("still pending."),
		...poll("again."),
		...poll("waiting."),
		{ role: "user", text: "and the branches?" },
		...checkout("looking at main.", "main"),
		...checkout("switching to feature.", "feature"),
		...checkout("back to main.", "main"),
	];
}

async function seedAndRegister(db: AsyncDatabase, sessionId: string): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, thrashSession());
}

async function readProps(db: AsyncDatabase, inputKey?: string): Promise<ToolTrajectoryProperties> {
	const nodes = await readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
	assert.ok(nodes.length >= 1, "expected at least one trajectory node");
	const row = inputKey ? nodes.find((n) => n.input_key === inputKey) : nodes[nodes.length - 1];
	assert.ok(row, `expected a trajectory node${inputKey ? ` with input_key ${inputKey}` : ""}`);
	return JSON.parse(row!.content_json) as ToolTrajectoryProperties;
}

describe("risk-graded friction weighting through the framework", () => {
	it("blocking contributes weight × default multiplier, non-blocking weight × 1", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRegister(db, "risk-weights");
			const fw = mockFramework(db);
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(toolTrajectoryAnalyzer);
			const summary = await fw.run("risk-weights", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const props = await readProps(db);

			const polling = props.signals.find((s) => s.pattern === "polling-loop");
			const osc = props.signals.find((s) => s.pattern === "oscillation");
			assert.ok(polling, "expected a polling-loop (non-blocking) signal");
			assert.ok(osc, "expected an oscillation (blocking) signal");
			assert.equal(polling!.riskClass, "non-blocking");
			assert.equal(osc!.riskClass, "blocking");

			const expected =
				DEFAULTS.pollingLoopWeight * DEFAULTS.nonBlockingRiskMultiplier +
				DEFAULTS.oscillationWeight * DEFAULTS.blockingRiskMultiplier;
			assert.ok(
				Math.abs(props.trajectory_friction_score - Math.min(1, expected)) < 1e-9,
				`expected polling×1 + oscillation×2 = ${Math.min(1, expected)}, got ${props.trajectory_friction_score}`,
			);
		} finally {
			await close();
		}
	});

	it("a plain re-run is an idempotent no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRegister(db, "risk-idem");
			// Fill dependency nodes on their own framework first so the counted
			// skips belong to this analyzer alone.
			const coreFw = mockFramework(db);
			await coreFw.register(turnPairCoreAnalyzer);
			await coreFw.run("risk-idem", {});

			const fw = mockFramework(db);
			await assertPlainRerunIsNoOpFill(fw, toolTrajectoryAnalyzer, "risk-idem", () =>
				readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id),
			);
		} finally {
			await close();
		}
	});

	it("changing a risk multiplier marks the unit stale/config and revises it beside its predecessor", async () => {
		const { db, close } = await tempDb();
		try {
			await seedAndRegister(db, "risk-config");

			// Baseline run under defaults.
			const fw = mockFramework(db);
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(toolTrajectoryAnalyzer);
			await fw.run("risk-config", {});
			const before = await readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
			assert.equal(before.length, 1);

			// Lower the blocking multiplier to 1: the score must drop to
			// polling×1 + oscillation×1, recomputed only because the run asked
			// for `config`.
			const revisedFw = mockFrameworkWithOverrides(db, TOOL_TRAJECTORY_DEF.id, { blockingRiskMultiplier: 1 });
			await revisedFw.register(turnPairCoreAnalyzer);
			await revisedFw.register(toolTrajectoryAnalyzer);
			const revisedRun = await revisedFw.run("risk-config", { revise: ["config"] });
			assert.equal(revisedRun.errors.length, 0);
			assert.equal(revisedRun.nodesRevised, 1, "the unit was revised under new config");

			const after = await readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
			assert.equal(after.length, 2, "old version preserved as lineage beside the revision");
			const newNode = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(newNode, "revised node carries a new recipe identity");

			const reviseEdges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'revises'")
				.all(newNode!.id)) as unknown as Array<Record<string, unknown>>;
			assert.equal(reviseEdges.length, 1, "a revises edge links the revision to its predecessor");

			const revisedProps = JSON.parse(newNode!.content_json) as ToolTrajectoryProperties;
			const expected = DEFAULTS.pollingLoopWeight + DEFAULTS.oscillationWeight;
			assert.ok(
				Math.abs(revisedProps.trajectory_friction_score - expected) < 1e-9,
				`with multiplier 1 the score is weight-sum ${expected}, got ${revisedProps.trajectory_friction_score}`,
			);
		} finally {
			await close();
		}
	});
});
