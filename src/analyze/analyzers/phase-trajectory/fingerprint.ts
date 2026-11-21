import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { metricValues } from "../../metrics/values.js";
import { metrics } from "./metrics.js";

const PHASES = metricValues(metrics, "phase-trajectory.turn-phase");
const SIGNALS = metricValues(metrics, "phase-trajectory.phase-signal");

/**
 * How the agent's turns move through navigate, reproduce, patch and validate,
 * and the drift found in that order. The phases come from tool names and
 * commands by fixed rules, so the figures are objective.
 */
export const phaseTrajectoryFingerprint: FingerprintContributor = {
	def: {
		id: "phases",
		label: "Problem-solving phases",
		description:
			"Turns by problem-solving phase (navigate, reproduce, patch, validate, other), the sessions that reached a patch, and the phase-order signals, such as a patch before any reading or no validation after the last patch. Read from tool names and commands, not from language.",
		kind: "objective",
		analyzers: ["phase-trajectory"],
		measures: [
			{ kind: "groups", id: "turnsByPhase", metric: "phase-trajectory.turn-phase", dimensions: { phase: PHASES } },
			{ kind: "sessions", id: "patchedSessions", metric: "phase-trajectory.turn-phase", field: "patched" },
			{ kind: "groups", id: "signals", metric: "phase-trajectory.phase-signal", dimensions: { signal: SIGNALS } },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("phase-trajectory");
		const rows = await ctx.nodes("phase-trajectory", { patched: "$.patched" });
		const phases = await ctx.items("phase-trajectory", "$.phases", { phase: "$.phase" });
		const signals = await ctx.items("phase-trajectory", "$.signals", { signal: "$.signal" });
		return { measured, rows: [...rows, ...phases, ...signals] };
	},
};
