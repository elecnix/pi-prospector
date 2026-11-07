/**
 * Configuration for the skill-use analyzer.
 *
 * Every knob is part of the config fingerprint, like every other analyzer's
 * config: changing one marks prior nodes stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const SkillUseConfig = Type.Object({
	/**
	 * Tool names that invoke a skill by name. The skill's name is the call's
	 * `skill` argument (Claude Code's `Skill` tool). Compared case-insensitively.
	 */
	skillToolNames: Type.Array(Type.String()),
	/**
	 * Tool names that read a file. A read of a path shaped `…/skills/<name>/SKILL.md`
	 * is how a harness without a skill tool (Pi) loads a skill, so it counts as
	 * one use of `<name>`. Compared case-insensitively.
	 */
	readToolNames: Type.Array(Type.String()),
	/** Character cap on a stored skill name. Names are provenance, and the graph is durable. */
	maxNameChars: Type.Integer({ minimum: 1 }),
});
export type SkillUseConfig = Static<typeof SkillUseConfig>;

export const DEFAULT_SKILL_USE_CONFIG: SkillUseConfig = {
	skillToolNames: ["Skill"],
	readToolNames: ["read"],
	maxNameChars: 120,
};
