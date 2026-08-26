/**
 * plan-compliance — deterministic PPC/POC/PPF/PC scores over the phase
 * sequence (issue #121, after LivePlan §III-C2).
 *
 * Companion analyzer to phase-trajectory (issue #115): it CONSUMES that
 * analyzer's per-session phase node and emits its own `metric` node with four
 * scores —
 *
 *   - PPC  present canonical phases / total canonical phases
 *   - POC  1 - out-of-order transitions / transitions
 *   - PPF  turns in plan phases / total turns
 *   - PC   geometric mean of the three
 *
 * The companion shape is deliberate (the issue's refactor question): adding
 * these fields to the phase-trajectory node's content would change its
 * output_key and force every existing consumer to recompute. As a separate
 * analyzer whose source set references the phase node's output key, the phase
 * node stays stable, compliance evolves independently, and a recomputed
 * upstream conclusion still re-identifies this unit and forces honest
 * recomputation (DESIGN.md — consumers reference sources by output key).
 *
 * No LLM, no new inputs. One node per session beside the other session-level
 * deterministic graders.
 *
 * CAVEAT (#121, #102): PC correlates with resolved outcomes in LivePlan's
 * benchmark, but this system has no ground-truth outcome label. PC is a
 * FEATURE for ranking and cross-session contrast — never an outcome label on
 * its own; a session that followed its plan perfectly and still failed would
 * be mislabeled by PC alone.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { PHASE_TRAJECTORY_DEF } from "../phase-trajectory/index.js";
import { PLAN_PHASES, type PhaseName, type PlanPhase } from "../phase-trajectory/config.js";
import { DEFAULT_PLAN_COMPLIANCE_CONFIG, type PlanComplianceConfig } from "./config.js";
import { computePlanCompliance, formatComplianceDigestLine } from "./compliance.js";

export const PhaseNameForSchema = Type.Union([
	Type.Literal("navigate"),
	Type.Literal("reproduce"),
	Type.Literal("patch"),
	Type.Literal("validate"),
]);

/** The properties a plan-compliance node carries in its `contentJson`. */
export const PlanComplianceProperties = Type.Object({
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** Plan Phase Compliance: present canonical phases / canonical phases. */
	ppc: Type.Number(),
	/** Plan Order Compliance: 1 - out-of-order transitions / transitions. */
	poc: Type.Number(),
	/** Plan Phase Fidelity: turns in plan phases / total turns. */
	ppf: Type.Number(),
	/** Plan Compliance: geometric mean of ppc, poc, ppf. */
	pc: Type.Number(),
	/** Canonical phases present in the session, in canonical order. */
	present_phases: Type.Array(PhaseNameForSchema),
	/** Canonical phases never reached, in canonical order. */
	skipped_phases: Type.Array(PhaseNameForSchema),
	total_canonical_phases: Type.Number(),
	/** Transitions between distinct plan phases. */
	transitions: Type.Number(),
	out_of_order_transitions: Type.Number(),
	turn_count: Type.Number(),
	/** Turns classified into any plan phase (not `other`). */
	canonical_turn_count: Type.Number(),
	/**
	 * The digest line session-overview renders for this session — computed once
	 * here so every consumer quotes the same bounded sentence.
	 */
	digest_line: Type.String(),
});
export type PlanComplianceProperties = Static<typeof PlanComplianceProperties>;

export const PLAN_COMPLIANCE_DEF: AnalyzerDef = {
	id: "plan-compliance",
	label: "Plan Compliance Metrics (deterministic)",
	description:
		"Consumes phase-trajectory's phase sequence and emits the LivePlan plan-compliance scores: PPC (phases present), POC (order of transitions), PPF (fidelity to plan phases), and PC (their geometric mean) (#121). Pure functions of the phase sequence — no model, no new inputs. PC is a ranking/contrast feature, never an outcome label.",
	anchorSpan: "full_session",
	dependencies: [PHASE_TRAJECTORY_DEF.id],
	outputSchema: PlanComplianceProperties,
};

export const PLAN_COMPLIANCE_VERSION: AnalyzerVersion = {
	analyzerId: PLAN_COMPLIANCE_DEF.id,
	// 1.0 (issue #121): companion-analyzer shape over phase-trajectory's stable
	// phase node; four deterministic scores plus the shared digest line.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/plan-compliance/index.ts",
};

function resolveConfig(raw: unknown): PlanComplianceConfig {
	return (raw as PlanComplianceConfig) ?? DEFAULT_PLAN_COMPLIANCE_CONFIG;
}

/**
 * The newest non-error dependency node per logical unit, keyed by session.
 * Mirrors friction-accumulation's fold: after a revise run a dependency may
 * carry several live versions of one logical unit, and only the newest is real
 * input — folding older versions into identity would double-count conclusions
 * the graph no longer considers current. Iterating in created_at ASC order and
 * overwriting keeps the newest.
 */
function latestPhaseNode(nodes: readonly AnalysisNodeRow[]): AnalysisNodeRow | null {
	let latest: AnalysisNodeRow | null = null;
	for (const node of nodes) {
		if (node.node_kind === "error") continue;
		try {
			const props = JSON.parse(node.content_json) as Record<string, unknown>;
			if (!Array.isArray(props["phases"])) continue;
			if (!Array.isArray(props["signals"])) continue;
		} catch {
			continue;
		}
		latest = node;
	}
	return latest;
}

/** The phase names a well-formed phase-trajectory node can carry. */
const KNOWN_PHASES: ReadonlySet<string> = new Set([...PLAN_PHASES, "other"]);

interface ConsumedPhases {
	node: AnalysisNodeRow;
	entries: Array<{ phase: PhaseName }>;
}

function readPhases(node: AnalysisNodeRow): ConsumedPhases | null {
	try {
		const props = JSON.parse(node.content_json) as { phases?: Array<{ phase?: unknown }> };
		if (!Array.isArray(props.phases)) return null;
		return {
			node,
			entries: props.phases.flatMap((e) => {
				const phase = e && typeof e.phase === "string" && KNOWN_PHASES.has(e.phase) ? (e.phase as PhaseName) : null;
				return phase ? [{ phase }] : [];
			}),
		};
	} catch {
		return null;
	}
}

// ─────────────────────────── analyzer ───────────────────────────

export const planComplianceAnalyzer: Analyzer = {
	def: PLAN_COMPLIANCE_DEF,
	version: PLAN_COMPLIANCE_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: PLAN_COMPLIANCE_DEF.id,
		configHash: computeConfigHash(DEFAULT_PLAN_COMPLIANCE_CONFIG),
		configJson: DEFAULT_PLAN_COMPLIANCE_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * One unit per session when a phase-trajectory node exists, planned from its
	 * OUTPUT KEY alone — cheap fingerprint work; the math happens in analyze().
	 * Because the source set references the upstream conclusion by output key, a
	 * recomputed phase node changes this unit's identity and honestly marks it
	 * out of date. With no phase node there is nothing to score: no unit is
	 * planned (inventing all-zero scores for an unclassified session would lie).
	 */
	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const consumed = latestPhaseNode(ctx.dependencyNodes[PHASE_TRAJECTORY_DEF.id] ?? []);
		if (!consumed) return [];

		const sources: SourceRef[] = [{ kind: "analysis_node", id: consumed.output_key }];
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const nodes = await ctx.getDependencyNodes(PHASE_TRAJECTORY_DEF.id);
		const consumed = latestPhaseNode(nodes);
		if (!consumed) {
			throw new Error(
				`plan-compliance: no phase-trajectory node found for session ${ctx.sessionId} at run time despite being planned`,
			);
		}
		const phases = readPhases(consumed);
		if (!phases) {
			throw new Error(`plan-compliance: unparseable phase-trajectory node ${consumed.id}`);
		}

		const order: readonly PlanPhase[] =
			config.canonicalOrder.length > 0 ? config.canonicalOrder : [...PLAN_PHASES];
		const scores = computePlanCompliance(phases.entries, order);

		const properties: PlanComplianceProperties = {
			session_id: ctx.sessionId,
			ppc: scores.ppc,
			poc: scores.poc,
			ppf: scores.ppf,
			pc: scores.pc,
			present_phases: scores.presentPhases,
			skipped_phases: scores.skippedPhases,
			total_canonical_phases: scores.totalCanonicalPhases,
			transitions: scores.transitions,
			out_of_order_transitions: scores.outOfOrderTransitions,
			turn_count: scores.turnCount,
			canonical_turn_count: scores.canonicalTurnCount,
			digest_line: formatComplianceDigestLine({
				pc: scores.pc,
				ppc: scores.ppc,
				poc: scores.poc,
				ppf: scores.ppf,
				skipped_phases: scores.skippedPhases,
			}),
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			{ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: consumed.output_key, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 },
		];

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
