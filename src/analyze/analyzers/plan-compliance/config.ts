/**
 * Configuration for the plan-compliance analyzer (issue #121).
 *
 * Everything here is part of the config fingerprint: a change to the canonical
 * plan order yields a new config identity and, when a run includes the `config`
 * reason, new node versions.
 *
 * The only knob is the canonical order itself — the four metrics are otherwise
 * pure functions of the consumed phase sequence. It defaults to the same
 * navigate → reproduce → patch → validate alphabet phase-trajectory ships, and
 * is declared separately so compliance can evolve (or a corpus can override it)
 * without touching the upstream analyzer's config.
 */

import { Type, type Static } from "typebox";
import { PLAN_PHASES } from "../phase-trajectory/config.js";

export const PlanComplianceConfigSchema = Type.Object({
	/**
	 * The expected progression of work, used to score PPC (fraction present)
	 * and POC (order of transitions). Defaults to navigate → reproduce →
	 * patch → validate; `other` sits outside the plan and never counts as
	 * canonical here regardless of configuration.
	 */
	canonicalOrder: Type.Array(
		Type.Union([
			Type.Literal("navigate"),
			Type.Literal("reproduce"),
			Type.Literal("patch"),
			Type.Literal("validate"),
		]),
	),
});
export type PlanComplianceConfig = Static<typeof PlanComplianceConfigSchema>;

export const DEFAULT_PLAN_COMPLIANCE_CONFIG: PlanComplianceConfig = {
	canonicalOrder: [...PLAN_PHASES],
};
