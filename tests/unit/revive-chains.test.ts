/**
 * Unit tests for the revive-chains analyzer: chain detection over the shared
 * action stream, the delegated usage rollup, and default registration.
 *
 * All fixtures are hand-written synthetic data — no real session content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildToolStream } from "../../src/analyze/tool-stream.js";
import type { MessageRow, SubagentRunRow } from "../../src/analyze/types.js";
import {
	chainLengthHistogram,
	detectReviveChains,
	rollupDelegatedUsage,
	type ReviveChain,
} from "../../src/analyze/analyzers/revive-chains/detect.js";
import { DEFAULT_REVIVE_CHAINS_CONFIG } from "../../src/analyze/analyzers/revive-chains/config.js";
import { REVIVE_CHAINS_DEF, REVIVE_CHAINS_VERSION } from "../../src/analyze/analyzers/revive-chains/index.js";
import { BUILTIN_ANALYZERS, DEFAULT_ANALYZER_IDS } from "../../src/analyze/defaults.js";

// ──────────────────── fixture helpers ────────────────────

let seq = 0;

function msg(over: Partial<MessageRow>): MessageRow {
	return {
		id: over.id ?? `m${seq++}`,
		session_id: "s1",
		parent_id: null,
		timestamp: null,
		role: "assistant",
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...over,
	};
}

/** An assistant turn that calls `subagent` (or any other named tool). */
function subagentCall(callId: string, name = "subagent", id?: string): MessageRow {
	return msg({
		id: id ?? `call-${callId}`,
		role: "assistant",
		tool_calls: JSON.stringify([{ id: callId, name, arguments: {} }]),
	});
}

/** A toolResult row carrying a classified subagent outcome. */
function subagentResult(
	callId: string,
	outcome: { status: string; runId?: string } | null,
	text = "Revived async subagent from x.",
	id?: string,
): MessageRow {
	return msg({
		id: id ?? `result-${callId}`,
		role: "toolResult",
		content_text: text,
		tool_results: JSON.stringify([
			{
				toolCallId: callId,
				toolName: "subagent",
				isError: false,
				textLength: text.length,
				...(outcome ? { subagent: { ...outcome, excerpt: text.slice(0, 500) } } : {}),
			},
		]),
	});
}

function run(over: Partial<SubagentRunRow>): SubagentRunRow {
	return {
		run_id: over.run_id ?? `r${seq++}`,
		project: "p",
		agent: "general-purpose",
		task_excerpt: null,
		exit_code: 0,
		error: null,
		model_attempts: null,
		usage: null,
		file_mtime: 0,
		ingested_at: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

/** Build a stream from alternating call/result rows, in order. */
function streamOf(pairs: Array<{ callId: string; name?: string; outcome: { status: string; runId?: string } | null; text?: string }>) {
	const rows: MessageRow[] = [];
	for (const p of pairs) {
		rows.push(subagentCall(p.callId, p.name));
		rows.push(subagentResult(p.callId, p.outcome, p.text));
	}
	return buildToolStream(rows);
}

// ──────────────────── chain detection ────────────────────

describe("detectReviveChains", () => {
	it("returns nothing for a session with no subagent traffic", () => {
		const rows: MessageRow[] = [
			msg({ role: "assistant", tool_calls: JSON.stringify([{ id: "b1", name: "bash", arguments: {} }]) }),
			msg({
				role: "toolResult",
				tool_results: JSON.stringify([{ toolCallId: "b1", toolName: "bash", isError: false, textLength: 3 }]),
			}),
		];
		assert.deepEqual(detectReviveChains(buildToolStream(rows)), []);
	});

	it("returns nothing when subagent results exist but none revived", () => {
		const stream = streamOf([
			{ callId: "c1", outcome: { status: "completed" }, text: "Children: 1 completed." },
			{ callId: "c2", outcome: { status: "child_failed" }, text: "Children: 1 failed." },
		]);
		assert.deepEqual(detectReviveChains(stream), []);
	});

	it("reads a single revive as a chain of length one with no redundant spawns", () => {
		const stream = streamOf([{ callId: "c1", outcome: { status: "revived", runId: "r1" } }]);
		const chains = detectReviveChains(stream);
		assert.equal(chains.length, 1);
		assert.equal(chains[0]!.length, 1);
		assert.equal(chains[0]!.spawn_count, 1);
		assert.equal(chains[0]!.redundant_spawns, 0);
		assert.deepEqual(chains[0]!.run_ids, ["r1"]);
	});

	it("reads N consecutive revives as one chain of N spawns and N−1 redundant ones", () => {
		const stream = streamOf([
			{ callId: "c1", outcome: { status: "revived", runId: "r1" } },
			{ callId: "c2", outcome: { status: "revived", runId: "r2" } },
			{ callId: "c3", outcome: { status: "revived", runId: "r3" } },
		]);
		const chains = detectReviveChains(stream);
		assert.equal(chains.length, 1);
		assert.equal(chains[0]!.length, 3);
		assert.equal(chains[0]!.spawn_count, 3);
		assert.equal(chains[0]!.redundant_spawns, 2);
		assert.deepEqual(chains[0]!.run_ids, ["r1", "r2", "r3"]);
	});

	it("keeps the chain across assistant turns that carry no tool calls", () => {
		// The parent thinking between two revives is the normal shape of the
		// pattern — text-only turns must not break adjacency.
		const rows: MessageRow[] = [
			subagentCall("c1"),
			subagentResult("c1", { status: "revived", runId: "r1" }),
			msg({ role: "assistant", content_text: "thinking about what the child said" }),
			subagentCall("c2"),
			subagentResult("c2", { status: "revived", runId: "r2" }),
		];
		const chains = detectReviveChains(buildToolStream(rows));
		assert.equal(chains.length, 1);
		assert.equal(chains[0]!.length, 2);
	});

	it("splits the chain when a subagent result has another status", () => {
		const stream = streamOf([
			{ callId: "c1", outcome: { status: "revived", runId: "r1" } },
			{ callId: "c2", outcome: { status: "completed" }, text: "Children: 1 completed." },
			{ callId: "c3", outcome: { status: "revived", runId: "r3" } },
		]);
		const chains = detectReviveChains(stream);
		assert.equal(chains.length, 2);
		assert.ok(chains.every((c) => c.length === 1 && c.redundant_spawns === 0));
	});

	it("splits the chain when a child failure sits between revives", () => {
		const stream = streamOf([
			{ callId: "c1", outcome: { status: "revived", runId: "r1" } },
			{ callId: "c2", outcome: { status: "child_failed", failedChildren: 1 }, text: "Children: 1 failed." },
			{ callId: "c3", outcome: { status: "revived", runId: "r3" } },
		]);
		const chains = detectReviveChains(stream);
		assert.equal(chains.length, 2);
	});

	it("splits the chain when non-subagent traffic is interleaved", () => {
		const rows: MessageRow[] = [
			subagentCall("c1"),
			subagentResult("c1", { status: "revived", runId: "r1" }),
			msg({ role: "assistant", tool_calls: JSON.stringify([{ id: "b1", name: "bash", arguments: {} }]) }),
			msg({
				role: "toolResult",
				tool_results: JSON.stringify([{ toolCallId: "b1", toolName: "bash", isError: false, textLength: 3 }]),
			}),
			subagentCall("c2"),
			subagentResult("c2", { status: "revived", runId: "r2" }),
		];
		const chains = detectReviveChains(buildToolStream(rows));
		assert.equal(chains.length, 2);
		assert.deepEqual(chains.map((c) => c.run_ids), [["r1"], ["r2"]]);
	});

	it("records the carrying message ids in stream order", () => {
		const rows: MessageRow[] = [
			subagentCall("c1"),
			subagentResult("c1", { status: "revived", runId: "r1" }),
			subagentCall("c2"),
			subagentResult("c2", { status: "revived", runId: "r2" }),
		];
		const chains = detectReviveChains(buildToolStream(rows));
		assert.deepEqual(chains[0]!.message_ids, ["result-c1", "result-c2"]);
	});
});

describe("chainLengthHistogram", () => {
	it("buckets chains by length", () => {
		const chains = [
			{ length: 1, spawn_count: 1, redundant_spawns: 0, run_ids: [], message_ids: [], first_ordinal: 0, last_ordinal: 0 },
			{ length: 3, spawn_count: 3, redundant_spawns: 2, run_ids: [], message_ids: [], first_ordinal: 1, last_ordinal: 3 },
			{ length: 3, spawn_count: 3, redundant_spawns: 2, run_ids: [], message_ids: [], first_ordinal: 4, last_ordinal: 6 },
		] as ReviveChain[];
		assert.deepEqual(chainLengthHistogram(chains), { "1": 1, "3": 2 });
	});

	it("is empty for no chains", () => {
		assert.deepEqual(chainLengthHistogram([]), {});
	});
});

// ──────────────────── delegated usage rollup ────────────────────

describe("rollupDelegatedUsage", () => {
	const CHAIN = (runIds: string[]): ReviveChain => ({
		length: runIds.length,
		spawn_count: runIds.length,
		redundant_spawns: Math.max(0, runIds.length - 1),
		run_ids: runIds,
		message_ids: [],
		first_ordinal: 0,
		last_ordinal: 0,
	});

	it("sums recorded fields across attributed runs", () => {
		const rollup = rollupDelegatedUsage(
			[CHAIN(["r1", "r2"])],
			[
				run({ run_id: "r1", usage: JSON.stringify({ input: 100, output: 50, cacheRead: 10, cacheWrite: 20, cost: 0.01, turns: 3 }) }),
				run({ run_id: "r2", usage: JSON.stringify({ input: 200, output: 70, cacheRead: 30, cacheWrite: 40, cost: 0.02, turns: 5 }) }),
			],
		);
		assert.equal(rollup.attributed_runs, 2);
		assert.equal(rollup.unattributed_runs, 0);
		assert.equal(rollup.input.value, 300);
		assert.equal(rollup.output.value, 120);
		assert.equal(rollup.cache_read.value, 40);
		assert.equal(rollup.cache_write.value, 60);
		assert.equal(rollup.cost_usd.value, 0.03);
		assert.equal(rollup.turns.value, 8);
		for (const f of [rollup.input, rollup.output, rollup.cache_read, rollup.cache_write, rollup.cost_usd, rollup.turns]) {
			assert.equal(f.recorded_runs, 2);
		}
	});

	it("counts a marker with no artifact row as unattributed, never as zero", () => {
		const rollup = rollupDelegatedUsage(
			[CHAIN(["ghost", "r1"])],
			[run({ run_id: "r1", usage: JSON.stringify({ input: 100 }) })],
		);
		assert.equal(rollup.attributed_runs, 1);
		assert.equal(rollup.unattributed_runs, 1);
		assert.equal(rollup.input.value, 100);
		// Only one run recorded output; the total stays unknown, not 0.
		assert.equal(rollup.output.value, null);
		assert.equal(rollup.output.recorded_runs, 0);
	});

	it("counts an artifact row without usage as attributed but contributing nothing", () => {
		const rollup = rollupDelegatedUsage([CHAIN(["r1"])], [run({ run_id: "r1", usage: null })]);
		assert.equal(rollup.attributed_runs, 1);
		assert.equal(rollup.runs_without_usage, 1);
		assert.equal(rollup.input.value, null);
	});

	it("keeps a field null until some run records it", () => {
		const rollup = rollupDelegatedUsage(
			[CHAIN(["r1", "r2"])],
			[
				run({ run_id: "r1", usage: JSON.stringify({ input: 10 }) }),
				run({ run_id: "r2", usage: JSON.stringify({ input: 20, turns: 1 }) }),
			],
		);
		assert.equal(rollup.input.value, 30);
		assert.equal(rollup.turns.value, 1);
		assert.equal(rollup.cost_usd.value, null);
		assert.equal(rollup.output.value, null);
	});

	it("de-duplicates a run id revived in two separate chains", () => {
		const rollup = rollupDelegatedUsage(
			[CHAIN(["r1"]), CHAIN(["r1"])],
			[run({ run_id: "r1", usage: JSON.stringify({ input: 100 }) })],
		);
		assert.equal(rollup.attributed_runs, 1);
		assert.equal(rollup.input.value, 100);
	});

	it("ignores malformed usage blobs rather than guessing numbers", () => {
		const rollup = rollupDelegatedUsage([CHAIN(["r1"])], [run({ run_id: "r1", usage: "{not json" })]);
		assert.equal(rollup.attributed_runs, 1);
		assert.equal(rollup.runs_without_usage, 1);
		assert.equal(rollup.input.value, null);
	});

	it("reports all-zero attribution as nulls, not zeros, when nothing was recorded", () => {
		const rollup = rollupDelegatedUsage([], []);
		assert.equal(rollup.attributed_runs, 0);
		assert.equal(rollup.unattributed_runs, 0);
		assert.equal(rollup.input.value, null);
		assert.equal(rollup.cost_usd.value, null);
	});
});

// ──────────────────── registration ────────────────────

describe("revive-chains registration", () => {
	it("runs by default with the other deterministic analyzers", () => {
		assert.ok(BUILTIN_ANALYZERS.some((a) => a.def.id === "revive-chains"));
		assert.ok(DEFAULT_ANALYZER_IDS.includes("revive-chains"));
	});

	it("is deterministic and session-anchored with no dependencies", () => {
		assert.equal(REVIVE_CHAINS_VERSION.implementationKind, "deterministic");
		assert.equal(REVIVE_CHAINS_DEF.anchorSpan, "full_session");
		assert.deepEqual(REVIVE_CHAINS_DEF.dependencies, []);
	});

	it("ships a usable default config", () => {
		assert.ok(DEFAULT_REVIVE_CHAINS_CONFIG.minChainLength >= 2);
	});
});
