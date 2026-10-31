import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { CHILD_FAILURE_CLASSES, TOOL_FAILURE_CLASSES, TURN_FAILURE_CLASSES, UNCLASSIFIED } from "./classes.js";

/**
 * Failures by class, from the catalogue's fixed list of ids. The analyzer is
 * deterministic, so the figures are objective. A class id outside the catalogue
 * counts as `other`.
 */
const CLASS_IDS = [...new Set([...TURN_FAILURE_CLASSES, ...TOOL_FAILURE_CLASSES, ...CHILD_FAILURE_CLASSES].map((c) => c.id)), UNCLASSIFIED.classId];

export const failureModesFingerprint: FingerprintContributor = {
	def: {
		id: "failures",
		label: "Failures",
		description: "Failed generations and failed tool calls, by axis and by class from the failure catalogue.",
		kind: "objective",
		measures: [
			{ kind: "total", id: "turnFailures", field: "turnFailures" },
			{ kind: "total", id: "toolFailures", field: "toolFailures" },
			{ kind: "groups", id: "byClass", dimensions: { axis: ["turn", "tool", "child"], classId: CLASS_IDS }, countField: "count" },
		],
	},
	async read(ctx) {
		const totals = await ctx.nodes("failure-modes", { turnFailures: "$.turn_failure_count", toolFailures: "$.tool_failure_count" });
		const groups = await ctx.items("failure-modes", "$.groups", { axis: "$.axis", classId: "$.class_id", count: "$.count" });
		return { measured: totals.map((r) => String(r["session"])), rows: [...totals, ...groups] };
	},
};
