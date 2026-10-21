/**
 * Configuration for the stale-verification analyzer.
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const StaleVerificationConfig = Type.Object({
	/** Tool names treated as shell execution. Compared case-insensitively. */
	shellToolNames: Type.Array(Type.String()),
	/** Tool names that edit a file. Compared case-insensitively. */
	editToolNames: Type.Array(Type.String()),
	/** Argument names an edit tool puts the edited file's path in, tried in order. */
	editPathArguments: Type.Array(Type.String()),
	/** Tool names that run a subagent or a multi-agent workflow. Compared case-insensitively. */
	subagentToolNames: Type.Array(Type.String()),
	/**
	 * Regex sources for shell commands that verify the working tree: tests,
	 * linters, type checks, builds, and gate scripts. Each is matched
	 * case-insensitively at the start of every command in the shell line (split
	 * on `&&`, `||`, `;`, `|`, and newlines), after heredoc bodies and launcher
	 * prefixes such as `npx`, `timeout N`, and `python -m` are removed. Add your
	 * project's own gate scripts here.
	 */
	verificationPatterns: Type.Array(Type.String()),
	/**
	 * Regex sources for failure lines in a verification run's output, matched
	 * case-sensitively and per line (`^` and `$` match at line breaks). A run
	 * whose output matches failed, whatever its exit code: `cmd | tail` exits
	 * with `tail`'s status and hides the failure.
	 */
	failureResultPatterns: Type.Array(Type.String()),
	/**
	 * Regex sources recognising a result that says the harness stopped waiting
	 * for the call (its tool timeout). Matched case-insensitively against the
	 * result text; anchor them at the start, because the harness writes its own
	 * message first. Such a run did not finish in the call, so it never passed.
	 */
	timeoutResultPatterns: Type.Array(Type.String()),
	/** Regex sources for shell commands that commit, matched like `verificationPatterns` and checked before them. */
	commitPatterns: Type.Array(Type.String()),
	/** Regex sources for shell commands that edit files in place, matched anywhere in the command. */
	shellEditPatterns: Type.Array(Type.String()),
	/**
	 * Regex sources for paths outside the work: temp and scratch files. An edit
	 * whose path matches, or an in-place shell edit whose command mentions one,
	 * does not make a verification run stale.
	 */
	ignoredPathPatterns: Type.Array(Type.String()),
	/**
	 * Regex sources for user-role text the harness injected (task notices,
	 * reminders) rather than a person typed. Such text is not a human prompt.
	 */
	injectedPromptPatterns: Type.Array(Type.String()),
	/**
	 * A passing run shorter than this is not counted. A quick test run between
	 * edits is the normal edit-test loop, not waste.
	 */
	minRunSeconds: Type.Number({ minimum: 0 }),
	/** Stale seconds from one cause (agent or subagent) at which the analyzer proposes a change. */
	proposalMinSeconds: Type.Number({ minimum: 0 }),
	/** Commits that took an edit made after the last passing run, at which the analyzer warns. */
	unverifiedCommitProposalMin: Type.Integer({ minimum: 1 }),
	/** How many message ids a proposal keeps as evidence. */
	evidenceCap: Type.Integer({ minimum: 1 }),
});
export type StaleVerificationConfig = Static<typeof StaleVerificationConfig>;

export const DEFAULT_STALE_VERIFICATION_CONFIG: StaleVerificationConfig = {
	shellToolNames: ["bash"],
	editToolNames: ["edit", "write", "multiedit", "notebookedit"],
	editPathArguments: ["file_path", "path", "notebook_path"],
	subagentToolNames: ["agent", "task", "workflow", "subagent"],
	verificationPatterns: [
		"(npm|pnpm|yarn|bun)\\s+(run\\s+)?(test|lint|check|typecheck|build)\\b",
		"go\\s+(test|vet|build)\\b",
		"golangci-lint\\s+run\\b",
		"cargo\\s+(test|clippy|check|build|nextest)\\b",
		"(pytest|mypy|ruff\\s+check|eslint|tsc|vitest|jest|shellcheck)\\b",
		"playwright\\s+test\\b",
		"make\\s+(test|check|lint|ci)[\\w-]*\\b",
		"(\\S*/)?(gradlew|gradle|mvn)\\b.*\\b(test|check|verify)\\b",
		"dotnet\\s+test\\b",
		"(\\S*/)?[\\w-]*(gates?|lint|checks?|tests?)\\.sh\\b",
	],
	failureResultPatterns: [
		"(^|\\s)(FAIL|FAILED)\\b",
		"\\b[1-9]\\d* (failed|failing)\\b",
		"\\berror TS\\d+",
		"^panic: ",
		"^Traceback \\(most recent call last\\)",
		"^npm ERR!",
		"\\bexit (code|status) [1-9]",
	],
	timeoutResultPatterns: ["^command did not complete within its \\d+s timeout", "^command timed out\\b"],
	commitPatterns: ["git\\s+(-C\\s+\\S+\\s+)?commit\\b(?!.*--dry-run)"],
	shellEditPatterns: ["\\bsed\\s+(-[a-zA-Z]+\\s+)*-i", "\\bperl\\s+-[a-zA-Z]*i", "\\bapply_patch\\b"],
	ignoredPathPatterns: ["(^|[\\s'\"=])(/private)?/tmp/", "(^|[\\s'\"=])/var/folders/", "/scratchpad/", "/\\.claude/", "/\\.pi/"],
	injectedPromptPatterns: ["^\\s*<"],
	minRunSeconds: 60,
	proposalMinSeconds: 300,
	unverifiedCommitProposalMin: 2,
	evidenceCap: 10,
};
