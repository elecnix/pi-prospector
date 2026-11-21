import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * The first friction-accumulation version that counts only the person's own
 * words. Earlier versions scored frustration words in pasted text and in
 * messages another agent wrote, so their sums are not the person's.
 */
export const OWN_WORDS_SINCE = "1.3";

/**
 * Whether friction builds up over a session. The sum is deterministic, but it
 * weighs frustration words whose weights a model judged, so the section is
 * inferred, like the frustration section.
 */
export const frictionAccumulationFingerprint: FingerprintContributor = {
	def: {
		id: "frictionTrend",
		label: "Friction trend",
		description:
			"Friction accumulated over each session's turns (corrections, failed tool results, frustration words the person typed, and looping tool patterns), and the sessions whose friction per turn rose from the first window of turns to the last. Corrections match English wording, so a correction in another language adds nothing.",
		kind: "inferred",
		analyzers: ["friction-accumulation"],
		measures: [
			{ kind: "total", id: "accumulatedFriction", metric: "friction-accumulation.accumulated-friction", field: "accumulated", decimals: 1 },
			{ kind: "sessions", id: "decliningSessions", metric: "friction-accumulation.decline-verdict", field: "declining" },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("friction-accumulation", OWN_WORDS_SINCE);
		const ran = new Set(measured);
		const rows = await ctx.nodes("friction-accumulation", { accumulated: "$.accumulated_friction", declining: "$.decline_verdict.decline_detected" });
		return { measured, rows: rows.filter((r) => ran.has(String(r["session"]))) };
	},
};
