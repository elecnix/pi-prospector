import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { FRICTION_POINT_SEVERITIES, POSITIVE_SIGNALS } from "./prompt-reduce.js";

/**
 * What a model found when it reviewed a whole session: the friction points it
 * enumerated, by severity, and the positive signals it tagged from a closed
 * list. Inferred. The summary, the friction descriptions, the evidence and the
 * proposals are free text and stay out; only the severity and the signal are
 * read.
 */
export const sessionOverviewFingerprint: FingerprintContributor = {
	def: {
		id: "sessionReview",
		label: "Session review",
		description:
			"The friction points a model enumerated when it reviewed each session, by severity, the sessions with any, and the positive signals it tagged (task completed without correction, clean recovery after a correction, few failed tool calls). The model reads a digest of the session in any language.",
		kind: "inferred",
		analyzers: ["session-overview"],
		measures: [
			{ kind: "total", id: "frictionPoints", metric: "session-overview.friction-point", field: "friction" },
			{ kind: "sessions", id: "sessionsWithFriction", metric: "session-overview.friction-point", field: "friction" },
			{ kind: "groups", id: "frictionBySeverity", metric: "session-overview.friction-point", dimensions: { severity: [...FRICTION_POINT_SEVERITIES] } },
			{ kind: "groups", id: "positiveSignals", metric: "session-overview.positive-signal", dimensions: { signal: [...POSITIVE_SIGNALS] } },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("session-overview"));
		const ours = (r: { session?: unknown }) => measured.has(String(r.session));
		const points = await ctx.items("session-overview", "$.friction_points", { severity: "$.severity" });
		const signals = await ctx.items("session-overview", "$.key_positive_signals", { signal: "$.signal" });
		return {
			measured: [...measured],
			rows: [...points.filter(ours).map((r) => ({ ...r, friction: 1 })), ...signals.filter(ours)],
		};
	},
};
