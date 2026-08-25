import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, splitDigest } from "../../src/analyze/analyzers/session-overview/digest.js";
import type { AnalysisNodeRow, MessageRow } from "../../src/analyze/types.js";
import type { TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import type { TurnPairLLMProperties } from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";
import type { ToolTrajectoryProperties } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import type { AssistantCognitionProperties } from "../../src/analyze/analyzers/assistant-cognition/prompt.js";

function coreNode(id: string, props: Partial<TurnPairCoreProperties>): AnalysisNodeRow {
	const full: TurnPairCoreProperties = {
		pair_index: props.pair_index ?? 0,
		user_message_id: props.user_message_id ?? "u",
		correction_detected: props.correction_detected ?? false,
		correction_type: props.correction_type ?? null,
		correction_patterns: props.correction_patterns ?? [],
		correction_text: props.correction_text ?? null,
		tool_call_count: props.tool_call_count ?? 0,
		tool_failure_count: props.tool_failure_count ?? 0,
		tool_result_bytes: props.tool_result_bytes ?? 0,
		tool_waste_bytes: props.tool_waste_bytes ?? 0,
		empty_response: props.empty_response ?? false,
		friction_score: props.friction_score ?? 0,
		high_signal: props.high_signal ?? false,
	};
	return {
		id,
		session_id: "s1",
		analyzer_id: "turn-pair-core",
		analyzer_version_id: "1.0.0",
		config_id: "c",
		run_id: null,
		node_kind: "metric",
		content_json: JSON.stringify(full),
		source_set_hash: "ssh",
		config_fingerprint: "",
		input_key: id,
		output_key: id,
		model_used: null,
		cost_usd: null,
		tokens_used: null,
		duration_ms: null,
		created_at: new Date().toISOString(),
	};
}

const NO_MESSAGES: MessageRow[] = [];

function llmNode(id: string, props: TurnPairLLMProperties): AnalysisNodeRow {
	return {
		...coreNode(id, {}),
		analyzer_id: "turn-pair-llm",
		node_kind: "classification",
		content_json: JSON.stringify(props),
	};
}

function trajectoryNode(id: string, props: Partial<ToolTrajectoryProperties>): AnalysisNodeRow {
	const full: ToolTrajectoryProperties = {
		session_id: props.session_id ?? "s1",
		signals: props.signals ?? [],
		trajectory_friction_score: props.trajectory_friction_score ?? 0,
		pattern_counts: props.pattern_counts ?? {},
		tool_call_count: props.tool_call_count ?? 0,
	};
	return {
		...coreNode(id, {}),
		analyzer_id: "tool-trajectory",
		node_kind: "metric",
		content_json: JSON.stringify(full),
	};
}

function replyActsNode(id: string, props: {
	user_message_id: string;
	pair_index: number;
	acceptances?: Array<{ level: string; quote: string; rationale: string }>;
	refusals?: Array<{ level: string; quote: string; rationale: string }>;
	questions?: Array<{ purpose: string; quote: string; rationale: string }>;
	answers?: Array<{ quote: string; rationale: string }>;
	commands?: Array<{ quote: string; rationale: string }>;
	information_provisions?: Array<{ quote: string; rationale: string }>;
	continuation?: boolean;
	other?: boolean;
}): AnalysisNodeRow {
	return {
		...coreNode(id, {}),
		analyzer_id: "user-reply-acts",
		node_kind: "classification",
		content_json: JSON.stringify({
			user_message_id: props.user_message_id,
			prior_user_message_id: null,
			prior_core_output_key: null,
			pair_index: props.pair_index,
			acceptances: props.acceptances ?? [],
			refusals: props.refusals ?? [],
			questions: props.questions ?? [],
			answers: props.answers ?? [],
			commands: props.commands ?? [],
			information_provisions: props.information_provisions ?? [],
			continuation: props.continuation ?? false,
			other: props.other ?? false,
			abstention: null,
			attempt: 1,
		}),
	};
}

describe("buildDigest", () => {
	it("aggregates counts and renders per-pair lines", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.7, high_signal: true, correction_detected: true, correction_type: "explicit" }),
				coreNode("n2", { pair_index: 1, friction_score: 0.1, tool_failure_count: 0 }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.pairCount, 2);
		assert.equal(digest.frictionCount, 1);
		assert.equal(digest.correctionCount, 1);
		assert.equal(digest.perPairLines.length, 2);
		assert.ok(digest.text.includes("#0"));
	});

	it("orders pairs by index regardless of node order", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [coreNode("n2", { pair_index: 5 }), coreNode("n1", { pair_index: 1 })],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.ok(digest.perPairLines[0]!.startsWith("#1"));
		assert.ok(digest.perPairLines[1]!.startsWith("#5"));
	});

	it("includes compaction summaries verbatim", () => {
		const messages: MessageRow[] = [
			{
				id: "c1",
				session_id: "s1",
				parent_id: null,
				timestamp: null,
				role: "compactionSummary",
				content_text: "PRIOR CONTEXT: refactored auth",
				content_thinking: null,
				tool_calls: null,
				tool_results: null,
			},
		];
		const digest = buildDigest({ sessionId: "s1", messages, coreNodes: [coreNode("n1", {})], llmNodes: [], trajectoryNodes: [] });
		assert.equal(digest.compactionCount, 1);
		assert.ok(digest.text.includes("refactored auth"));
	});

	it("merges turn-pair-llm enrichment onto the matching pair by user_message_id", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-hot", friction_score: 0.8, high_signal: true }),
				coreNode("n2", { pair_index: 1, user_message_id: "u-cold", friction_score: 0.1 }),
			],
			llmNodes: [
				llmNode("l1", {
					user_message_id: "u-hot",
					sentiment: "frustrated",
					friction_type: "wrong_approach",
					is_genuine_correction: true,
					severity: "high",
					rationale: "x",
				}),
			],
			trajectoryNodes: [],
		});
		const hotLine = digest.perPairLines.find((l) => l.startsWith("#0"))!;
		const coldLine = digest.perPairLines.find((l) => l.startsWith("#1"))!;
		assert.ok(hotLine.includes("sentiment=frustrated"), "enriched pair shows LLM sentiment");
		assert.ok(hotLine.includes("type=wrong_approach") && hotLine.includes("sev=high"));
		assert.ok(!coldLine.includes("sentiment="), "un-enriched pair has no LLM fields");
	});

	it("carries a tool-evidence fragment (name + args + error head) for failing/high-signal pairs", () => {
		const messages: MessageRow[] = [
			{ id: "u-hot", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "YOU SHOULD HAVE PUSHED TO v2nic/gh-pr-review", content_thinking: null, tool_calls: null, tool_results: null },
			{ id: "a1", session_id: "s1", parent_id: "u-hot", timestamp: null, role: "assistant", content_text: "creating PR", content_thinking: null, tool_calls: JSON.stringify([{ name: "bash", arguments: { command: "gh pr create --draft --title fix" } }]), tool_results: null },
			{ id: "t1", session_id: "s1", parent_id: "a1", timestamp: null, role: "toolResult", content_text: "fatal: 'agynio/gh-pr-review' not found: 403", content_thinking: null, tool_calls: null, tool_results: JSON.stringify([{ toolName: "bash", isError: true, textLength: 42 }]) },
		];
		const digest = buildDigest({
			sessionId: "s1",
			messages,
			coreNodes: [coreNode("n1", { pair_index: 0, user_message_id: "u-hot", friction_score: 0.8, high_signal: true, tool_failure_count: 1 })],
			llmNodes: [],
			trajectoryNodes: [],
		});
		const line = digest.perPairLines[0]!;
		assert.ok(line.includes("tool=bash"), "per-pair line names the tool");
		assert.ok(line.includes("gh pr create"), "per-pair line carries the command args");
		assert.ok(!/args="[^"]*--repo/.test(line), "the gh pr create args carry no --repo flag (the actual bug)");
		assert.ok(line.includes('err="fatal'), "per-pair line carries the failed-result error head");
	});

	it("omits the tool-evidence fragment for clean, low-signal pairs", () => {
		const messages: MessageRow[] = [
			{ id: "u-cold", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "add a test", content_thinking: null, tool_calls: null, tool_results: null },
			{ id: "a1", session_id: "s1", parent_id: "u-cold", timestamp: null, role: "assistant", content_text: "done", content_thinking: null, tool_calls: JSON.stringify([{ name: "bash", arguments: { command: "npm test" } }]), tool_results: null },
		];
		const digest = buildDigest({
			sessionId: "s1",
			messages,
			coreNodes: [coreNode("n1", { pair_index: 0, user_message_id: "u-cold", friction_score: 0.05, high_signal: false, tool_failure_count: 0 })],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.ok(!digest.perPairLines[0]!.includes("tool="), "clean pair has no tool-evidence fragment");
	});

	it("bounds the tool-evidence fragment to the per-turn call cap", () => {
		const calls = Array.from({ length: 20 }, (_, i) => ({ name: "bash", arguments: { command: `echo ${i}` } }));
		const messages: MessageRow[] = [
			{ id: "u-many", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "do many things", content_thinking: null, tool_calls: null, tool_results: null },
			{ id: "a1", session_id: "s1", parent_id: "u-many", timestamp: null, role: "assistant", content_text: "ok", content_thinking: null, tool_calls: JSON.stringify(calls), tool_results: null },
		];
		const digest = buildDigest({
			sessionId: "s1",
			messages,
			coreNodes: [coreNode("n1", { pair_index: 0, user_message_id: "u-many", friction_score: 0.8, high_signal: true })],
			llmNodes: [],
			trajectoryNodes: [],
		});
		const toolCount = (digest.perPairLines[0]!.match(/tool=/g) ?? []).length;
		assert.ok(toolCount <= 8, `rendered ${toolCount} tool= tokens, expected ≤ 8`);
	});

	it("includes branch summaries verbatim (Pi's snake_case branch_summary role)", () => {
		const messages: MessageRow[] = [
			{
				id: "b1",
				session_id: "s1",
				parent_id: null,
				timestamp: null,
				role: "branch_summary",
				content_text: "BRANCH CONTEXT: split off to try OAuth",
				content_thinking: null,
				tool_calls: null,
				tool_results: null,
			},
		];
		const digest = buildDigest({ sessionId: "s1", messages, coreNodes: [coreNode("n1", {})], llmNodes: [], trajectoryNodes: [] });
		assert.equal(digest.compactionCount, 1);
		assert.ok(digest.text.includes("split off to try OAuth"));
	});

	it("tolerates malformed node content", () => {
		const bad: AnalysisNodeRow = { ...coreNode("n1", {}), content_json: "{bad" };
		const digest = buildDigest({ sessionId: "s1", messages: NO_MESSAGES, coreNodes: [bad], llmNodes: [], trajectoryNodes: [] });
		assert.equal(digest.pairCount, 0);
	});

	it("includes user text for every pair, not just correction-matched ones (un-gate)", () => {
		// A pair whose user text is an unrecognized correction (no regex match).
		// Before the un-gating change, this pair would have no `note=` or `text=` field.
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-circleci", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "This repo does not use CircleCI", content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-circleci", correction_detected: false, friction_score: 0.3 }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		const line = digest.perPairLines[0]!;
		// The key assertion: even without correction_detected, the user text appears.
		assert.ok(line.includes("text="), "un-gated pair must have a text= snippet");
		assert.ok(line.includes("CircleCI"), "text= must contain the user's actual words");
	});

	it("includes user text snippet even for pairs with no correction at all", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-plain", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "please add a test for this", content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-plain", friction_score: 0.05 }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		const line = digest.perPairLines[0]!;
		assert.ok(line.includes("text="), "plain pair must have a text= snippet");
		assert.ok(line.includes("add a test"), "text= must contain the user text");
	});

	it("truncates long user text to the budget", () => {
		const longText = "a".repeat(500);
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-long", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: longText, content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-long", friction_score: 0.1 }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		const line = digest.perPairLines[0]!;
		// The text field should be truncated to USER_TEXT_SNIPPET_MAX (200) + ellipsis.
		assert.ok(line.includes("text=\""), "must have text field");
		// Extract the text field value and check it's truncated.
		const match = line.match(/text="([^"]*)"/);
		assert.ok(match, "text field must be extractable");
		assert.ok(match[1]!.length <= 201, "truncated text must be within budget");
	});

	it("includes trajectory signals alongside per-pair and user-text signals", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-plain", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "please check CI", content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [coreNode("n1", { pair_index: 0, user_message_id: "u-plain", friction_score: 0.05 })],
			llmNodes: [],
			trajectoryNodes: [
				trajectoryNode("t1", {
					trajectory_friction_score: 0.6,
					pattern_counts: { "polling-loop": 1 },
					tool_call_count: 3,
					signals: [
						{
							pattern: "polling-loop",
							tool: "bash",
							normalizedArgs: "gh pr view",
							count: 3,
							messageIds: ["a1", "a2", "a3"],
							description: "gh pr view called 3× polling for state",
						},
					],
				}),
			],
		});
		assert.equal(digest.trajectorySignalCount, 1);
		assert.equal(digest.trajectoryLines.length, 1);
		assert.ok(digest.header.includes("trajectory_signals=1"));
		assert.ok(digest.header.includes("trajectory_friction=0.60"));
		assert.ok(digest.text.includes("### Trajectory signals"));
		assert.ok(digest.text.includes("trajectory:polling-loop tool=bash count=3"));
		assert.ok(digest.perPairLines[0]!.includes("text=\"please check CI\""));
	});

	it("detects task-completed-without-correction when no corrections exist", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.1, correction_detected: false }),
				coreNode("n2", { pair_index: 1, friction_score: 0.05, correction_detected: false }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.taskCompletedWithoutCorrection, true, "no corrections → task-completed-without-correction");
		assert.ok(digest.positiveSignals.includes("task-completed-without-correction"));
		assert.ok(digest.text.includes("positive_signals"));
	});

	it("detects correction-then-clean-recovery when a correction is followed by a clean pair", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, correction_detected: true, correction_type: "explicit", friction_score: 0.6, high_signal: true }),
				coreNode("n2", { pair_index: 1, correction_detected: false, friction_score: 0.05, high_signal: false }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.cleanRecovery, true, "correction followed by clean pair → clean recovery");
		assert.ok(digest.positiveSignals.includes("correction-then-clean-recovery"));
	});

	it("does not flag clean recovery when correction is followed by another correction", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, correction_detected: true, correction_type: "explicit", friction_score: 0.7, high_signal: true }),
				coreNode("n2", { pair_index: 1, correction_detected: true, correction_type: "explicit", friction_score: 0.6, high_signal: true }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.cleanRecovery, false, "back-to-back corrections → no clean recovery");
	});

	it("detects low-tool-failure-density when fewer than half the pairs have tool failures", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, tool_failure_count: 0 }),
				coreNode("n2", { pair_index: 1, tool_failure_count: 0 }),
				coreNode("n3", { pair_index: 2, tool_failure_count: 1 }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.lowToolFailureDensity, true, "1 of 3 pairs with tool failure → low density");
		assert.ok(digest.positiveSignals.includes("low-tool-failure-density"));
	});

	it("does not flag low-tool-failure-density when half or more pairs have tool failures", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, tool_failure_count: 1 }),
				coreNode("n2", { pair_index: 1, tool_failure_count: 2 }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.lowToolFailureDensity, false, "all pairs with failures → not low density");
	});

	it("a fully clean session has task-completed and low-failure positive signals and no friction", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.05, correction_detected: false, tool_failure_count: 0, high_signal: false }),
				coreNode("n2", { pair_index: 1, friction_score: 0.02, correction_detected: false, tool_failure_count: 0, high_signal: false }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.equal(digest.frictionCount, 0);
		assert.equal(digest.correctionCount, 0);
		assert.equal(digest.taskCompletedWithoutCorrection, true);
		assert.equal(digest.lowToolFailureDensity, true);
		assert.equal(digest.positiveSignals.length, 2, "clean session has task-completed-without-correction and low-tool-failure-density");
		assert.ok(!digest.positiveSignals.includes("correction-then-clean-recovery"), "no corrections → no clean-recovery signal");
	});

	it("includes positive signals section in digest text only when signals exist", () => {
		const digestWithSignals = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.1, correction_detected: false, tool_failure_count: 0, high_signal: false }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.ok(digestWithSignals.text.includes("### Positive signals"));
		assert.ok(digestWithSignals.text.includes("- task-completed-without-correction"));

		const digestNoSignals = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.8, correction_detected: true, tool_failure_count: 3, high_signal: true }),
			],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.ok(!digestNoSignals.text.includes("### Positive signals"), "no positive signals → no section");
	});
});

describe("buildDigest — reply acts", () => {
	it("includes a Reply acts section when reply-acts nodes are present", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u0", friction_score: 0.1 }),
				coreNode("n2", { pair_index: 1, user_message_id: "u1", friction_score: 0.8, high_signal: true, correction_detected: true, correction_type: "negation" }),
			],
			llmNodes: [],
			trajectoryNodes: [],
			replyActsNodes: [
				replyActsNode("ra1", { user_message_id: "u1", pair_index: 1, acceptances: [{ level: "partial", quote: "ok but", rationale: "partial accept" }], refusals: [{ level: "partial", quote: "not that", rationale: "pushback" }], questions: [{ purpose: "clarify", quote: "what?", rationale: "needs more detail" }] }),
			],
		});
		assert.ok(digest.text.includes("### Reply acts"), "digest should include Reply acts section");
		assert.equal(digest.replyActsCount, 1);
		assert.equal(digest.replyActsLines.length, 1);
		const line = digest.replyActsLines[0]!;
		assert.ok(line.includes("#1"), "line should reference pair index 1");
		assert.ok(line.includes("accept=partial"), "line should show acceptance level");
		assert.ok(line.includes("refuse=partial"), "line should show refusal level");
		assert.ok(line.includes("question=clarify"), "line should show question purpose");
	});

	it("omits Reply acts section when no reply-acts nodes exist", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [coreNode("n1", {})],
			llmNodes: [],
			trajectoryNodes: [],
		});
		assert.ok(!digest.text.includes("### Reply acts"), "no reply-acts nodes → no section");
		assert.equal(digest.replyActsCount, 0);
		assert.equal(digest.replyActsLines.length, 0);
	});

	it("renders commands and information provisions", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [coreNode("n1", { pair_index: 0, user_message_id: "u0" })],
			llmNodes: [],
			trajectoryNodes: [],
			replyActsNodes: [
				replyActsNode("ra1", { user_message_id: "u0", pair_index: 0, commands: [{ quote: "do it", rationale: "command" }], information_provisions: [{ quote: "context", rationale: "info" }] }),
			],
		});
		const line = digest.replyActsLines[0]!;
		assert.ok(line.includes("command=1"), "line should show command count");
		assert.ok(line.includes("info_prov=1"), "line should show info provision count");
	});

	it("renders continuation and other flags", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [coreNode("n1", { pair_index: 0, user_message_id: "u0" })],
			llmNodes: [],
			trajectoryNodes: [],
			replyActsNodes: [
				replyActsNode("ra1", { user_message_id: "u0", pair_index: 0, continuation: true, other: false }),
			],
		});
		const line = digest.replyActsLines[0]!;
		assert.ok(line.includes("continuation"), "line should show continuation flag");
		assert.ok(!line.includes("other"), "line should not show other when false");
	});
});

describe("buildDigest — assistant cognition", () => {
	function cognitionNode(id: string, props: Partial<AssistantCognitionProperties> & { user_message_id: string }): AnalysisNodeRow {
		const full: AssistantCognitionProperties = {
			user_message_id: props.user_message_id,
			confusion: props.confusion ?? [],
			indecision: props.indecision ?? [],
			surprise: props.surprise ?? [],
		};
		return {
			...coreNode(id, {}),
			analyzer_id: "assistant-cognition",
			node_kind: "classification",
			content_json: JSON.stringify(full),
		};
	}

	function buildWith(cognitionNodes: AnalysisNodeRow[], coreOverrides?: Partial<TurnPairCoreProperties>[]) {
		return buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n0", { pair_index: 0, user_message_id: "u0", friction_score: 0.1 }),
				coreNode("n1", { pair_index: 1, user_message_id: "u1", friction_score: 0.8, high_signal: true, correction_detected: true, correction_type: "explicit" }),
			],
			llmNodes: [],
			trajectoryNodes: [],
			cognitionNodes,
		});
	}

	it("includes an Assistant cognition line only for turns with non-empty signal arrays", () => {
		const digest = buildWith([
			cognitionNode("c0", {
				user_message_id: "u0",
				confusion: [{ level: "moderate", rationale: "re-reading" }],
				indecision: [],
				surprise: [{ quote: "that's odd", severity: "mild", rationale: "verbatim" }],
			}),
			// Abstention: stored analysis, but nothing to show.
			cognitionNode("c1", { user_message_id: "u1" }),
		]);

		assert.ok(digest.text.includes("### Assistant cognition"), "section present when signals exist");
		assert.equal(digest.cognitionTurnCount, 1, "only the signalling turn counts");
		assert.equal(digest.cognitionLines.length, 1);
		const line = digest.cognitionLines[0]!;
		assert.ok(line.startsWith("#0"), "line references its pair index");
		assert.ok(line.includes("confusion=moderate"));
		assert.ok(!line.includes("indecision="), "empty indecision array renders nothing");
		assert.ok(line.includes("surprise[mild]=\"that's odd\""), "surprise carries severity and verbatim quote");
		assert.ok(!line.includes("#1 "), "abstaining turn gets no line");
	});

	it("omits the section entirely when no cognition nodes exist", () => {
		const digest = buildWith([]);
		assert.ok(!digest.text.includes("### Assistant cognition"), "no nodes → no section");
		assert.equal(digest.cognitionTurnCount, 0);
		assert.equal(digest.cognitionLines.length, 0);
	});

	it("truncates long surprise quotes to the digest budget", () => {
		const digest = buildWith([
			cognitionNode("c0", {
				user_message_id: "u0",
				surprise: [{ quote: "x".repeat(400), severity: "high", rationale: "long verbatim quote" }],
			}),
		]);
		const match = digest.cognitionLines[0]!.match(/surprise\[high\]="([^"]*)"/);
		assert.ok(match, "surprise field is extractable");
		assert.ok(match[1]!.length <= 121, `truncated quote within budget (got ${match[1]!.length})`);
	});

	it("caps cognition lines per session, earliest pairs first", () => {
		const core = Array.from({ length: 10 }, (_, i) =>
			coreNode(`cn${i}`, { pair_index: i, user_message_id: `cu${i}`, friction_score: 0.2 }));
		const cog = Array.from({ length: 10 }, (_, i) =>
			cognitionNode(`cc${i}`, { user_message_id: `cu${i}`, confusion: [{ level: "mild", rationale: "r" }] }));
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: core,
			llmNodes: [],
			trajectoryNodes: [],
			cognitionNodes: cog,
			maxCognitionEntries: 3,
		});
		assert.equal(digest.cognitionTurnCount, 10, "all signalling turns counted before capping");
		assert.equal(digest.cognitionLines.length, 3, "lines capped at the configured ceiling");
		assert.deepEqual(
			digest.cognitionLines.map((l) => l.split(" ")[0]),
			["#0", "#1", "#2"],
			"earliest pair indexes win deterministically",
		);
	});

	it("keeps the Assistant cognition section when splitting a long digest", () => {
		const core = Array.from({ length: 20 }, (_, i) =>
			coreNode(`sn${i}`, { pair_index: i, user_message_id: `su${i}`, correction_text: "x".repeat(80), friction_score: 0.4 }));
		const cog = Array.from({ length: 20 }, (_, i) =>
			cognitionNode(`sc${i}`, { user_message_id: `su${i}`, indecision: [{ level: "high", rationale: "flip-flop" }] }));
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: core,
			llmNodes: [],
			trajectoryNodes: [],
			cognitionNodes: cog,
		});
		const joined = splitDigest(digest, 500).map((s) => s.text).join("\n");
		assert.ok(joined.includes("### Assistant cognition"), "section survives map-reduce splitting");
	});
});

describe("splitDigest", () => {
	it("returns a single segment when under budget", () => {
		const digest = buildDigest({ sessionId: "s1", messages: NO_MESSAGES, coreNodes: [coreNode("n1", {})], llmNodes: [], trajectoryNodes: [] });
		assert.equal(splitDigest(digest, 100000).length, 1);
	});

	it("splits into multiple segments when over budget", () => {
		const nodes = Array.from({ length: 40 }, (_, i) => coreNode(`n${i}`, { pair_index: i, correction_detected: true, high_signal: true, tool_failure_count: 1, correction_text: "x".repeat(100) }));
		const digest = buildDigest({ sessionId: "s1", messages: NO_MESSAGES, coreNodes: nodes, llmNodes: [], trajectoryNodes: [] });
		const segments = splitDigest(digest, 500);
		assert.ok(segments.length > 1);
		for (const seg of segments) assert.ok(seg.text.includes("Per-pair signals"));
	});

	it("keeps positive and trajectory sections when splitting", () => {
		const nodes = Array.from({ length: 20 }, (_, i) => coreNode(`n${i}`, { pair_index: i, correction_text: "x".repeat(80) }));
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: nodes,
			llmNodes: [],
			trajectoryNodes: [
				trajectoryNode("t1", {
					trajectory_friction_score: 0.5,
					pattern_counts: { "stuck-loop": 1 },
					tool_call_count: 3,
					signals: [
						{
							pattern: "stuck-loop",
							tool: "bash",
							normalizedArgs: "npm test",
							count: 3,
							messageIds: ["a1", "a2", "a3"],
							description: "npm test called 3× without success",
						},
					],
				}),
			],
		});
		const joined = splitDigest(digest, 500).map((s) => s.text).join("\n");
		assert.ok(joined.includes("### Positive signals"));
		assert.ok(joined.includes("### Trajectory signals"));
	});

	it("keeps reply acts section when splitting", () => {
		const nodes = Array.from({ length: 20 }, (_, i) => coreNode(`n${i}`, { pair_index: i, user_message_id: `u${i}`, correction_text: "x".repeat(80) }));
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: nodes,
			llmNodes: [],
			trajectoryNodes: [],
			replyActsNodes: [
				replyActsNode("ra1", { user_message_id: "u0", pair_index: 0, acceptances: [{ level: "full", quote: "ok", rationale: "accept" }] }),
			],
		});
		const joined = splitDigest(digest, 500).map((s) => s.text).join("\n");
		assert.ok(joined.includes("### Reply acts"), "reply acts section should survive splitting");
	});
});
