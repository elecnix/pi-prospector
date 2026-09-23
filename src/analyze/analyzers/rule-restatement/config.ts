/** Configuration for the rule-restatement check (issue #265). */

import { Type, type Static } from "typebox";

export const RuleRestatementConfig = Type.Object({
	/**
	 * Which model judges a restatement: a tier name or an explicit
	 * `provider/model` spec. Comparing one proposed rule against a few files of
	 * instructions is a reading task, so the cheap tier is the default.
	 */
	tier: Type.String(),
	/** Sampling temperature. */
	temperature: Type.Number(),
	/**
	 * Proposal target types that are rule-shaped — a proposal to add text to a
	 * standing instruction. Proposals of any other target (config, extension,
	 * workflow, …) are not rules the instruction corpus could already hold.
	 */
	targetTypes: Type.Array(Type.String()),
	/**
	 * Include the harness's global instruction file (`~/.pi/agent/AGENTS.md` for
	 * Pi, `~/.claude/CLAUDE.md` for Claude Code) in every session's corpus.
	 */
	includeHarnessGlobal: Type.Boolean(),
	/**
	 * Discover project instruction files from the session's `cwd` upwards, the way
	 * the session's harness loads them.
	 */
	discoverProjectFiles: Type.Boolean(),
	/**
	 * Further files in scope for every session: a skill's `SKILL.md`, a protocol
	 * an orchestrator injects into every sub-agent brief — text the harness does
	 * not record and a `cwd` cannot reveal. A leading `~` is the home directory.
	 */
	instructionPaths: Type.Array(Type.String()),
	/**
	 * Character budget for the corpus text sent with one proposal. Under budget
	 * the corpus is sent whole; over it, the passages sharing the most terms with
	 * the proposal are kept. That ranking chooses what the model reads — the model
	 * alone decides whether the rule is there.
	 */
	maxCorpusChars: Type.Number(),
});
export type RuleRestatementConfig = Static<typeof RuleRestatementConfig>;

export const DEFAULT_RULE_RESTATEMENT_CONFIG: RuleRestatementConfig = {
	tier: "cheap",
	temperature: 0,
	targetTypes: ["agents_md", "skill", "prompt"],
	includeHarnessGlobal: true,
	discoverProjectFiles: true,
	instructionPaths: [],
	maxCorpusChars: 32_000,
};
