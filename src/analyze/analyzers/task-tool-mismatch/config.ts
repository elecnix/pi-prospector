/**
 * Configuration for the task-tool-mismatch analyzer (#158).
 *
 * Every knob is part of the config fingerprint (DESIGN.md: everything the user
 * sets is config, and a different config "is just different") — changing any of
 * these marks prior nodes stale for the `config` reason; a plain fill leaves
 * them alone and `--revise config` recomputes them with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const TaskToolMismatchConfig = Type.Object({
	/**
	 * Available-tool names that can execute a shell command. When an instruction
	 * names a command word that is not itself a session tool (e.g. `git diff`,
	 * `make test`), the mismatch is attributed to whichever of these shell tools
	 * the session actually carried — first match wins, in this order.
	 */
	shellToolNames: Type.Array(Type.String(), { description: "Tools able to run a shell command." }),
	/**
	 * Tools whose heavy use counts as "reconstructing the result by hand" —
	 * the substitute symptom (repeated reads/greps) that is NOT the finding's
	 * target. Calls of these other tools are summed across the session.
	 */
	substituteTools: Type.Array(Type.String()),
	/** Substitute calls at or above this count count as "many" (condition 4). */
	minSubstituteCalls: Type.Integer({ minimum: 1 }),
});

export type TaskToolMismatchConfig = Static<typeof TaskToolMismatchConfig>;

export const DEFAULT_TASK_TOOL_MISMATCH_CONFIG: TaskToolMismatchConfig = {
	shellToolNames: ["bash", "Bash", "shell", "sh", "exec", "run_command"],
	substituteTools: ["read", "grep", "glob", "ls", "cat", "view", "search", "find", "list"],
	// The #1407 sessions made 93/48/46 greps and 65/39/26 reads instead of one
	// git diff; anything in single digits is ordinary work, not reconstruction.
	minSubstituteCalls: 10,
};
