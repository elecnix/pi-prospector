/**
 * Unit tests for event-centered evidence slicing (issue #118, after LivePlan
 * §II-B) and for the session-overview digest's trajectory evidence blocks.
 *
 * Pure functions and buildDigest over synthetic nodes/messages only — no
 * database, no LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	EVIDENCE_SLICE_CEILING,
	buildMessageIdToPairIndex,
	collectTriggerPairIndexes,
	sliceStartIndex,
} from "../../src/analyze/evidence-slices.js";
import { buildDigest } from "../../src/analyze/analyzers/session-overview/digest.js";
import { buildClassifyPrompt, type SliceTurn } from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";
import type { TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import type { ToolTrajectoryProperties, TrajectorySignal } from "../../src/analyze/analyzers/tool-trajectory/index.js";
import type { PhaseTrajectoryProperties } from "../../src/analyze/analyzers/phase-trajectory/index.js";
import { buildTurnPairs } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import type { AnalysisNodeRow, MessageRow } from "../../src/analyze/types.js";

// ─────────────────────────── sliceStartIndex ───────────────────────────

describe("sliceStartIndex", () => {
	it("starts at the previous trigger when one exists", () => {
		assert.equal(sliceStartIndex([3, 9], 12), 9);
	});

	it("uses the most recent trigger strictly before the current index", () => {
		// A trigger at or after the current turn must not bound its own slice.
		assert.equal(sliceStartIndex([3, 9], 5), 3);
		assert.equal(sliceStartIndex([3, 9], 3), 0);
		assert.equal(sliceStartIndex([3, 9], 1), 0);
	});

	it("respects the ceiling when no triggers exist", () => {
		const start = sliceStartIndex([], 20);
		assert.equal(start, 20 - EVIDENCE_SLICE_CEILING + 1);
	});

	it("clamps a distant trigger to the ceiling window", () => {
		const start = sliceStartIndex([1], 30);
		assert.equal(start, 30 - EVIDENCE_SLICE_CEILING + 1);
	});

	it("never returns a negative start", () => {
		assert.equal(sliceStartIndex([], 2), 0);
	});
});

// ───────────────────── trigger collection from message ids ─────────────────────

describe("trigger collection", () => {
	it("maps message ids to pair indexes via the full message-id map", () => {
		const pairs = buildTurnPairs(makeMessages(4));
		const map = buildMessageIdToPairIndex(pairs);
		// Every turn-starting id AND assistant id resolves to its pair index.
		for (const p of pairs) {
			for (const id of p.messageIds) assert.equal(map.get(id), p.index);
		}
	});

	it("collects sorted de-duplicated indexes and drops unknown ids", () => {
		const pairs = buildTurnPairs(makeMessages(6));
		const map = buildMessageIdToPairIndex(pairs);
		const idx = collectTriggerPairIndexes(map, [
			["msg-u-5", "unknown-id"],
			["msg-a-2"],
			["msg-u-5", "msg-u-2"], // duplicates collapse
		]);
		assert.deepEqual(idx, [2, 5]);
	});
});

// ─────────────────────────── digest fixtures ───────────────────────────

let nodeSeq = 0;

function makeMessages(turns: number): MessageRow[] {
	const messages: MessageRow[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: `user request ${i}`, content_thinking: null, tool_calls: null, tool_results: null, model: null, cost_usd: null, stop_reason: null, error_message: null, id: `msg-u-${i}` });
		messages.push({ session_id: "s1", parent_id: null, timestamp: null, role: "assistant", content_text: `assistant reply ${i}`, content_thinking: null, tool_calls: JSON.stringify([{ name: "bash", arguments: { command: `cmd ${i}` } }]), tool_results: null, model: null, cost_usd: null, stop_reason: null, error_message: null, id: `msg-a-${i}` });
	}
	return messages;
}

function coreNode(props: Partial<TurnPairCoreProperties> & { user_message_id: string }): AnalysisNodeRow {
	const full: TurnPairCoreProperties = {
		pair_index: props.pair_index ?? 0,
		user_message_id: props.user_message_id,
		correction_detected: props.correction_detected ?? false,
		correction_type: props.correction_type ?? null,
		correction_patterns: props.correction_patterns ?? [],
		correction_text: props.correction_text ?? null,
		tool_call_count: props.tool_call_count ?? 0,
		tool_failure_count: props.tool_failure_count ?? 0,
		tool_result_bytes: props.tool_result_bytes ?? 0,
		tool_waste_bytes: props.tool_waste_bytes ?? 0,
		empty_response: props.empty_response ?? false,
		friction_score: props.friction_score ?? 0.1,
		high_signal: props.high_signal ?? false,
	};
	return {
		id: `core-${nodeSeq++}`,
		session_id: "s1",
		analyzer_id: "turn-pair-core",
		analyzer_version_id: "1.0.0",
		config_id: "c",
		run_id: null,
		node_kind: "metric",
		content_json: JSON.stringify(full),
		source_set_hash: "ssh",
		config_fingerprint: "",
		input_key: `ik-${nodeSeq}`,
		output_key: `ok-core-${nodeSeq}`,
		model_used: null,
		cost_usd: null,
		tokens_used: null,
		duration_ms: null,
		created_at: new Date().toISOString(),
	};
}

function signal(pattern: string, messageIds: string[], count = 3): TrajectorySignal {
	return {
		pattern: pattern as TrajectorySignal["pattern"],
		tool: "bash",
		normalizedArgs: "cmd",
		count,
		messageIds,
		cost_usd: null,
		description: `${pattern} detected`,
		riskClass: "non-blocking",
	};
}

function trajectoryNode(signals: TrajectorySignal[]): AnalysisNodeRow {
	const full: ToolTrajectoryProperties = {
		session_id: "s1",
		signals,
		trajectory_friction_score: 0.3,
		trajectory_cost_usd: null,
		priced_signal_count: 0,
		unpriced_signal_count: signals.length,
		pattern_counts: {},
		tool_call_count: 12,
	};
	return { ...coreNode({ user_message_id: "x" }), analyzer_id: "tool-trajectory", node_kind: "metric", content_json: JSON.stringify(full) };
}

function phaseNode(userMessageIds: string[], phases: string[]): AnalysisNodeRow {
	const entries = userMessageIds.map((id, i) => ({
		turn_index: i,
		phase: phases[i],
		user_message_id: id,
		message_ids: [],
		sample_commands: [],
	}));
	const full: PhaseTrajectoryProperties = {
		session_id: "s1",
		phases: entries as unknown as PhaseTrajectoryProperties["phases"],
		signals: [],
		signal_counts: {},
		plan_violation_count: 0,
		longest_phase_run: 3,
		turn_count: entries.length,
		patched: true,
	};
	return { ...coreNode({ user_message_id: "x" }), analyzer_id: "phase-trajectory", node_kind: "metric", content_json: JSON.stringify(full) };
}

function digestFor(messages: MessageRow[], coreNodes: AnalysisNodeRow[], trajectoryNodes: AnalysisNodeRow[], phaseNodes?: AnalysisNodeRow[]) {
	return buildDigest({
		sessionId: "s1",
		messages,
		coreNodes,
		llmNodes: [],
		trajectoryNodes,
		phaseNodes,
	});
}

/** The per-turn evidence lines inside one rendered block ("  #3 friction=..."). */
function evidenceLines(block: string): string[] {
	return block.split("\n").filter((l) => /^  #\d+ /.test(l));
}

// ───────────────────── digest — event-centered evidence ─────────────────────

describe("buildDigest — trajectory evidence slices (issue #118)", () => {
	it("renders the turns since the previous trigger, not a fixed window", () => {
		const turns = 8;
		const messages = makeMessages(turns);
		const coreNodes = Array.from({ length: turns }, (_, i) =>
			coreNode({ pair_index: i, user_message_id: `msg-u-${i}`, high_signal: i === 2 }),
		);
		const trajectoryNodes = [trajectoryNode([signal("stuck-loop", ["msg-a-5"])])];

		const digest = digestFor(messages, coreNodes, trajectoryNodes);

		assert.equal(digest.trajectoryEvidenceBlocks.length, 1);
		const block = digest.trajectoryEvidenceBlocks[0]!;
		// Previous trigger is the high-signal flag at pair #2 → slice runs #2..#5.
		assert.ok(block.includes("evidence slice #2..#5"), block);
		const lines = evidenceLines(block);
		assert.deepEqual(
			lines.map((l) => Number(/#(\d+)/.exec(l)![1])),
			[2, 3, 4, 5],
		);
		assert.ok(!block.includes("#0 "), "turns before the previous trigger are excluded");
		assert.ok(!block.includes("#1 "));
		// Each line carries bounded per-turn evidence.
		assert.ok(lines[0]!.includes("friction="));
		assert.ok(lines.some((l) => l.includes('text="user request 5"')));
		// The bare per-signal summary lines remain available.
		assert.equal(digest.trajectoryLines.length, 1);
	});

	it("bounds the slice by EVIDENCE_SLICE_CEILING when no triggers exist", () => {
		const turns = 30;
		const messages = makeMessages(turns);
		const coreNodes = Array.from({ length: turns }, (_, i) =>
			coreNode({ pair_index: i, user_message_id: `msg-u-${i}` }),
		);
		const trajectoryNodes = [trajectoryNode([signal("stuck-loop", ["msg-a-29"])])];

		const digest = digestFor(messages, coreNodes, trajectoryNodes);

		const lines = evidenceLines(digest.trajectoryEvidenceBlocks[0]!);
		assert.ok(lines.length <= EVIDENCE_SLICE_CEILING, `expected ≤ ${EVIDENCE_SLICE_CEILING} lines, got ${lines.length}`);
		assert.ok(digest.trajectoryEvidenceBlocks[0]!.includes(`evidence slice #${30 - EVIDENCE_SLICE_CEILING}..#29`));
	});

	it("prefers a phase transition boundary when phase-trajectory nodes exist", () => {
		const turns = 10;
		const messages = makeMessages(turns);
		const coreNodes = Array.from({ length: turns }, (_, i) =>
			coreNode({ pair_index: i, user_message_id: `msg-u-${i}` }),
		);
		// Phases: navigate ×6, then patch at turn 6 — a transition there.
		const phases = ["navigate", "navigate", "navigate", "navigate", "navigate", "navigate", "patch", "patch", "patch", "patch"];
		const phaseNodes = [phaseNode(phases.map((_, i) => `msg-u-${i}`), phases)];
		const trajectoryNodes = [trajectoryNode([signal("stuck-loop", ["msg-a-9"])])];

		const digest = digestFor(messages, coreNodes, trajectoryNodes, phaseNodes);

		const block = digest.trajectoryEvidenceBlocks[0]!;
		assert.ok(block.includes("evidence slice #6..#9"), block);
		assert.deepEqual(evidenceLines(block).map((l) => /#(\d+)/.exec(l)![1]), ["6", "7", "8", "9"]);
	});

	it("renders a bare signal line when no participating message maps to a turn", () => {
		const messages = makeMessages(3);
		const coreNodes = Array.from({ length: 3 }, (_, i) => coreNode({ pair_index: i, user_message_id: `msg-u-${i}` }));
		const trajectoryNodes = [trajectoryNode([signal("oscillation", ["ghost-id"])])];

		const digest = digestFor(messages, coreNodes, trajectoryNodes);

		assert.equal(digest.trajectoryEvidenceBlocks.length, 1);
		assert.ok(!digest.trajectoryEvidenceBlocks[0]!.includes("evidence slice"));
		assert.ok(digest.trajectoryEvidenceBlocks[0]!.includes("trajectory:oscillation"));
	});

	it("scales with event count: one bounded slice block per trajectory signal", () => {
		const turns = 20;
		const messages = makeMessages(turns);
		const coreNodes = Array.from({ length: turns }, (_, i) =>
			coreNode({ pair_index: i, user_message_id: `msg-u-${i}` }),
		);
		const trajectoryNodes = [
			trajectoryNode([
				signal("stuck-loop", ["msg-a-5"]),
				signal("polling-loop", ["msg-a-11"]),
				signal("pre-flight-gap", ["msg-a-19"]),
			]),
		];
		const digest = digestFor(messages, coreNodes, trajectoryNodes);
		assert.equal(digest.trajectoryEvidenceBlocks.length, 3);
		for (const block of digest.trajectoryEvidenceBlocks) {
			assert.ok(evidenceLines(block).length <= EVIDENCE_SLICE_CEILING);
		}
		// The full text carries all blocks under one section.
		assert.equal((digest.text.match(/^### Trajectory signals$/gm) ?? []).length, 1);
	});
});

// ─────────────────── classify prompt carries the slice ───────────────────

const sliceTurn = (index: number): SliceTurn => ({
	index,
	userText: `prior user request ${index} `.repeat(20),
	assistantText: `prior assistant reply ${index}`,
});

describe("buildClassifyPrompt — prior turns since last signal (issue #118)", () => {
	it("renders the event-centered slice before the current turn", () => {
		const prompt = buildClassifyPrompt({
			userText: "current user request",
			assistantText: "current assistant reply",
			correctionText: null,
			toolCalls: [],
			toolResults: [],
			priorTurns: [sliceTurn(3), sliceTurn(4)],
		});
		assert.ok(prompt.includes("PRIOR TURNS SINCE LAST SIGNAL"));
		assert.ok(prompt.includes("--- prior turn #3 ---"));
		assert.ok(prompt.includes("--- prior turn #4 ---"));
		// Current turn still rendered in full after the run-up.
		assert.ok(prompt.includes("USER MESSAGE:"));
		assert.ok(prompt.indexOf("PRIOR TURNS SINCE LAST SIGNAL") < prompt.indexOf("USER MESSAGE:\ncurrent"));
	});

	it("omits the section when the slice is empty", () => {
		const prompt = buildClassifyPrompt({
			userText: "u",
			assistantText: "a",
			correctionText: null,
			toolCalls: [],
			toolResults: [],
			priorTurns: [],
		});
		assert.ok(!prompt.includes("PRIOR TURNS SINCE LAST SIGNAL"));
	});

	it("is bounded: never renders more than EVIDENCE_SLICE_CEILING prior turns", () => {
		const many: SliceTurn[] = Array.from({ length: EVIDENCE_SLICE_CEILING + 5 }, (_, i) => sliceTurn(i));
		const prompt = buildClassifyPrompt({
			userText: "u",
			assistantText: "a",
			correctionText: null,
			toolCalls: [],
			toolResults: [],
			priorTurns: many,
		});
		const rendered = (prompt.match(/--- prior turn #/g) ?? []).length;
		assert.equal(rendered, EVIDENCE_SLICE_CEILING);
	});
});
