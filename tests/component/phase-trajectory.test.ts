/**
 * Component tests for the phase-trajectory analyzer (issue #115), exercised
 * end-to-end through the real AnalyzerFramework with turn-pair-core registered.
 * No real session data, no network: hand-written synthetic messages whose
 * tool_calls carry real command strings, so classification runs for real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	nodeEdges,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import {
	phaseTrajectoryAnalyzer,
	PHASE_TRAJECTORY_DEF,
	type PhaseTrajectoryProperties,
} from "../../src/analyze/analyzers/phase-trajectory/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";

const ANALYZER_ID = PHASE_TRAJECTORY_DEF.id;

/** One assistant turn issuing a bash call plus its paired result. */
function bashTurn(id: string, command: string): TestMessage[] {
	return [
		{
			id,
			role: "assistant",
			text: `running ${command}`,
			stopReason: "toolUse",
			toolCalls: [{ id: `${id}-call`, name: "bash", arguments: { command } }],
		},
		{
			role: "toolResult",
			text: "ok",
			toolResults: [{ toolCallId: `${id}-call`, toolName: "bash", isError: false, textLength: 4 }],
		},
	];
}

/** A user message opening a turn. */
function ask(id: string, text: string): TestMessage {
	return { id, role: "user", text };
}

/**
 * A compliant session: navigate → reproduce → patch → validate. Every signal
 * must stay quiet; the phase sequence is the whole story.
 */
function compliantSession(): TestMessage[] {
	return [
		ask("u1", "Something in src/a.ts is broken."),
		...bashTurn("a1", "grep -rn TODO src/"),
		...bashTurn("a2", "cat src/a.ts"),
		ask("u2", "Can you reproduce it first?"),
		...bashTurn("a3", "npm test"),
		ask("u3", "Fix it then."),
		...bashTurn("a4", "git add -A"),
		...bashTurn("a5", "git commit -m 'fix'"),
		ask("u4", "Did you verify?"),
		...bashTurn("a6", "npm test"),
	];
}

/** A premature patcher: commits before it has looked at or reproduced anything. */
function prematureSession(): TestMessage[] {
	return [
		ask("p1", "Just commit something."),
		...bashTurn("pa1", "git add -A"),
		...bashTurn("pa2", "git commit -m 'fix'"),
		ask("p2", "Run the tests now."),
		...bashTurn("pa3", "npm test"),
	];
}

async function runPhaseTrajectory(db: AsyncDatabase, sessionId: string, messages: TestMessage[]): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, messages);
	const fw = mockFramework(db);
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(phaseTrajectoryAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
}

function readPhaseNode(nodes: Array<Record<string, unknown>>): PhaseTrajectoryProperties {
	const row = nodes.find((n) => n["node_kind"] === "metric");
	assert.ok(row, "expected a metric node");
	return JSON.parse(row["content_json"] as string) as PhaseTrajectoryProperties;
}

describe("phase-trajectory component test", () => {
	it("classifies a compliant session's turns and emits zero signals through the framework", async () => {
		const { db, close } = await tempDb();
		try {
			await runPhaseTrajectory(db, "pt-compliant", compliantSession());

			const rows = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(rows.length, 1, "exactly one node per session");

			const props = readPhaseNode(rows as unknown as Array<Record<string, unknown>>);
			assert.equal(props.session_id, "pt-compliant");
			assert.deepEqual(
				props.phases.map((e) => e.phase),
				["navigate", "reproduce", "patch", "validate"],
			);
			assert.equal(props.patched, true);
			assert.equal(props.plan_violation_count, 0);
			assert.deepEqual(props.signals, []);
			// Evidence walks back to words: each entry names its opening user message.
			assert.deepEqual(
				props.phases.map((e) => e.user_message_id),
				["u1", "u2", "u3", "u4"],
			);

			// The node anchors to the session and consumes its declared dependency.
			const node = (rows as unknown as Array<Record<string, unknown>>)[0]!;
			const edges = await nodeEdges(db, node["id"] as string);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			const consumes = edges.filter((e) => e["edge_kind"] === "consumes" && e["to_ref_kind"] === "analysis_node");
			assert.ok(consumes.length >= 1, "must consume turn-pair-core nodes");
		} finally {
			await close();
		}
	});

	it("detects premature-patching on a commit-first session and keeps skip-validation quiet", async () => {
		const { db, close } = await tempDb();
		try {
			await runPhaseTrajectory(db, "pt-premature", prematureSession());
			const rows = await readAnalyzerNodes(db, ANALYZER_ID);
			const props = readPhaseNode(rows as unknown as Array<Record<string, unknown>>);

			assert.deepEqual(
				props.phases.map((e) => e.phase),
				["patch", "validate"],
			);
			const kinds = props.signals.map((s) => s.signal).sort();
			assert.deepEqual(kinds, ["premature-patching"]);
			assert.equal(props.signals[0]?.plan_violation, true);
			assert.deepEqual(props.signals[0]?.turn_indices, [0]);
			assert.equal(props.plan_violation_count, 1);
		} finally {
			await close();
		}
	});

	it("is idempotent: a plain re-run produces nothing and every identity stays untouched", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pt-idem");
			await insertMessages(db, "pt-idem", compliantSession());
			const fw = mockFramework(db);
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(phaseTrajectoryAnalyzer);

			const first = await fw.run("pt-idem", {});
			assert.equal(first.errors.length, 0);
			const before = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(before.length, 1);

			const second = await fw.run("pt-idem", {});
			assert.equal(second.errors.length, 0);
			assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing for this analyzer");

			const after = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.deepEqual(
				after.map((n) => [n.input_key, n.output_key]),
				before.map((n) => [n.input_key, n.output_key]),
				"recipe identities untouched by the re-run",
			);
		} finally {
			await close();
		}
	});

	it("a config change (stagnationMin override) revises the node beside its predecessor", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(
				db,
				phaseTrajectoryAnalyzer,
				"pt-revise",
				compliantSession(),
				{ stagnationMin: 3 },
			);
			assert.equal(before.length, 1);
			assert.equal(after.length, 2, "old version preserved as lineage");
			// The revised node re-classifies under the new config and stays signal-free here.
			const revised = readPhaseNode(after as unknown as Array<Record<string, unknown>>).session_id;
			assert.equal(revised, "pt-revise");
		} finally {
			await close();
		}
	});
});
