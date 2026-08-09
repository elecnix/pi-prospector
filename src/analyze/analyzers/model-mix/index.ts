/**
 * model-mix — the efficiency frontier over our own corpus, computed from the
 * per-turn routing labels (#68 + #69, one unit).
 *
 * **Why this is a read-time fold, not a per-session analysis node.** The per-turn
 * `routing-opportunity` analyzer is additive and concurrency-stable: one node per
 * turn, keyed by that turn, whose identity folds in only that turn's inputs. The
 * efficiency frontier, by contrast, is a *cumulative cross-session aggregate*:
 * its content is a function of every routing label in the corpus. Representing
 * that as a per-session append-only node would force the corpus into the node's
 * recipe — which makes the node churn (every new session invalidates it) and,
 * worse, races under concurrency (a concurrent run sees a different corpus
 * snapshot, so the produced node set diverges from a sequential run). Both
 * violate the invariant the concurrency-identity test guards: "a concurrent run
 * yields the same nodes as a sequential one." A cumulative aggregate therefore
 * has no honest home as a per-session node; its honest home is a **pure function
 * of the routing corpus, re-derived at read time** — the routing nodes are the
 * content-addressed cache ("the graph is the cache"), and the frontier is always
 * current because it is never cached in a node that could go stale.
 *
 * So this module holds the deterministic frontier computation (per-model
 * quality/cost table + dominance + retry analysis), and the `prospect models`
 * command folds the routing corpus through it. All of it is no-LLM and tested.
 *
 * Honest lower bounds: cost is only the *priced* turns (a turn with no recorded
 * billed amount is counted in `unpriced_turn_count` and contributes $0, never a
 * guess); a model with no priced turns has a null avg cost and cannot dominate
 * or be dominated. `unrecorded_model_turn_count` states how many turns could not
 * be attributed to a model. A verdict is only drawn for models above
 * `minTurnCountPerModel` — a two-session sample must not generate a confident
 * recommendation.
 */

import type { AnalysisNodeRow } from "../../types.js";
import type { RoutingProperties } from "../routing-opportunity/index.js";
import { DEFAULT_MODEL_MIX_CONFIG, type ModelMixConfig } from "./config.js";

export { DEFAULT_MODEL_MIX_CONFIG, type ModelMixConfig } from "./config.js";

export interface ModelStats {
	model: string;
	turn_count: number;
	correction_rate: number;
	friction_rate: number;
	tool_failure_rate: number;
	stuck_loop_rate: number;
	oscillation_rate: number;
	escalation_rate: number;
	downshift_count: number;
	/** Sum of the billed cost of the priced turns, or null when none priced. */
	total_cost_usd: number | null;
	/** avg cost per *priced* turn, or null when none priced. */
	avg_cost_per_priced_turn: number | null;
	priced_turn_count: number;
	unpriced_turn_count: number;
}

export interface ModelMixResult {
	corpus: {
		session_count: number;
		routing_turn_count: number;
		unrecorded_model_turn_count: number;
		priced_turn_count: number;
		unpriced_turn_count: number;
	};
	min_turn_count_per_model: number;
	per_model: ModelStats[];
}

export interface FrontierSuggestion {
	target_type: string;
	title: string;
	summary: string;
	detail: string;
	evidence: string;
	confidence: number;
	severity: string;
}

// ── aggregation (pure, exported for unit tests) ──

export function aggregateModels(nodes: AnalysisNodeRow[], cfg: ModelMixConfig): { result: ModelMixResult; suggestions: FrontierSuggestion[] } {
	const perModel = new Map<string, {
		correction: number;
		toolFailure: number;
		stuckLoop: number;
		oscillation: number;
		frustration: number;
		escalate: number;
		downshift: number;
		turns: number;
		cost: number;
		pricedTurns: number;
	}>();
	let routingTurnCount = 0;
	let unrecordedModelTurns = 0;
	let pricedTurns = 0;
	let unpricedTurns = 0;

	for (const node of nodes) {
		let r: RoutingProperties;
		try {
			r = JSON.parse(node.content_json) as RoutingProperties;
		} catch {
			continue;
		}
		if (typeof r.pair_index !== "number") continue;
		routingTurnCount++;
		const m = r.model_recorded === true && r.model !== "unrecorded" ? r.model : "unrecorded";
		if (m === "unrecorded") unrecordedModelTurns++;
		let s = perModel.get(m);
		if (!s) {
			s = {
				correction: 0,
				toolFailure: 0,
				stuckLoop: 0,
				oscillation: 0,
				frustration: 0,
				escalate: 0,
				downshift: 0,
				turns: 0,
				cost: 0,
				pricedTurns: 0,
			};
			perModel.set(m, s);
		}
		s.turns++;
		if (r.features?.correction_detected) s.correction++;
		if (r.features?.stuck_loop) s.stuckLoop++;
		if (r.features?.oscillation) s.oscillation++;
		if (r.features?.frustration) s.frustration++;
		if (r.features?.tool_failure_count) s.toolFailure += r.features.tool_failure_count;
		if (r.verdict === "escalate") s.escalate++;
		if (r.verdict === "downshift") s.downshift++;
		if (typeof r.turn_cost_usd === "number" && Number.isFinite(r.turn_cost_usd) && r.turn_cost_usd > 0) {
			s.cost += r.turn_cost_usd;
			s.pricedTurns++;
			pricedTurns++;
		} else {
			unpricedTurns++;
		}
	}

	const perModelStats: ModelStats[] = [...perModel.entries()].map(([model, s]) => {
		const t = s.turns;
		const priced = s.pricedTurns;
		return {
			model,
			turn_count: t,
			correction_rate: t > 0 ? s.correction / t : 0,
			friction_rate: t > 0 ? s.frustration / t : 0,
			tool_failure_rate: t > 0 ? s.toolFailure / t : 0,
			stuck_loop_rate: t > 0 ? s.stuckLoop / t : 0,
			oscillation_rate: t > 0 ? s.oscillation / t : 0,
			escalation_rate: t > 0 ? s.escalate / t : 0,
			downshift_count: s.downshift,
			total_cost_usd: priced > 0 ? s.cost : null,
			avg_cost_per_priced_turn: priced > 0 ? s.cost / priced : null,
			priced_turn_count: priced,
			unpriced_turn_count: t - priced,
		};
	});

	const result: ModelMixResult = {
		corpus: {
			session_count: new Set(nodes.map((n) => n.session_id)).size,
			routing_turn_count: routingTurnCount,
			unrecorded_model_turn_count: unrecordedModelTurns,
			priced_turn_count: pricedTurns,
			unpriced_turn_count: unpricedTurns,
		},
		min_turn_count_per_model: cfg.minTurnCountPerModel,
		per_model: perModelStats,
	};

	const suggestions = buildSuggestions(perModelStats, cfg);
	return { result, suggestions };
}

/**
 * Deterministic dominance + retry analysis over models with enough turns.
 * A model with no priced average cannot dominate or be dominated (we cannot
 * compare what we cannot price). Downshift dollars are only the *easy* turns on
 * a dominated model (a lower bound — not every turn on it was easy).
 */
export function buildSuggestions(stats: ModelStats[], cfg: ModelMixConfig): FrontierSuggestion[] {
	const eligible = stats.filter((s) => s.turn_count >= cfg.minTurnCountPerModel && s.avg_cost_per_priced_turn !== null);
	const front: FrontierSuggestion[] = [];

	for (const m of eligible) {
		// Dominated: another eligible model is cheaper AND no worse on every quality axis.
		const dominator = eligible.find(
			(o) =>
				o.model !== m.model &&
				o.avg_cost_per_priced_turn! < m.avg_cost_per_priced_turn! &&
				o.correction_rate <= m.correction_rate &&
				o.friction_rate <= m.friction_rate &&
				o.tool_failure_rate <= m.tool_failure_rate &&
				o.stuck_loop_rate <= m.stuck_loop_rate,
		);
		if (dominator && m.downshift_count > 0) {
			const avg = m.avg_cost_per_priced_turn!;
			const cheapAvg = dominator.avg_cost_per_priced_turn!;
			front.push({
				target_type: "config",
				title: `Efficiency frontier: ${m.model} is dominated by ${dominator.model}`,
				summary: `${m.model} costs $${avg.toFixed(4)}/priced turn with correction ${(m.correction_rate * 100).toFixed(0)}% / friction ${(m.friction_rate * 100).toFixed(0)}% — strictly more expensive and no better than ${dominator.model} ($${cheapAvg.toFixed(4)}, correction ${(dominator.correction_rate * 100).toFixed(0)}%, friction ${(dominator.friction_rate * 100).toFixed(0)}%).`,
				detail: `Of the ${m.turn_count} turns on ${m.model}, ${m.downshift_count} showed every easy marker and could likely have run on the cheaper model without measurable quality loss. Consider routing those turns down (allow-list / default-model change).`,
				evidence: `${m.downshift_count} easy turns × $${avg.toFixed(4)} ≈ $${(m.downshift_count * avg).toFixed(4)} downshiftable per priced turn (lower bound; unpriced turns excluded).`,
				confidence: 0.7,
				severity: "suggestion",
			});
		}
	}

	for (const m of eligible) {
		if (m.escalation_rate >= cfg.escalateRateThreshold) {
			front.push({
				target_type: "config",
				title: `${m.model}: ${(m.escalation_rate * 100).toFixed(0)}% of turns needed a more capable model`,
				summary: `${(m.escalation_rate * 100).toFixed(0)}% of the ${m.turn_count} turns on ${m.model} (${Math.round(m.escalation_rate * m.turn_count)}) drew a correction or a trajectory pathology — those retries often cost more than one capable turn would have.`,
				detail: `Naive cost-cutting creates exactly this failure mode: a cheap model that fails and retries can outspend the expensive turn it avoided. Consider routing turns that are hard to the more capable model, or escalating on the second retry.`,
				evidence: `escalation rate ${(m.escalation_rate * 100).toFixed(1)}%; ${m.total_cost_usd === null ? "no priced turns" : `$${m.total_cost_usd.toFixed(4)} priced total${(m.priced_turn_count < m.turn_count ? " (lower bound)" : "")}`}; stuck-loop ${(m.stuck_loop_rate * 100).toFixed(0)}%, correction ${(m.correction_rate * 100).toFixed(0)}%.`,
				confidence: 0.75,
				severity: "suggestion",
			});
		}
	}

	return front;
}
