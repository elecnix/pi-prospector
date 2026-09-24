/**
 * Component tests for the thought-oscillation detector (issue #117), exercised
 * end-to-end through the real AnalyzerFramework. No real session data, no network.
 *
 * The fixtures are hand-written synthetic sessions whose assistant turns carry
 * private reasoning (`thinking`) but no state-changing tool calls: the exact
 * shape thought-oscillation exists to catch — repeated reasoning without
 * progress. The contrast fixture makes every turn act as well as think, which
 * is legitimate reconsideration and must stay quiet.
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
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import {
	toolTrajectoryAnalyzer,
	TOOL_TRAJECTORY_DEF,
	ToolTrajectoryProperties,
} from "../../src/analyze/analyzers/tool-trajectory/index.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";

/** A long-enough synthetic reasoning block (~45 words) so it fingerprints. */
const LOOPED_THOUGHT =
	"The failing check keeps reporting the same missing export, so the bundler entry point must still " +
	"reference the old module path that was renamed earlier in this branch; before touching any file I " +
	"should trace where the import graph resolves from, then decide whether the rename or the entry " +
	"config is at fault, because editing the wrong side would undo the previous attempt again.";

function thinkingTurn(text: string): TestMessage[] {
	return [{ role: "assistant", text: "", thinking: text }];
}

/**
 * Three consecutive turns where the agent thinks the same dead end and never
 * acts: the canonical thought-oscillation session.
 */
function loopSession(): TestMessage[] {
	return [
		{ role: "user", text: "why is the build red?" },
		...thinkingTurn(LOOPED_THOUGHT),
		{ role: "user", text: "still red." },
		...thinkingTurn(LOOPED_THOUGHT),
		{ role: "user", text: "and now?" },
		...thinkingTurn(LOOPED_THOUGHT),
	];
}

/** The agent re-thinks AND acts each turn — legitimate reconsideration, not a loop. */
function reconsiderAndActSession(): TestMessage[] {
	const editTurn = (): TestMessage[] => [
		{ role: "assistant", text: "adjusting", thinking: LOOPED_THOUGHT, toolCalls: [{ name: "edit", arguments: { file_path: "/tmp/proj/src/main.ts" } }] },
		{ role: "toolResult", toolResults: [{ toolName: "edit", isError: false, textLength: 60 }] },
	];
	return [
		{ role: "user", text: "fix it" },
		...editTurn(),
		{ role: "user", text: "try again" },
		...editTurn(),
		{ role: "user", text: "once more" },
		...editTurn(),
	];
}

async function seedAndRun(db: AsyncDatabase, sessionId: string, messages: TestMessage[]): Promise<AnalysisNodeRow[]> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, messages);
	const fw = mockFramework(db);
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(toolTrajectoryAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
	return readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
}

async function readTrajectoryNode(nodes: AnalysisNodeRow[]): Promise<ToolTrajectoryProperties> {
	assert.equal(nodes.length, 1, "expected exactly one trajectory node");
	return JSON.parse(nodes[0]!.content_json) as ToolTrajectoryProperties;
}

describe("thought-oscillation component tests", () => {
	it("fires through the framework on repeated no-action reasoning turns", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await seedAndRun(db, "thought-loop", loopSession());
			const props = await readTrajectoryNode(nodes);

			const signals = props.signals.filter((s) => s.pattern === "thought-oscillation");
			assert.equal(signals.length, 1, `expected exactly one thought-oscillation signal, got ${JSON.stringify(props.signals.map((s) => s.pattern))}`);
			assert.equal(signals[0]!.count, 3, "the signal spans all three identical thinking turns");
			assert.equal(signals[0]!.messageIds.length, 3);
			assert.ok((signals[0]!.similarity ?? 0) >= 0.85);

			// It contributes its configured weight to the friction score.
			assert.equal(props.pattern_counts["thought-oscillation"], 1);
			assert.ok(
				Math.abs(props.trajectory_friction_score - toolTrajectoryAnalyzer.defaultConfig.configJson["thoughtOscillationWeight"]) < 1e-9,
				`friction score should equal the single signal's weight, got ${props.trajectory_friction_score}`,
			);

			// And it reaches the digest line shape the synthesiser reads.
			assert.match(signals[0]!.description, /Thought oscillation/);
		} finally {
			await close();
		}
	});

	it("stays quiet when every re-think is followed by an action", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await seedAndRun(db, "reconsider-act", reconsiderAndActSession());
			const props = await readTrajectoryNode(nodes);
			assert.equal(
				props.signals.filter((s) => s.pattern === "thought-oscillation").length,
				0,
				`re-think-then-act must not fire, got ${JSON.stringify(props.signals)}`,
			);
			assert.equal(props.trajectory_friction_score, 0);
		} finally {
			await close();
		}
	});

	it("a plain re-run is an idempotent no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "thought-idem");
			await insertMessages(db, "thought-idem", loopSession());
			// Fill the consumed dependency nodes on their own framework first.
			const coreFw = mockFramework(db);
			await coreFw.register(turnPairCoreAnalyzer);
			await coreFw.run("thought-idem", {});

			// Then check idempotency of this analyzer alone: the helper counts every
			// unit the framework skips, so it must not share its framework with others.
			const fw = mockFramework(db);
			await assertPlainRerunIsNoOpFill(fw, toolTrajectoryAnalyzer, "thought-idem", () =>
				readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id),
			);
		} finally {
			await close();
		}
	});

	it("old-version nodes revise cleanly behind a revises edge on the major bump", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "thought-lineage");
			await insertMessages(db, "thought-lineage", loopSession());

			// Fill the graph under the pre-bump major version (v2.0).
			const legacy: typeof toolTrajectoryAnalyzer = {
				...toolTrajectoryAnalyzer,
				version: { ...toolTrajectoryAnalyzer.version, major: 2, minor: 0 },
			};
			const oldFw = mockFramework(db);
			await oldFw.register(turnPairCoreAnalyzer);
			await oldFw.register(legacy);
			const firstRun = await oldFw.run("thought-lineage", {});
			assert.equal(firstRun.errors.length, 0);
			const before = await readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
			assert.equal(before.length, 1);

			// The current analyzer (v3.0) sees those units stale for the `major`
			// reason; --revise major recomputes them beside their predecessor.
			const newFw = mockFramework(db);
			await newFw.register(turnPairCoreAnalyzer);
			await newFw.register(toolTrajectoryAnalyzer);
			const revisedRun = await newFw.run("thought-lineage", { revise: ["major"] });
			assert.equal(revisedRun.errors.length, 0);
			assert.equal(revisedRun.nodesRevised, 1, "the unit was revised under the bumped version");

			const after = await readAnalyzerNodes(db, TOOL_TRAJECTORY_DEF.id);
			assert.equal(after.length, 2, "old version preserved as lineage beside the revision");
			const newNode = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(newNode, "revised node carries a new recipe identity");

			const edges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'revises'")
				.all(newNode!.id)) as unknown as Array<Record<string, unknown>>;
			assert.equal(edges.length, 1, "a revises edge links the revision to its predecessor");

			// The revised node still detects the loop.
			const props = JSON.parse(newNode!.content_json) as ToolTrajectoryProperties;
			assert.ok(props.signals.some((s) => s.pattern === "thought-oscillation"), "revised node still carries the signal");
		} finally {
			await close();
		}
	});
});
