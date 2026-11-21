import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { metricValues } from "../../metrics/values.js";
import { metrics } from "./metrics.js";

const LABELS = metricValues(metrics, "session-ending.ending-label");
const RULES = metricValues(metrics, "session-ending.ending-rule");

/**
 * The first session-ending version that pairs a result carrying a call id with
 * a stored call that has none. 1.0 labelled every session indexed before sync
 * kept the id `abandoned`, whatever it did last.
 */
export const PAIRED_SINCE = "1.1";

/**
 * How a person's sessions end: resolved, abandoned, handed off, errored, or
 * unclear, read from the transcript's tail by fixed rules, so the figures are
 * objective.
 */
export const sessionEndingFingerprint: FingerprintContributor = {
	def: {
		id: "ending",
		label: "Session ending",
		description:
			"How each session ended, and the rule that decided it: a passing verification command or a clean last result (resolved), work cut off or a message left unanswered (abandoned), a short closing message from the person (handed off), a failure as the last event (errored), or not enough evidence (unclear). The closing-message rule matches a short list of English and French words, so a closing message in another language reads as unclear.",
		kind: "objective",
		analyzers: ["session-ending"],
		measures: [
			{ kind: "groups", id: "byLabel", metric: "session-ending.ending-label", dimensions: { label: LABELS } },
			{ kind: "groups", id: "byRule", metric: "session-ending.ending-rule", dimensions: { rule: RULES } },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("session-ending", PAIRED_SINCE);
		const ran = new Set(measured);
		const rows = await ctx.nodes("session-ending", { label: "$.label", rule: "$.evidence.rule" });
		return { measured, rows: rows.filter((r) => ran.has(String(r["session"]))) };
	},
};
