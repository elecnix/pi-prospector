/**
 * Configuration for the phase-trajectory analyzer (issue #115).
 *
 * Everything here is part of the config fingerprint: a change to a threshold,
 * to the canonical plan order, or to any command mapping yields a new config
 * identity and, when a run includes the `config` reason, new node versions.
 *
 * The shape follows LivePlan's Langutory: each turn maps to one problem-solving
 * phase (navigate | reproduce | patch | validate | other), and drift is read
 * from the resulting phase sequence rather than from any single tool call.
 */

import { Type, type Static } from "typebox";

export const PhaseName = Type.Union([
	Type.Literal("navigate"),
	Type.Literal("reproduce"),
	Type.Literal("patch"),
	Type.Literal("validate"),
	Type.Literal("other"),
]);
export type PhaseName = Static<typeof PhaseName>;

/** The phases the canonical plan speaks about; `other` sits outside the plan. */
export const PLAN_PHASES = ["navigate", "reproduce", "patch", "validate"] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

export const PhaseTrajectoryConfigSchema = Type.Object({
	/**
	 * Minimum number of consecutive turns in the same phase before
	 * prolonged-stagnation fires (LivePlan's θp; default 7, derived in the
	 * paper from the average max consecutive phase length of resolved runs).
	 */
	stagnationMin: Type.Integer({ minimum: 2 }),
	/**
	 * The expected progression of work. A session whose plan phases first
	 * appear in an order that deviates from this sequence trips
	 * `phase-order-violation`. Defaults to navigate → reproduce → patch →
	 * validate (the SWE-bench-derived alphabet LivePlan uses).
	 */
	canonicalOrder: Type.Array(
		Type.Union([
			Type.Literal("navigate"),
			Type.Literal("reproduce"),
			Type.Literal("patch"),
			Type.Literal("validate"),
		]),
	),
	/**
	 * Regex sources matched (case-insensitively) against bash commands that run
	 * tests or reproduction scripts. Before any patch such a turn classifies as
	 * `reproduce`; after a patch, the same command classifies as `validate` —
	 * the ordering dependency IS the signal.
	 */
	testCommandPatterns: Type.Array(Type.String()),
	/**
	 * Regex sources for validation-only commands (lint, typecheck, CI status):
	 * after a patch they classify the turn `validate`; before one they are
	 * ordinary read-only navigation.
	 */
	checkCommandPatterns: Type.Array(Type.String()),
	/**
	 * Phase→matcher overrides. Keys are phase names; values are matcher strings.
	 * A matcher matches a call either as a case-insensitive regex against a bash
	 * command or as an exact structured tool name. An override hit forces the
	 * turn's classification toward that phase ahead of every built-in rule, so
	 * corpus-specific tools ("our `make verify` IS validation") can be absorbed
	 * without editing shipped defaults.
	 */
	phaseToolOverrides: Type.Record(Type.String(), Type.Array(Type.String())),
});
export type PhaseTrajectoryConfig = Static<typeof PhaseTrajectoryConfigSchema>;

export const DEFAULT_PHASE_TRAJECTORY_CONFIG: PhaseTrajectoryConfig = {
	// LivePlan's θp = 7: the average maximum consecutive-phase length observed
	// in resolved trajectories. Below it, healthy focused phases fire; above it,
	// real stagnation hides.
	stagnationMin: 7,
	canonicalOrder: [...PLAN_PHASES],
	testCommandPatterns: [
		"(^|[;&|]\\s*)(npm|yarn|pnpm|bun)\\s+(run\\s+)?test\\b",
		"(^|[;&|]\\s*)npx\\s+(jest|vitest|mocha|playwright|wdio)\\b",
		"\\b(pytest|py\\.test)\\b",
		"\\b(jest|vitest|mocha|karma|phpunit|tox)\\b",
		"\\bcargo\\s+test\\b",
		"\\bgo\\s+test\\b",
		"\\bmake\\s+(test|check)\\b",
		"\\b(mvn|gradle)\\b[^;&|]*\\btest\\b",
		"\\brake\\s+test\\b",
		"\\bdotnet\\s+test\\b",
		// Running a reproduction script by path: repro/spec-named script files.
		"(^|[;&|]\\s*)(node|tsx|ts-node|python3?)\\s+[^;&|]*\\b(repro|spec)\\.[a-z]+",
		"\\b(node|tsx|ts-node|python3?)\\s+[^;&|]*\\btest[a-z0-9_-]*\\.(js|ts|mjs|cjs|py)\\b",
	],
	checkCommandPatterns: [
		"^gh\\s+(run\\s+(list|watch|view)|pr\\s+checks)\\b",
		"\\b(eslint|ruff|flake8|mypy|pylint)\\b",
		"^tsc\\b|\\btsc\\b[^;&|]*--noEmit\\b",
		"(^|[;&|]\\s*)(npm|yarn|pnpm|bun)\\s+run\\s+(lint|typecheck|type-check)\\b",
	],
	phaseToolOverrides: {},
};
