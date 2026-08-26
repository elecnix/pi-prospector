/**
 * The four plan-compliance metrics (issue #121, after LivePlan's PPC/POC/PPF/PC).
 *
 * Pure functions of a session's phase sequence — the `phases` entries of a
 * phase-trajectory node. No model, no new inputs.
 *
 *   - PPC (Plan Phase Compliance)  = present plan phases / canonical phases.
 *     Penalizes skipped phases.
 *   - POC (Plan Order Compliance)  = 1 - out_of_order_transitions / transitions.
 *     Penalizes phase changes that move backwards through the canonical order.
 *     Transitions are counted between *distinct* plan phases only: consecutive
 *     turns in the same phase are not a transition, and `other` sits outside
 *     the plan entirely (its cost is PPF's to price), so an interruption that
 *     resumes the same phase is not disorder.
 *   - PPF (Plan Phase Fidelity)    = turns in plan phases / total turns.
 *     Penalizes out-of-plan (`other`) behaviour.
 *   - PC  (Plan Compliance)        = geometric mean of the three. PC = 1 only
 *     when a trajectory executes all and only the canonical phases in order.
 *
 * Edge cases are decided, not undefined: with no transitions there is no
 * disorder to penalize, so POC is vacuously 1; an empty sequence demonstrates
 * no compliance at all, so PPC and PPF are 0 and PC follows as 0.
 */

import { PLAN_PHASES, type PhaseName, type PlanPhase } from "../phase-trajectory/config.js";

/** What one consumed phase entry contributes: its classified phase. */
export interface CompliancePhaseEntry {
	phase: PhaseName;
}

export interface PlanComplianceScores {
	ppc: number;
	poc: number;
	ppf: number;
	pc: number;
	/** Distinct plan phases that appear in the sequence, in canonical order. */
	presentPhases: PlanPhase[];
	/** Canonical phases that never appear, in canonical order. */
	skippedPhases: PlanPhase[];
	totalCanonicalPhases: number;
	/** Transitions between distinct plan phases. */
	transitions: number;
	/** Of those, how many moved backwards through the canonical order. */
	outOfOrderTransitions: number;
	turnCount: number;
	/** Turns classified into any plan phase (i.e., not `other`). */
	canonicalTurnCount: number;
}

function clamp01(x: number): number {
	return Math.min(1, Math.max(0, x));
}

function canonicalIndexOf(phase: PhaseName, order: readonly PlanPhase[]): number {
	const idx = order.indexOf(phase as PlanPhase);
	return idx >= 0 ? idx : -1;
}

export function computePlanCompliance(
	entries: readonly CompliancePhaseEntry[],
	canonicalOrder: readonly PlanPhase[],
): PlanComplianceScores {
	const order = canonicalOrder.length > 0 ? [...canonicalOrder] : [...PLAN_PHASES];

	const presentPhases = order.filter((p) => entries.some((e) => e.phase === p));
	const skippedPhases = order.filter((p) => !presentPhases.includes(p));
	const totalCanonicalPhases = order.length;

	const ppc = totalCanonicalPhases > 0 ? presentPhases.length / totalCanonicalPhases : 0;

	let transitions = 0;
	let outOfOrderTransitions = 0;
	for (let i = 1; i < entries.length; i++) {
		const from = entries[i - 1]!.phase;
		const to = entries[i]!.phase;
		if (from === to || from === "other" || to === "other") continue;
		transitions++;
		const fromIdx = canonicalIndexOf(from, order);
		const toIdx = canonicalIndexOf(to, order);
		if (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) outOfOrderTransitions++;
	}
	const poc = transitions > 0 ? 1 - outOfOrderTransitions / transitions : 1;

	const turnCount = entries.length;
	const canonicalTurnCount = entries.filter((e) => e.phase !== "other").length;
	const ppf = turnCount > 0 ? canonicalTurnCount / turnCount : 0;

	const pc =
		Math.pow(clamp01(ppc) * clamp01(poc) * clamp01(ppf), 1 / 3);

	return {
		ppc,
		poc,
		ppf,
		pc,
		presentPhases,
		skippedPhases,
		totalCanonicalPhases,
		transitions,
		outOfOrderTransitions,
		turnCount,
		canonicalTurnCount,
	};
}

/**
 * The digest line handed to the synthesizer via session-overview:
 *
 *   `plan_compliance: PC=0.67 (PPC=0.75, POC=0.80, PPF=0.89); skipped: validate`
 *
 * One bounded line; the skipped list appears only when phases were skipped.
 */
export function formatComplianceDigestLine(props: {
	pc: number;
	ppc: number;
	poc: number;
	ppf: number;
	skipped_phases: readonly string[];
}): string {
	const scores = `PC=${props.pc.toFixed(2)} (PPC=${props.ppc.toFixed(2)}, POC=${props.poc.toFixed(2)}, PPF=${props.ppf.toFixed(2)})`;
	return props.skipped_phases.length > 0
		? `plan_compliance: ${scores}; skipped: ${props.skipped_phases.join(",")}`
		: `plan_compliance: ${scores}`;
}
