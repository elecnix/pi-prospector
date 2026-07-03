/**
 * Component tests for the tool-trajectory analyzer, exercised end-to-end through
 * the real AnalyzerFramework (with a deterministic mock LLM). No real session
 * data, no network.
 *
 * These tests prove that trajectory signals actually fire through the framework:
 * the synthetic tool calls carry real `arguments.command` strings (the exact
 * shape produced by src/sync/parser.ts and consumed by both turn-pair-core and
 * tool-trajectory), so the analyzer's arg-parser and detectors run for real.
 *
 * The mock LLM only emits a proposal when the session-overview digest actually
 * contains trajectory-signal lines. This makes the contrast meaningful: a
 * baseline that never sees the trajectory analyzer produces zero proposals, so
 * any proposal in the trajectory-enabled run is causally attributable to a real
 * trajectory signal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { toolTrajectoryAnalyzer, TOOL_TRAJECTORY_DEF, type ToolTrajectoryProperties } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import { sessionOverviewAnalyzer } from "../../src/analyze/analyzers/session-overview/index.js";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { LLMRequest } from "../../src/analyze/types.js";

// ─────────────────────────── fixtures ───────────────────────────

/** A single bash tool call carrying its real command string. */
function bashCall(command: string): TestMessage["toolCalls"] {
	return [{ name: "bash", arguments: { command } }];
}

/**
 * A polite, error-free "thrash" session: the user never corrects, no tool result
 * is an error, but the agent (a) polls `gh pr view 29` five times (polling loop)
 * and (b) switches branches main → feature → main (checkout oscillation). Both
 * patterns are invisible to turn-pair-core (no correction, no error) yet must be
 * caught by the trajectory analyzer.
 */
function thrashSessionMessages(): TestMessage[] {
	const poll = (text: string): TestMessage[] => [
		{ role: "assistant", text, toolCalls: bashCall("gh pr view 29") },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 200 }] },
	];
	const checkout = (text: string, branch: string): TestMessage[] => [
		{ role: "assistant", text, toolCalls: bashCall(`git checkout ${branch}`) },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 40 }] },
	];
	return [
		{ role: "user", text: "Can you check if PR 29 is merged?" },
		...poll("Let me check."),
		...poll("Not yet, checking again."),
		...poll("Still not merged."),
		...poll("Checking once more."),
		...poll("Still waiting."),
		{ role: "user", text: "Thanks for checking." },
		...checkout("Let me look at the feature branch.", "main"),
		...checkout("Actually switching to feature.", "feature"),
		...checkout("Going back to main.", "main"),
		{ role: "user", text: "OK, looks good." },
		{ role: "assistant", text: "Great!" },
	];
}

/**
 * Mock LLM. Turn classification and segment summaries are neutral. The
 * session-overview reduce emits a proposal ONLY when the digest carries
 * trajectory-signal lines — so a digest without them (the baseline) yields no
 * proposals.
 */
function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({
			sentiment: "neutral",
			friction_type: "none",
			is_genuine_correction: false,
			severity: "low",
			rationale: "ok",
		});
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "Agent polled PR status and switched branches.", notable_points: [] });
	}
	// session-overview reduce.
	const hasTrajectory = req.user.includes("trajectory:");
	if (!hasTrajectory) {
		return JSON.stringify({
			session_summary: "Smooth session with no notable friction.",
			friction_points: [],
			key_positive_signals: [],
			improvement_proposals: [],
		});
	}
	return JSON.stringify({
		session_summary: "The agent polled PR status repeatedly and switched branches back and forth without changing approach.",
		friction_points: [
			{
				description: "Agent repeatedly polled PR status without adapting strategy",
				what_to_change: "add polling backoff or a strategy change before repeated status checks",
				evidence: "gh pr view 29 called 5× consecutively",
				severity: "high",
			},
		],
		key_positive_signals: [],
		improvement_proposals: [
			{
				target_type: "agents_md",
				target_path: "AGENTS.md § Tooling",
				title: "Add guidance on polling loops",
				summary: "Instruct the agent to add backoff when polling for external state changes.",
				detail: "The agent polled gh pr view 5 times with no change. A standing instruction to poll less frequently would reduce waste.",
				evidence: "gh pr view 29 called 5× consecutively",
				confidence: 0.8,
				severity: "friction",
			},
		],
	});
}

function newFramework(db: import("better-sqlite3").Database) {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: respond }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
}

/** Read and parse the single trajectory metric node for a session. */
function readTrajectoryNode(db: import("better-sqlite3").Database): ToolTrajectoryProperties {
	const rows = db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = ?")
		.all(TOOL_TRAJECTORY_DEF.id) as Array<{ content_json: string }>;
	assert.ok(rows.length >= 1, "trajectory analyzer should produce at least one node");
	const parsed = JSON.parse(rows[0]!.content_json) as ToolTrajectoryProperties;
	return parsed;
}

// ─────────────────────────── tests ───────────────────────────

describe("tool-trajectory component test", () => {
	it("polite error-free thrash session yields >=1 trajectory signal and >=1 proposal where the baseline produced none", async () => {
		// ── Baseline: same session WITHOUT the trajectory analyzer registered. ──
		const baseline = tempDb();
		let baselineProposalCount: number;
		try {
			insertSession(baseline.db, "thrash-baseline");
			insertMessages(baseline.db, "thrash-baseline", thrashSessionMessages());

			const baselineFw = newFramework(baseline.db);
			baselineFw.register(turnPairCoreAnalyzer);
			baselineFw.register(turnPairLLMAnalyzer);
			baselineFw.register(sessionOverviewAnalyzer);
			const baselineSummary = await baselineFw.run("thrash-baseline", {});
			assert.equal(baselineSummary.errors.length, 0, "baseline run should have no errors");

			baselineProposalCount = (baseline.db
				.prepare("SELECT COUNT(*) as count FROM proposals WHERE session_id = ?")
				.get("thrash-baseline") as { count: number }).count;
		} finally {
			baseline.close();
		}

		// The baseline never sees a trajectory signal, so it produces no proposal.
		assert.equal(baselineProposalCount, 0, "baseline (no trajectory analyzer) should produce zero proposals");

		// ── Trajectory-enabled run of the same session. ──
		const full = tempDb();
		try {
			insertSession(full.db, "thrash-traj");
			insertMessages(full.db, "thrash-traj", thrashSessionMessages());

			const trajFw = newFramework(full.db);
			trajFw.register(turnPairCoreAnalyzer);
			trajFw.register(turnPairLLMAnalyzer);
			trajFw.register(toolTrajectoryAnalyzer);
			trajFw.register(sessionOverviewAnalyzer);
			const trajSummary = await trajFw.run("thrash-traj", {});
			assert.equal(trajSummary.errors.length, 0, "trajectory run should have no errors");

			// (1) The trajectory analyzer detected real signals through the framework.
			const props = readTrajectoryNode(full.db);
			assert.equal(props.tool_call_count, 8, "should have parsed all 8 bash tool calls");
			assert.ok(props.signals.length >= 1, `expected >=1 trajectory signal, got ${props.signals.length}`);

			const patterns = new Set(props.signals.map((s) => s.pattern));
			assert.ok(patterns.has("polling-loop"), "should detect the gh pr view polling loop");
			assert.ok(patterns.has("oscillation"), "should detect the checkout oscillation");

			const polling = props.signals.find((s) => s.pattern === "polling-loop")!;
			assert.equal(polling.count, 5, "polling loop should span all 5 gh pr view calls");

			// (2) The signal reaches the digest and drives at least one proposal.
			const trajProposalCount = (full.db
				.prepare("SELECT COUNT(*) as count FROM proposals WHERE session_id = ?")
				.get("thrash-traj") as { count: number }).count;
			assert.ok(trajProposalCount >= 1, "trajectory signals should drive at least one proposal");
			assert.ok(
				trajProposalCount > baselineProposalCount,
				`trajectory run (${trajProposalCount}) should produce more proposals than baseline (${baselineProposalCount})`,
			);
		} finally {
			full.close();
		}
	});

	it("trajectory analyzer emits a well-formed metric node anchored to the session", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "traj-struct");
			insertMessages(db, "traj-struct", [
				{ role: "user", text: "check the PR" },
				{ role: "assistant", text: "checking", toolCalls: bashCall("gh pr view 7") },
				{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 100 }] },
				{ role: "user", text: "again" },
				{ role: "assistant", text: "checking again", toolCalls: bashCall("gh pr view 7") },
				{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 100 }] },
			]);

			const fw = newFramework(db);
			fw.register(turnPairCoreAnalyzer);
			fw.register(toolTrajectoryAnalyzer);

			const summary = await fw.run("traj-struct", {});
			assert.equal(summary.errors.length, 0, "no errors in run");

			const trajNodes = db
				.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ?")
				.all(TOOL_TRAJECTORY_DEF.id) as Array<Record<string, unknown>>;
			assert.ok(trajNodes.length >= 1, "trajectory analyzer should produce a node");

			const node = trajNodes[0]!;
			assert.equal(node["node_kind"], "metric", "trajectory node should be a metric");

			const content = JSON.parse(node["content_json"] as string) as ToolTrajectoryProperties;
			assert.equal(typeof content.session_id, "string", "content should have session_id");
			assert.ok(Array.isArray(content.signals), "content should have signals array");
			assert.equal(content.tool_call_count, 2, "should parse both bash calls");
			assert.equal(typeof content.trajectory_friction_score, "number", "content should have trajectory_friction_score");
			assert.ok(content.trajectory_friction_score >= 0 && content.trajectory_friction_score <= 1, "friction score should be in [0,1]");
			assert.equal(typeof content.pattern_counts, "object", "content should have pattern_counts");

			const edges = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(node["id"]) as Array<Record<string, unknown>>;
			const anchorEdge = edges.find((e) => e["edge_kind"] === "anchors");
			assert.ok(anchorEdge, "trajectory node should have an anchors edge");
		} finally {
			close();
		}
	});
});

/**
 * Dogfood-style regressions. These encode the two concrete misses from issue #8
 * (the `gh pr view ×5` polling loop and the `--force` restore oscillation) as
 * synthetic sessions and assert the detectors fire THROUGH the framework — not
 * just via the pure detector unit tests.
 */
describe("tool-trajectory dogfood regressions (through the framework)", () => {
	it("detects a gh-pr-view polling loop (session 019e6294 pattern)", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "poll-loop");
			const poll = (text: string): TestMessage[] => [
				{ role: "assistant", text, toolCalls: bashCall("gh pr view 29 --json state") },
				{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 120 }] },
			];
			insertMessages(db, "poll-loop", [
				{ role: "user", text: "wait for PR 29 to become mergeable" },
				...poll("checking"),
				...poll("still pending"),
				...poll("still pending"),
				...poll("still pending"),
				...poll("still pending"),
				{ role: "user", text: "ok" },
			]);

			const fw = newFramework(db);
			fw.register(turnPairCoreAnalyzer);
			fw.register(toolTrajectoryAnalyzer);
			const summary = await fw.run("poll-loop", {});
			assert.equal(summary.errors.length, 0, "no errors in run");

			const props = readTrajectoryNode(db);
			const polling = props.signals.filter((s) => s.pattern === "polling-loop");
			assert.ok(polling.length >= 1, `expected a polling-loop signal, got ${JSON.stringify(props.signals.map((s) => s.pattern))}`);
			assert.equal(polling[0]!.count, 5, "polling loop should span all 5 read-only calls");
			assert.equal(polling[0]!.tool, "bash");
		} finally {
			close();
		}
	});

	it("detects a push → force-restore → repush oscillation (session cd4f39ed pattern)", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "oscillation");
			const push = (text: string, command: string): TestMessage[] => [
				{ role: "assistant", text, toolCalls: bashCall(command) },
				{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 60 }] },
			];
			insertMessages(db, "oscillation", [
				{ role: "user", text: "clean up the branch" },
				...push("pushing the new work", "git push origin feature"),
				...push("actually restoring the old commit", "git push --force origin feature"),
				...push("re-pushing the intended work", "git push origin feature"),
				{ role: "user", text: "done" },
			]);

			const fw = newFramework(db);
			fw.register(turnPairCoreAnalyzer);
			fw.register(toolTrajectoryAnalyzer);
			const summary = await fw.run("oscillation", {});
			assert.equal(summary.errors.length, 0, "no errors in run");

			const props = readTrajectoryNode(db);
			const oscillations = props.signals.filter((s) => s.pattern === "oscillation");
			assert.ok(
				oscillations.length >= 1,
				`expected an oscillation signal, got ${JSON.stringify(props.signals.map((s) => s.pattern))}`,
			);
			assert.equal(oscillations[0]!.tool, "bash");
		} finally {
			close();
		}
	});
});
