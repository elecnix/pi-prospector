/**
 * Component tests for the friction-accumulation analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #101). No real session data, no
 * network: hand-written synthetic rows. The analyzer chain registered here
 * (turn-pair-core, turn-frustration, tool-trajectory, friction-accumulation)
 * is fully deterministic — the mock LLM exists only to satisfy the framework's
 * construction and is never called.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	turnPairCoreAnalyzer,
} from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnFrustrationAnalyzer } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { toolTrajectoryAnalyzer } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import { frictionAccumulationAnalyzer } from "../../src/analyze/analyzers/friction-accumulation/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// ─────────────────────────── fixtures ───────────────────────────

let callSeq = 0;

function assistantText(text: string): Omit<TestMessage, "role"> {
	return { role: "assistant", text, stopReason: "stop" };
}

function failingTool(): TestMessage[] {
	const call = { role: "assistant" as const, stopReason: "toolUse", toolCalls: [{ id: `c${callSeq++}`, name: "read", arguments: { file_path: `src/mod${callSeq}.ts` } }] };
	return [
		call,
		{
			role: "toolResult",
			text: "error",
			toolResults: [{ toolCallId: call.toolCalls![0]!.id!, toolName: "read", isError: true, textLength: 5 }],
		},
	];
}

/**
 * Rising friction: four clean turns (score 0), then four turns each carrying a
 * strong correction (0.6) plus a failed tool call (0.25). No single turn is
 * extreme — the signal is the slope between the windows.
 */
function risingFrictionMessages(): TestMessage[] {
	const cleanPrompts = [
		"Please write a small utility module for date formatting.",
		"Next, add tests covering the leap year case.",
		"Now document the public functions you created.",
		"Finally wire the helpers into the main entrypoint file.",
	];
	const angryPrompts = [
		"No, that's wrong — the parser should trim whitespace first.",
		"Stop using the legacy client and regenerate it from scratch.",
		"Don't change the schema; migrate the existing rows carefully.",
		"I said revert your last edit and redo the migration properly.",
	];
	const msgs: TestMessage[] = [];
	for (const p of cleanPrompts) {
		msgs.push({ role: "user", text: p });
		msgs.push(assistantText("Done — moving on to the next part of the task."));
	}
	for (const p of angryPrompts) {
		msgs.push({ role: "user", text: p });
		msgs.push(...failingTool());
		msgs.push(assistantText("Adjusted the approach accordingly."));
	}
	return msgs;
}

/** Steady friction: every turn carries exactly one failed tool call and no correction. */
function steadyFrictionMessages(): TestMessage[] {
	const prompts = [
		"Inspect the build configuration for the web package.",
		"Check how the release script versions its artifacts.",
		"Review which environment variables the server reads.",
		"Look at the retry policy used by the queue worker.",
		"Trace where uploaded files are temporarily stored.",
		"Find how feature flags reach the mobile client.",
		"Summarise which metrics the dashboard currently tracks.",
		"Note any cron jobs defined in the deploy recipes.",
	];
	const msgs: TestMessage[] = [];
	for (const p of prompts) {
		msgs.push({ role: "user", text: p });
		msgs.push(...failingTool());
		msgs.push(assistantText("Noted that detail for later."));
	}
	return msgs;
}

/** Clean conversation: eight turns, no corrections, no tools, nothing failing. */
function cleanSessionMessages(): TestMessage[] {
	// Each prompt is deliberately longer than 80 characters so the cheap
	// repetition heuristic (short messages only) can never fire on them.
	const prompts = [
		"Walk me through how a relational database decides which physical structure an index should take, and why that choice matters later.",
		"Describe the situations where a logarithmic lookup tree outperforms a constant-time associative map for query answering workloads.",
		"Outline the conditions under which the query planner considers scanning via a prebuilt access structure rather than reading rows.",
		"Cover the role that collected column statistics play when the optimizer weighs one retrieval path against another available option.",
		"Explain why strongly correlated attributes benefit from extended statistics objects before any plan comparison can be trusted.",
		"Discuss constrained subsets of a table and how predicate-scoped structures trade storage for sharper selectivity estimates.",
		"Describe retrieval paths that answer directly from the ordering artifact itself, never touching the underlying heap pages.",
		"Finish with practical guidance on instrumenting a live system to observe whether these auxiliary structures earn their keep.",
	];
	const msgs: TestMessage[] = [];
	for (const p of prompts) {
		msgs.push({ role: "user", text: p });
		msgs.push(assistantText("Here is a concise explanation of that aspect."));
	}
	return msgs;
}

/** The deterministic dependency chain this analyzer consumes. */
function registerChain(fw: AnalyzerFramework): Promise<void> {
	return Promise.all([
		fw.register(turnPairCoreAnalyzer),
		fw.register(turnFrustrationAnalyzer),
		fw.register(toolTrajectoryAnalyzer),
		fw.register(frictionAccumulationAnalyzer),
	]).then(() => undefined);
}

interface NodeRow extends Record<string, unknown> {
	id: string;
	node_kind: string;
	input_key: string;
	output_key: string;
	content_json: string;
}

async function readAccumulationNodes(db: import("better-sqlite3").Database): Promise<NodeRow[]> {
	return (await db
		.prepare("SELECT id, node_kind, input_key, output_key, content_json FROM analysis_nodes WHERE analyzer_id = 'friction-accumulation' ORDER BY created_at ASC")
		.all()) as unknown as NodeRow[];
}

interface AccumulationContent {
	session_id: string;
	turn_count: number;
	accumulated_friction: number;
	mean_friction: number;
	window_size: number;
	window_rates: Array<{ window_index: number; start_pair_index: number; end_pair_index: number; mean_rate: number }>;
	decline_verdict: {
		first_window_rate: number;
		last_window_rate: number;
		decline_delta: number;
		decline_detected: boolean;
	};
	turn_contributions: Array<{ pair_index: number; user_message_id: string; contribution: number; core_score: number; frustration_weight: number; trajectory_weight: number }>;
	improvement_proposals: Array<{ title: string; severity: string; evidence: string; summary: string }>;
}

// ─────────────────────────── tests ───────────────────────────

describe("friction-accumulation component tests", () => {
	it("detects decline on a rising-friction session, emits a proposal node, and materialises it", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fa-rising");
			await insertMessages(db, "fa-rising", risingFrictionMessages());

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this deterministic chain" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await registerChain(fw);
			const summary = await fw.run("fa-rising", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readAccumulationNodes(db);
			assert.equal(nodes.length, 1, "one node per session");
			assert.equal(nodes[0]!.node_kind, "proposal", "a qualifying decline earns a proposal node");

			const content = JSON.parse(nodes[0]!.content_json) as AccumulationContent;
			assert.equal(content.session_id, "fa-rising");
			assert.equal(content.turn_count, 8);
			assert.ok(content.accumulated_friction > 1, "total accumulated friction clears the floor");
			assert.equal(content.window_rates.length, 2);
			assert.equal(content.decline_verdict.decline_detected, true);
			assert.equal(content.decline_verdict.first_window_rate, 0, "the clean window contributes nothing");
			assert.ok(content.decline_verdict.last_window_rate >= 0.85, "the frictional window averages correction + failure weight");
			assert.ok(content.turn_contributions.length === 8);

			// The materialised proposal carries the slope as evidence.
			const proposals = (await db
				.prepare("SELECT * FROM proposals WHERE session_id = ? AND analyzer_id = 'friction-accumulation'")
				.all("fa-rising")) as unknown as Array<Record<string, unknown>>;
			assert.equal(proposals.length, 1, "exactly one proposal materialised");
			assert.equal(proposals[0]!.status, "open");

			// Evidence trail: session anchor + anchors on the tail-window turns.
			const edges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(nodes[0]!.id)) as unknown as Array<Record<string, unknown>>;
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1, "anchored to the session");
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message").length, 4, "each turn of the last window anchors the finding");
		} finally {
			await close();
		}
	});

	it("stays quiet on a steadily-frictional session: measured, but no decline flag", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fa-steady");
			await insertMessages(db, "fa-steady", steadyFrictionMessages());

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this deterministic chain" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await registerChain(fw);
			const summary = await fw.run("fa-steady", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAccumulationNodes(db);
			assert.equal(nodes.length, 1, "a steady session is still analysed");
			assert.equal(nodes[0]!.node_kind, "metric", "steady friction never earns a decline proposal");

			const content = JSON.parse(nodes[0]!.content_json) as AccumulationContent;
			assert.equal(content.decline_verdict.decline_detected, false, "the slope, not the level, is the signal");
			assert.ok(content.accumulated_friction >= 2, "the level alone would have cleared the floor");
			assert.equal(content.improvement_proposals.length, 0);

			const proposals = (await db
				.prepare("SELECT COUNT(*) AS n FROM proposals WHERE session_id = ? AND analyzer_id = 'friction-accumulation'")
				.get("fa-steady")) as unknown as { n: number };
			assert.equal(proposals.n, 0, "nothing materialised for a steady session");
		} finally {
			await close();
		}
	});

	it("still measures a completely clean session as a metric node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fa-clean");
			await insertMessages(db, "fa-clean", cleanSessionMessages());

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this deterministic chain" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await registerChain(fw);
			const summary = await fw.run("fa-clean", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAccumulationNodes(db);
			assert.equal(nodes.length, 1, "a clean session is a first-class subject");
			assert.equal(nodes[0]!.node_kind, "metric");

			const content = JSON.parse(nodes[0]!.content_json) as AccumulationContent;
			assert.equal(content.accumulated_friction, 0);
			assert.equal(content.decline_verdict.decline_detected, false);
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fa-idem");
			await insertMessages(db, "fa-idem", risingFrictionMessages());

			const fw = new AnalyzerFramework({
				db,
				llm: createMockLLM({ responder: () => "unused by this deterministic chain" }).caller,
				modelTiers: DEFAULT_MODEL_TIERS,
			});
			await registerChain(fw);

			const first = await fw.run("fa-idem", {});
			assert.equal(first.errors.length, 0);
			const before = await readAccumulationNodes(db);
			assert.equal(before.length, 1);

			const second = await fw.run("fa-idem", {});
			assert.equal(second.errors.length, 0);
			assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing");
			const ownResult = second.analyzerResults.find((r) => r.analyzerId === "friction-accumulation");
			assert.ok(ownResult);
			assert.equal(ownResult.nodesSkipped, 1, "the accumulation unit is current");

			const after = await readAccumulationNodes(db);
			assert.deepEqual(after.map((n) => [n.input_key, n.output_key]), before.map((n) => [n.input_key, n.output_key]));
		} finally {
			await close();
		}
	});

	it("changed upstream outputs re-identify this unit's inputs and force recomputation", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fa-deps");
			await insertMessages(db, "fa-deps", risingFrictionMessages());

			const mkFw = (overrides?: Record<string, Record<string, unknown>>) =>
				new AnalyzerFramework({
					db,
					llm: createMockLLM({ responder: () => "unused by this deterministic chain" }).caller,
					modelTiers: DEFAULT_MODEL_TIERS,
					configOverrides: overrides,
				});

			// First pass: everything under shipped defaults.
			const fwA = mkFw();
			await registerChain(fwA);
			const firstRun = await fwA.run("fa-deps", {});
			assert.equal(firstRun.errors.length, 0);
			const before = await readAccumulationNodes(db);
			assert.equal(before.length, 1);

			// A heavier correction weight changes turn-pair-core's resolved config →
			// its units go stale/config; revising them produces NEW output keys.
			const fwB = mkFw({ "turn-pair-core": { correctionWeight: 0.75 } });
			await registerChain(fwB);
			const reviseRun = await fwB.run("fa-deps", { revise: ["config"] });
			assert.equal(reviseRun.errors.length, 0);
			assert.ok(reviseRun.nodesRevised >= 8, "every turn-pair-core unit was revised");

			// Because friction-accumulation references its sources by output key, the
			// upstream revision changed its source set → new input key → the unit is
			// genuinely out of date and is recomputed inside this same run, even though
			// its OWN recipe (version + config) never moved.
			const ownReviseResult = reviseRun.analyzerResults.find((r) => r.analyzerId === "friction-accumulation");
			assert.ok(ownReviseResult);
			assert.equal(ownReviseResult.nodesProduced, 1, "changed upstream outputs marked the accumulation out of date and forced recomputation");

			const after = await readAccumulationNodes(db);
			assert.equal(after.length, 2, "old version preserved beside the recomputation");
			const fresh = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(fresh, "recomputed node carries a new recipe identity");

			const oldContent = JSON.parse(before[0]!.content_json) as AccumulationContent;
			const newContent = JSON.parse(fresh!.content_json) as AccumulationContent;
			assert.ok(
				newContent.decline_verdict.last_window_rate > oldContent.decline_verdict.last_window_rate,
				"the recomputation reflects the heavier upstream correction weight",
			);

			// And the recomputed unit is now current: another plain fill does nothing.
			const settled = await fwB.run("fa-deps", {});
			const settledOwn = settled.analyzerResults.find((r) => r.analyzerId === "friction-accumulation");
			assert.ok(settledOwn && settledOwn.nodesProduced === 0);
		} finally {
			await close();
		}
	});
});
