import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { metricValues } from "../../metrics/values.js";
import { metrics } from "./metrics.js";

const CHANNELS = metricValues(metrics, "repetition-collapse.collapsed-steps");

/**
 * Assistant steps that looped on repeated text, mostly a property of the
 * models a person routes to. Found by fixed repetition ratios, so the figures
 * are objective and compare across corpora.
 */
export const repetitionCollapseFingerprint: FingerprintContributor = {
	def: {
		id: "repetitionCollapse",
		label: "Repetition collapse",
		description:
			"Assistant steps long enough to judge, the steps whose reasoning or answer looped on a repeated phrase or fragment, by where the loop was, and the looping steps that delivered no answer and no tool call. Found by repetition ratios, which work on any language.",
		kind: "objective",
		analyzers: ["repetition-collapse"],
		measures: [
			{ kind: "total", id: "judgedSteps", metric: "repetition-collapse.collapsed-steps", field: "judged" },
			{ kind: "total", id: "collapsedSteps", metric: "repetition-collapse.collapsed-steps", field: "collapsed" },
			{ kind: "sessions", id: "sessionsWithCollapse", metric: "repetition-collapse.collapsed-steps", field: "collapsed" },
			{ kind: "groups", id: "byChannel", metric: "repetition-collapse.collapsed-steps", dimensions: { channel: CHANNELS } },
			{ kind: "total", id: "undeliveredSteps", metric: "repetition-collapse.undelivered-steps", field: "undelivered" },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("repetition-collapse");
		const rows = await ctx.nodes("repetition-collapse", {
			judged: "$.judged_step_count",
			collapsed: "$.collapsed_step_count",
			undelivered: "$.undelivered_step_count",
		});
		const steps = await ctx.items("repetition-collapse", "$.collapsed", { channel: "$.channel" });
		return { measured, rows: [...rows, ...steps] };
	},
};
