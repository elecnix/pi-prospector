/**
 * Component tests for the plan-compliance analyzer (issue #121), exercised
 * end-to-end through the real AnalyzerFramework with turn-pair-core and
 * phase-trajectory registered. No real session data, no network: hand-written
 * synthetic messages whose tool_calls carry real command strings.
 *
 * Covers the metric math on a framework-produced node, the consumes edge back
 * to the phase node, idempotent re-runs, and dependency staleness wiring — a
 * recomputed phase-trajectory node must force honest recomputation here.
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
	nodeEdges,
	type TestMessage,
} from "./helpers.js";
import type { AsyncDatabase, } from "../../src/db/async-db.js";
import {
	planComplianceAnalyzer,
	PLAN_COMPLIANCE_DEF,
	type PlanComplianceProperties,
} from "../../src/analyze/analyzers/plan-compliance/index.js";
import { PHASE_TRAJECTORY_DEF } from "../../src/analyze/analyzers/phase-trajectory/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { phaseTrajectoryAnalyzer } from "../../src/analyze/analyzers/phase-trajectory/index.js";

const ANALYZER_ID = PLAN_COMPLIANCE_DEF.id;

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

/** navigate → reproduce → patch → validate: the fully compliant cycle. */
function compliantSession(): TestMessage[] {
	return [
		ask("u1", "Something in src/a.ts is broken."),
		...bashTurn("a1", "grep -rn TODO src/"),
		ask("u2", "Can you reproduce it first?"),
		...bashTurn("a2", "npm test"),
		ask("u3", "Fix it then."),
		...bashTurn("a3", "git add -A"),
		ask("u4", "Did you verify?"),
		...bashTurn("a4", "npm test"),
	];
}

/** A premature patcher that ends on its commit: phases [patch]. */
function prematureSession(): TestMessage[] {
	return [
		ask("p1", "Just commit something."),
		...bashTurn("pa1", "git add -A"),
		...bashTurn("pa2", "git commit -m 'fix'"),
	];
}

/** Register the full deterministic chain and run one plain fill. */
async function runChain(db: AsyncDatabase, sessionId: string): Promise<void> {
	const fw = mockFramework(db);
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(phaseTrajectoryAnalyzer);
	await fw.register(planComplianceAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
}

function readComplianceProps(rows: Array<Record<string, unknown>>): PlanComplianceProperties {
	const row = rows.find((n) => n["node_kind"] === "metric");
	assert.ok(row, "expected a metric node");
	return JSON.parse(row["content_json"] as string) as PlanComplianceProperties;
}

describe("plan-compliance component test", () => {
	it("scores a fully canonical session at 1.0 across all four metrics through the framework", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pc-compliant");
			await insertMessages(db, "pc-compliant", compliantSession());
			await runChain(db, "pc-compliant");

			const rows = (await readAnalyzerNodes(db, ANALYZER_ID)) as unknown as Array<Record<string, unknown>>;
			assert.equal(rows.length, 1, "exactly one compliance node per session");
			const props = readComplianceProps(rows);

			assert.equal(props.ppc, 1);
			assert.equal(props.poc, 1);
			assert.equal(props.ppf, 1);
			assert.equal(props.pc, 1);
			assert.deepEqual(props.skipped_phases, []);
			assert.deepEqual(props.present_phases, ["navigate", "reproduce", "patch", "validate"]);
			assert.equal(props.digest_line, "plan_compliance: PC=1.00 (PPC=1.00, POC=1.00, PPF=1.00)");

			// Evidence trail: anchored to the session and consuming the phase node.
			const node = rows[0]!;
			const edges = await nodeEdges(db, node["id"] as string);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			const consumes = edges.filter((e) => e["edge_kind"] === "consumes" && e["to_ref_kind"] === "analysis_node");
			assert.equal(consumes.length, 1, "exactly one consumes edge");
			const phaseNodes = await readAnalyzerNodes(db, PHASE_TRAJECTORY_DEF.id);
			assert.ok(
				consumes.some((e) => e["to_ref_id"] === phaseNodes[0]?.output_key),
				"the consumes edge points at the phase node's output key",
			);
		} finally {
			await close();
		}
	});

	it("penalizes a commit-first session: PPC=0.25 with three skipped phases", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pc-premature");
			await insertMessages(db, "pc-premature", prematureSession());
			await runChain(db, "pc-premature");

			const props = readComplianceProps(
				(await readAnalyzerNodes(db, ANALYZER_ID)) as unknown as Array<Record<string, unknown>>,
			);
			assert.deepEqual(props.present_phases, ["patch"]);
			assert.equal(props.ppc, 0.25);
			assert.equal(props.transitions, 0);
			assert.equal(props.poc, 1);
			assert.equal(props.ppf, 1);
			assert.ok(Math.abs(props.pc - Math.cbrt(0.25)) < 1e-9);
			assert.match(props.digest_line, /skipped: navigate,reproduce,validate$/);
		} finally {
			await close();
		}
	});

	it("is idempotent: a plain re-run produces nothing and every identity stays untouched", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pc-idem");
			await insertMessages(db, "pc-idem", compliantSession());
			await runChain(db, "pc-idem");

			const before = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(before.length, 1);

			// Re-run the whole chain; the second plain fill must be a no-op for this analyzer.
			await runChain(db, "pc-idem");

			const after = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(after.length, 1, "no duplicate nodes");
			assert.deepEqual(
				after.map((n) => [n.input_key, n.output_key]),
				before.map((n) => [n.input_key, n.output_key]),
				"recipe identities untouched by the re-run",
			);
		} finally {
			await close();
		}
	});

	it("a recomputed phase-trajectory node forces honest recomputation of the compliance scores", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pc-stale");
			await insertMessages(db, "pc-stale", compliantSession());
			await runChain(db, "pc-stale");

			const beforeCompliance = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(beforeCompliance.length, 1);
			const phaseBeforeKeys = new Set((await readAnalyzerNodes(db, PHASE_TRAJECTORY_DEF.id)).map((n) => n.input_key));

			// A config change on the UPSTREAM analyzer makes its unit stale under a
			// new recipe; a config-reason revise recomputes it → new output key →
			// this unit's source set no longer resolves to the old conclusion, so
			// the next PLAIN fill must produce a fresh node consuming the new key.
			const revisedFw = mockFrameworkWithOverrides(db, PHASE_TRAJECTORY_DEF.id, { stagnationMin: 5 });
			await revisedFw.register(turnPairCoreAnalyzer);
			await revisedFw.register(phaseTrajectoryAnalyzer);
			const reviseSummary = await revisedFw.run("pc-stale", { revise: ["config"] });
			assert.equal(reviseSummary.errors.length, 0);

			const phaseAfter = await readAnalyzerNodes(db, PHASE_TRAJECTORY_DEF.id);
			assert.equal(phaseAfter.length, 2, "phase node revised beside its predecessor");

			// Now a plain fill over the full chain meets the new upstream conclusion.
			await runChain(db, "pc-stale");

			const complianceAfter = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(complianceAfter.length, 2, "compliance recomputed against the new phase node");
			const newNode = complianceAfter.find((n) => n.input_key !== beforeCompliance[0]!.input_key);
			assert.ok(newNode, "the fresh compliance node carries a new recipe identity");

			const edges = await nodeEdges(db, newNode!.id);
			const consumes = edges.filter((e) => e["edge_kind"] === "consumes" && e["to_ref_kind"] === "analysis_node");
			const revisedPhase = phaseAfter.find((n) => !phaseBeforeKeys.has(n.input_key));
			assert.ok(revisedPhase, "the phase node was genuinely revised");
			assert.ok(
				consumes.some((e) => e["to_ref_id"] === revisedPhase!.output_key),
				"the fresh node consumes the recomputed phase node's output key",
			);
		} finally {
			await close();
		}
	});
});
