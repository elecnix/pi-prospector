/**
 * Unit tests for routing-opportunity and model-mix pure logic.
 * Hand-computed, no DB, no framework.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateTurn, type RoutingProperties } from "../../src/analyze/analyzers/routing-opportunity/index.js";
import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "../../src/analyze/analyzers/routing-opportunity/config.js";
import { aggregateModels, buildSuggestions, type ModelStats } from "../../src/analyze/analyzers/model-mix/index.js";
import { DEFAULT_MODEL_MIX_CONFIG, type ModelMixConfig } from "../../src/analyze/analyzers/model-mix/config.js";
import type { TurnPair, PairToolCall, PairToolResult } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";

const rcfg: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG };
const mcfg: ModelMixConfig = { ...DEFAULT_MODEL_MIX_CONFIG };

function pair(o: Partial<TurnPair>): TurnPair {
	return {
		index: 0,
		userMessageId: "u0",
		messageIds: ["u0", "a0"],
		userText: "do it",
		assistantText: "ok",
		thinkingText: "",
		toolCalls: [],
		toolResults: [],
		priorUserText: null,
		timestamp: null,
		...o,
	};
}
function call(name: string): PairToolCall {
	return { name, argumentsPreview: "" };
}
function result(toolName: string, textLength: number, isError = false): PairToolResult {
	return { toolName, isError, textLength, errorHead: null };
}

describe("routing-opportunity evaluateTurn", () => {
	function inputs(overrides: {
		pair?: TurnPair;
		core?: { correction_detected: boolean; tool_failure_count: number; friction_score: number } | null;
		frustration?: boolean;
		trajectorySignals?: Array<{ pattern: string; messageIds: string[] }>;
		model?: string | null;
		cost?: number;
		usage?: { input: number; cacheRead: number };
	}) {
		const modelByMessageId = new Map<string, string | null>();
		const costByMessageId = new Map<string, number>();
		const usageByMessageId = new Map<string, { input: number; cacheRead: number }>();
		const msgs = (overrides.pair?.messageIds ?? ["u0", "a0"]);
		for (const id of msgs) {
			modelByMessageId.set(id, overrides.model !== undefined ? overrides.model : "claude-sonnet");
			if (overrides.cost) costByMessageId.set(id, overrides.cost);
			if (overrides.usage) usageByMessageId.set(id, overrides.usage);
		}
		return {
			pair: overrides.pair ?? pair({}),
			core: overrides.core ?? { correction_detected: false, tool_failure_count: 0, friction_score: 0 },
			frustration: overrides.frustration ?? false,
			trajectorySignals: overrides.trajectorySignals ?? [],
			modelByMessageId,
			costByMessageId,
			usageByMessageId,
			cfg: rcfg,
		};
	}

	it("labels an easy turn (few calls, small context, no signal) as downshift", () => {
		const p = pair({ toolCalls: [call("edit")], toolResults: [result("edit", 500)] });
		const r = evaluateTurn(inputs({ pair: p, usage: { input: 5000, cacheRead: 0 } }));
		assert.equal(r.verdict, "downshift");
		assert.equal(r.easy, true);
		assert.equal(r.model, "claude-sonnet");
		assert.equal(r.features.tool_call_count, 1);
		assert.equal(r.features.edit_chars, 500);
	});

	it("labels a corrected turn as escalate", () => {
		const p = pair({ toolCalls: [call("bash")] });
		const r = evaluateTurn(inputs({ pair: p, core: { correction_detected: true, tool_failure_count: 0, friction_score: 0.8 } }));
		assert.equal(r.verdict, "escalate");
		assert.equal(r.hard, true);
		assert.equal(r.easy, false);
	});

	it("labels a turn touched by a stuck-loop as escalate", () => {
		const p = pair({ messageIds: ["u0", "a0"], toolCalls: [call("bash")] });
		const r = evaluateTurn(
			inputs({ pair: p, trajectorySignals: [{ pattern: "stuck-loop", messageIds: ["a0"] }] }),
		);
		assert.equal(r.verdict, "escalate");
		assert.equal(r.features.stuck_loop, true);
	});

	it("keeps a many-tool-call clean turn neutral", () => {
		const p = pair({ toolCalls: [call("read"), call("bash"), call("edit"), call("bash")] });
		const r = evaluateTurn(inputs({ pair: p }));
		assert.equal(r.verdict, "neutral");
		assert.equal(r.easy, false);
		assert.equal(r.hard, false);
	});

	it("reports an unrecorded model and null cost honestly", () => {
		const p = pair({});
		const r = evaluateTurn(inputs({ pair: p, model: null }));
		assert.equal(r.model, "unrecorded");
		assert.equal(r.model_recorded, false);
		assert.equal(r.turn_cost_usd, null);
	});
});

describe("model-mix", () => {
	function routingNode(sessionId: string, r: Omit<RoutingProperties, "model" | "model_recorded" | "turn_cost_usd"> & { model?: string; model_recorded?: boolean; turn_cost_usd?: number | null }): AnalysisNodeRow {
		const full: RoutingProperties = {
			user_message_id: "u",
			pair_index: 0,
			model: r.model ?? "m-a",
			model_recorded: r.model_recorded ?? true,
			turn_cost_usd: r.turn_cost_usd ?? 0.01,
			features: r.features,
			easy: r.easy,
			hard: r.hard,
			verdict: r.verdict,
		};
		return {
			id: `n-${Math.random()}`,
			session_id: sessionId,
			analyzer_id: "routing-opportunity",
			analyzer_version_id: "v",
			config_id: "c",
			run_id: null,
			node_kind: "metric",
			content_json: JSON.stringify(full),
			source_set_hash: "s",
			input_key: "ik",
			output_key: "ok",
			config_fingerprint: "f",
			model_used: null,
			cost_usd: null,
			tokens_used: null,
			duration_ms: null,
			created_at: new Date().toISOString(),
		};
	}

	it("aggregates per-model correction/friction/cost and coverage", () => {
		const nodes = [
			// m-a: cheap, no corrections, low cost (won't dominate on price anyway below threshold)
			routingNode("s1", { pair_index: 0, features: { tool_call_count: 1, context_tokens: 1000, edit_chars: 10, correction_detected: false, tool_failure_count: 0, frustration: false, stuck_loop: false, oscillation: false, preflight_gap: false }, easy: true, hard: false, verdict: "downshift", model: "m-a", turn_cost_usd: 0.001 }),
			routingNode("s1", { pair_index: 1, features: { tool_call_count: 1, context_tokens: 1000, edit_chars: 10, correction_detected: false, tool_failure_count: 0, frustration: false, stuck_loop: false, oscillation: false, preflight_gap: false }, easy: true, hard: false, verdict: "downshift", model: "m-a", turn_cost_usd: 0.001 }),
			// m-b: expensive, a correction
			routingNode("s1", { pair_index: 2, features: { tool_call_count: 3, context_tokens: 90000, edit_chars: 100, correction_detected: true, tool_failure_count: 1, frustration: true, stuck_loop: false, oscillation: false, preflight_gap: false }, easy: false, hard: true, verdict: "escalate", model: "m-b", turn_cost_usd: 0.05 }),
			// unrecorded model
			routingNode("s2", { pair_index: 0, features: { tool_call_count: 2, context_tokens: 8000, edit_chars: 20, correction_detected: false, tool_failure_count: 0, frustration: false, stuck_loop: false, oscillation: false, preflight_gap: false }, easy: true, hard: false, verdict: "downshift", model: "unrecorded", model_recorded: false }),
		];
		const { result: props } = aggregateModels(nodes, mcfg);

		assert.equal(props.corpus.routing_turn_count, 4);
		assert.equal(props.corpus.session_count, 2);
		assert.equal(props.corpus.unrecorded_model_turn_count, 1);
		assert.equal(props.corpus.unpriced_turn_count, 0);

		const mA = props.per_model.find((s) => s.model === "m-a")!;
		assert.ok(mA);
		assert.equal(mA.turn_count, 2);
		assert.equal(mA.correction_rate, 0);
		assert.equal(mA.avg_cost_per_priced_turn, 0.001);
		assert.equal(mA.downshift_count, 2);

		const mB = props.per_model.find((s) => s.model === "m-b")!;
		assert.equal(mB.turn_count, 1);
		assert.equal(mB.correction_rate, 1);
		assert.equal(mB.escalation_rate, 1);
	});

	it("draws no verdict below minTurnCountPerModel (thin corpus)", () => {
		const nodes = [
			routingNode("s1", { pair_index: 0, features: { tool_call_count: 1, context_tokens: 100, edit_chars: 10, correction_detected: false, tool_failure_count: 0, frustration: false, stuck_loop: false, oscillation: false, preflight_gap: false }, easy: true, hard: false, verdict: "downshift", model: "m-a", turn_cost_usd: 0.001 }),
		];
		const { result: props, suggestions } = aggregateModels(nodes, { ...mcfg, minTurnCountPerModel: 20 });
		assert.equal(props.per_model[0]!.turn_count, 1);
		assert.equal(suggestions.length, 0, "two-session/one-turn sample must not produce a verdict");
	});

	it("surfaces a downshift suggestion for a dominated model with enough turns", () => {
		function make(model: string, cost: number, correction: boolean, stuck: boolean, easy: boolean, verdict: "downshift" | "escalate" | "neutral"): AnalysisNodeRow {
			return routingNode("s1", { pair_index: 0, features: { tool_call_count: 1, context_tokens: 100, edit_chars: 10, correction_detected: correction, tool_failure_count: 0, frustration: false, stuck_loop: stuck, oscillation: false, preflight_gap: false }, easy, hard: stuck || correction, verdict, model, turn_cost_usd: cost });
		}
		// 25 cheap, clean, easy turns on m-cheap; 25 expensive, clean, easy turns on m-pricey
		const nodes: AnalysisNodeRow[] = [];
		for (let i = 0; i < 25; i++) nodes.push(make("m-cheap", 0.001, false, false, true, "downshift"));
		for (let i = 0; i < 25; i++) nodes.push(make("m-pricey", 0.05, false, false, true, "downshift"));

		const { result: props, suggestions } = aggregateModels(nodes, mcfg);
		const cheap = props.per_model.find((s) => s.model === "m-cheap")!;
		const pricey = props.per_model.find((s) => s.model === "m-pricey")!;
		assert.ok(cheap.avg_cost_per_priced_turn! < pricey.avg_cost_per_priced_turn!);
		const down = suggestions.find((s) => s.title.includes("dominated"));
		assert.ok(down, "pricey model is dominated (more expensive, no worse)");
		assert.ok(down!.title.includes("m-pricey"));
	});

	it("flags a cheap model with a high escalation rate for retries", () => {
		function make(model: string, cost: number, correction: boolean, verdict: "downshift" | "escalate" | "neutral"): AnalysisNodeRow {
			return routingNode("s1", { pair_index: 0, features: { tool_call_count: 1, context_tokens: 100, edit_chars: 10, correction_detected: correction, tool_failure_count: 0, frustration: false, stuck_loop: false, oscillation: false, preflight_gap: false }, easy: !correction, hard: correction, verdict, model, turn_cost_usd: cost });
		}
		const nodes: AnalysisNodeRow[] = [];
		for (let i = 0; i < 10; i++) nodes.push(make("m-cheap", 0.001, false, "downshift"));
		// 10 failures → escalation_rate 0.5 ≥ 0.3
		for (let i = 0; i < 10; i++) nodes.push(make("m-cheap", 0.001, true, "escalate"));

		const { result: props, suggestions } = aggregateModels(nodes, mcfg);
		const cheap = props.per_model.find((s) => s.model === "m-cheap")!;
		assert.equal(cheap.escalation_rate, 0.5);
		const esc = suggestions.find((s) => s.title.includes("needed a more capable model"));
		assert.ok(esc, "escalation suggestion present for high-retry cheap model");
	});
});
