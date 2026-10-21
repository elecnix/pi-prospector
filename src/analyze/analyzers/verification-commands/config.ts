/**
 * Configuration for the verification-commands analyzer.
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const VerificationCommandsConfig = Type.Object({
	/** Tool names treated as shell execution. Compared case-insensitively. */
	shellToolNames: Type.Array(Type.String()),
	/**
	 * A command shorter than this is not nominated. A quick command between
	 * edits is the normal edit-test loop, not a gate.
	 */
	minRunSeconds: Type.Number({ minimum: 0 }),
	/**
	 * A command the shipped `verificationPatterns` already matches is not
	 * nominated: the pattern list already covers it, so a model call would pay
	 * for a verdict nobody needs.
	 */
	skipKnownPatterns: Type.Boolean(),
	/**
	 * A decision model (`provider/model`, e.g. `jev/jev-1.13.0`) that judges
	 * each nominated command once for the whole corpus. Absent by default, and
	 * then the analyzer nominates nothing and the pattern list stands alone.
	 */
	decisionModel: Type.Optional(Type.String()),
	/**
	 * Whether the analyzer may send a command line to the decision model.
	 *
	 * Set this to false to keep every command line on the machine. The
	 * analyzer then nominates nothing, so `stale-verification` falls back to
	 * its local pattern list and no command ever leaves.
	 *
	 * The switch is part of the config fingerprint, so turning the remote call
	 * off marks the nodes drawn under it stale for `config`, and turning it
	 * back on revises them.
	 */
	allowRemoteVerdicts: Type.Boolean(),
	/** How many distinct commands one session may nominate. */
	maxCandidatesPerSession: Type.Integer({ minimum: 1 }),
});
export type VerificationCommandsConfig = Static<typeof VerificationCommandsConfig>;

export const DEFAULT_VERIFICATION_COMMANDS_CONFIG: VerificationCommandsConfig = {
	shellToolNames: ["bash"],
	minRunSeconds: 60,
	skipKnownPatterns: true,
	allowRemoteVerdicts: true,
	maxCandidatesPerSession: 20,
};
