import { newestPerSession, type FingerprintContributor, type FingerprintRow } from "../../../fingerprint/contributor.js";

/** The trajectory patterns tool-trajectory detects: its closed set. */
const PATTERNS = ["stuck-loop", "polling-loop", "oscillation", "pre-flight-gap", "thought-oscillation", "no-effect-edit"];

/**
 * The first version that runs all six detectors (7.0 added no-effect-edit). An
 * older run could not find every pattern, so its zeros would be false.
 */
export const ALL_DETECTORS_SINCE = "7.0";

/**
 * Wasteful shapes in the order of a session's tool calls: loops, reversals,
 * failed preconditions, edits that changed nothing. Detected by deterministic
 * rules over the calls, so objective. Tool names and arguments stay out.
 */
export const toolTrajectoryFingerprint: FingerprintContributor = {
	def: {
		id: "toolTrajectory",
		label: "Tool trajectory",
		description: "Trajectory signals by pattern (stuck loops, polling loops, oscillations, pre-flight gaps, repeated reasoning, edits with no effect), and the tool calls they were found in.",
		kind: "objective",
		analyzers: ["tool-trajectory"],
		measures: [
			{ kind: "total", id: "toolCalls", metric: "tool-trajectory.trajectory-signal", field: "calls" },
			{ kind: "total", id: "signals", metric: "tool-trajectory.trajectory-signal", field: "signals" },
			{ kind: "sessions", id: "sessionsWithSignal", metric: "tool-trajectory.trajectory-signal", field: "signals" },
			{ kind: "groups", id: "signalsByPattern", metric: "tool-trajectory.trajectory-signal", dimensions: { pattern: PATTERNS }, countField: "count" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("tool-trajectory", ALL_DETECTORS_SINCE));
		const counts = Object.fromEntries(PATTERNS.map((p) => [p, `$.pattern_counts."${p}"`]));
		const nodes = newestPerSession(await ctx.nodes("tool-trajectory", { calls: "$.tool_call_count", ...counts }), "calls").filter((r) => measured.has(String(r["session"])));
		const rows: FingerprintRow[] = [];
		for (const node of nodes) {
			const session = node["session"]!;
			let signals = 0;
			for (const p of PATTERNS) {
				const count = node[p];
				if (typeof count !== "number") continue;
				signals += count;
				rows.push({ session, pattern: p, count });
			}
			rows.push({ session, calls: node["calls"]!, signals });
		}
		return { measured: nodes.map((r) => String(r["session"])), rows };
	},
};
