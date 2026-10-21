/**
 * The measures that need to see more than one call: the exit code a pipe hid,
 * the spans between commits, and the spans a skill occupies (issue #306).
 *
 * Each of these reads the same ordered action stream the timing pass reads,
 * but asks a different question of it:
 *
 *   - **hidden exit code** — a call the harness reported as successful whose
 *     output says otherwise. `cmd 2>&1 | tail -40` returns `tail`'s status, so
 *     a failing command behind a pipe reads as a pass. The call's own result
 *     says "not an error"; only its output says "it failed".
 *   - **phase span** — how long the work took between two markers: the start
 *     to the first commit, and each commit's own preparation.
 *   - **skill span** — how long a skill occupied the agent.
 *
 * All three are pure functions over the transcript. None calls a model.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import { buildToolStream, singleResult, type ToolInvocation } from "../../tool-stream.js";
import { parseTime } from "../stale-verification/command-vocabulary.js";

// ─────────────────────────── shared helpers ───────────────────────────

/** Round to a tenth of a second, so node content stays stable and readable. */
export function roundSeconds(seconds: number): number {
	return Math.round(seconds * 10) / 10;
}

// ─────────────────────────── hidden exit codes ───────────────────────────

export const HiddenExitCodeSchema = Type.Object({
	/** The message that issued the call. */
	message_id: Type.String(),
	/** The command family the call belongs to. */
	family: Type.String(),
	/** How long the call took, in seconds. */
	seconds: Type.Number(),
	/** The failure markers found in the output. */
	markers: Type.Array(Type.String()),
});
export type HiddenExitCode = Static<typeof HiddenExitCodeSchema>;

/** A compiled marker, kept with the source it came from so a finding can name it. */
interface CompiledMarker {
	source: string;
	re: RegExp;
}

const markerCache = new Map<string, CompiledMarker>();

/**
 * Compile one marker pattern. An invalid pattern is a configuration fault, so
 * the error names the config entry rather than surfacing a bare SyntaxError.
 */
function compileMarker(source: string): CompiledMarker {
	let entry = markerCache.get(source);
	if (!entry) {
		try {
			// The `m` flag makes `^` mean "the start of a line" rather than
			// "the start of the output", which is what every line-anchored
			// marker below intends: a runner prints its failure line at the
			// start of a line, in the middle of a long output.
			entry = { source, re: new RegExp(source, "m") };
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			throw new Error(`time-economy config: failureMarkers[${source}] is not a valid regular expression: ${why}`);
		}
		markerCache.set(source, entry);
	}
	return entry;
}

/**
 * The failure markers present in a successful call's output.
 *
 * Only a call the harness reported as *successful* is examined: a call it
 * already flagged as an error is counted by the failure analysis, and
 * reporting it twice would double the same defect.
 *
 * Several patterns can match one line — `--- FAIL:` also satisfies `\bFAIL\b`
 * — and two markers naming the same failure are noise, so a marker whose
 * matched text is contained in an already-accepted marker's is dropped. The
 * catalogue's order decides which one survives, so the result is stable.
 */
export function findFailureMarkers(output: string, markers: readonly string[]): string[] {
	const found: Array<{ source: string; text: string }> = [];
	for (const source of markers) {
		const { re } = compileMarker(source);
		const match = re.exec(output);
		if (!match) continue;
		const text = match[0];
		// Two markers naming the same failure are noise, so a marker whose match
		// overlaps one already accepted is dropped. The check is symmetric, so
		// the result does not depend on the catalogue's order: whichever marker
		// matched the wider text is the one that survives, and it survives
		// whichever way round the two were tried.
		const overlapping = found.find((f) => f.text.includes(text) || text.includes(f.text));
		if (overlapping) {
			// The accepted marker matched the wider text; keep it and drop this
			// one, which names the same failure more narrowly.
			if (overlapping.text.includes(text)) continue;
			// This one matched the wider text, so it replaces the narrower one.
			found.splice(found.indexOf(overlapping), 1);
		}
		found.push({ source, text });
	}
	return found.map((f) => f.source);
}

// ─────────────────────────── phase spans ───────────────────────────

export const PhaseSpanSchema = Type.Object({
	/**
	 * What the span measures: `start_to_first_commit` or `commit_preparation`.
	 */
	kind: Type.Union([Type.Literal("start_to_first_commit"), Type.Literal("commit_preparation")]),
	/** The message the span starts at. */
	start_message_id: Type.String(),
	/** The message the span ends at, when it ended at a message. */
	end_message_id: Type.Union([Type.String(), Type.Null()]),
	/** How long the span took, in seconds. */
	seconds: Type.Number(),
	/** How many turns the span covered. */
	turns: Type.Number(),
	/** The tokens spent in the span, when the transcript recorded them. */
	tokens: Type.Union([Type.Number(), Type.Null()]),
	/**
	 * What marked the span's end. A commit ends a commit-preparation span; a
	 * session's end ends a start-to-first-commit span that never reached one.
	 */
	end_reason: Type.Union([Type.Literal("commit"), Type.Literal("session_end")]),
	/** The commit's message, when the span ended at one. */
	commit_subject: Type.Union([Type.String(), Type.Null()]),
});
export type PhaseSpan = Static<typeof PhaseSpanSchema>;

/**
 * The shell commands a script body can hide behind.
 *
 * A heredoc body is text the agent wrote, and a quoted string is an argument
 * the agent passed. A commit named inside either is not a commit.
 */
const HEREDOC_BODY = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1\b/g;
const QUOTED_STRING = /"[^"\n]*"|'[^'\n]*'/g;

/**
 * A command with its heredoc bodies and quoted strings removed.
 *
 * What is left is the part the shell actually executes, so a pattern that
 * matches it matches a command rather than a mention of one.
 */
export function stripCommandText(command: string): string {
	return command.replace(HEREDOC_BODY, "<<HEREDOC").replace(QUOTED_STRING, " ");
}

/**
 * git's global options that take their value in the next word.
 *
 * The value is a path or a setting, never a subcommand, so it is skipped
 * along with the option.
 */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
]);

/**
 * The segments a shell command runs, one per command.
 *
 * A shell runs the parts of a command separated by `&&`, `||`, `;`, `|` and
 * newlines in turn, and each part is a command of its own. `git add -A && git
 * commit` is two commands: one stages and one commits.
 */
const COMMAND_SEPARATOR = /\|\||&&|[;\n|]/;

function commandSegments(command: string): string[] {
	return command
		.split(COMMAND_SEPARATOR)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * The subcommand a command runs, when the command is a git one.
 *
 * git takes global options before the subcommand: `git -C <dir> commit`,
 * `git --git-dir=<dir> commit`, `git -c key=value commit`. An agent commits in
 * a worktree that way, so a pattern that only matched a bare `git commit`
 * would miss it.
 *
 * The options git itself takes are skipped, and the ones that carry a value
 * take the next word with them. Everything after the subcommand belongs to
 * the subcommand and is left alone, so `git log --grep commit` reads a log
 * rather than committing.
 */
export function gitSubcommand(command: string): string | null {
	const match = /\bgit\b/.exec(command);
	if (!match) return null;
	const tokens = command
		.slice(match.index + match[0].length)
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("-")) return token;
		// An option that carries its value: `--git-dir=/repo/.git`.
		if (token.includes("=")) continue;
		// An option that takes the next word as its value.
		if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
			i++;
			continue;
		}
		// A short option with an attached value: `-C/repo`.
		if (/^-[a-zA-Z]./.test(token)) continue;
		// A flag: `--no-pager`. It takes no value and is not a subcommand.
	}
	return null;
}

/**
 * The git subcommands a command runs, one per segment of it.
 *
 * A command that runs several commands has one subcommand per segment, and
 * each is reported: `git add -A && git commit` stages and commits.
 */
function gitSubcommands(command: string): string[] {
	return commandSegments(command)
		.map((segment) => gitSubcommand(segment))
		.filter((sub): sub is string => sub !== null);
}

/**
 * Whether a command commits.
 *
 * `git commit` *is* the boundary the phase span measures to; `git commit
 * --amend` is too. A command that merely mentions commits (`git log`, `git
 * show`) is not a boundary.
 *
 * The command is read as a command, not as text: a heredoc body is a script
 * the agent wrote, and a quoted string is an argument. Neither commits
 * anything, and a phase span that ended at one would report a commit the
 * repository never received.
 */
export function isCommitCommand(command: string): boolean {
	return gitSubcommands(stripCommandText(command)).includes("commit");
}

/** The subject a commit command carries, when it names one. */
export function commitSubjectOf(command: string): string | null {
	// `git commit -m "subject"` or `git commit -m 'subject'`. The subject is
	// read from the command, never from a repository the analyzer cannot see.
	// The quote is matched as a pair, so a subject that contains the other
	// kind of quote is not truncated at it.
	const match = /(?:^|\s)-m\s+(["'])([\s\S]*?)\1/.exec(command);
	if (match?.[2]) return match[2];
	const bare = /(?:^|\s)-m\s+(\S+)/.exec(command);
	return bare?.[1] ?? null;
}

/**
 * A shell command that marks the *start* of a commit's preparation.
 *
 * The issue names four: a full test run, `git add`, a review, and a PR skill.
 * Each is a moment the agent began assembling the commit, so the span from it
 * to the commit is the time the commit cost.
 */
const PREPARATION_COMMAND_PATTERNS: readonly { source: string; re: RegExp }[] = [
	// A full test run: the project's own test command.
	{ source: "test run", re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/ },
	{ source: "test run", re: /\bpytest\b|\bunittest\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+test\b|\bgradle\s+test\b/ },
	// A review: the agent asked someone to look at the work.
	{ source: "review", re: /\bgh\s+pr\s+(review|view|diff)\b/ },
	{ source: "review", re: /\bcode-?review\b|\breview\b.*--diff/ },
	// A PR skill is the fourth marker the issue names, and it is a tool call
	// rather than a shell command, so it is not matched here. The analyzer
	// passes the skill's name in separately — see `isPreparationSkill` in the
	// phase-span options. A shell pattern for it would match any command
	// that merely mentioned the word.
];

/** The preparation markers that are a test run, and so can fail. */
const TEST_RUN_PATTERNS: readonly RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
	/\bpytest\b|\bunittest\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+test\b|\bgradle\s+test\b/,
];

/**
 * Whether a preparation command prepared nothing, because it failed.
 *
 * A test run that failed left the agent with work to do, so it did not
 * prepare the commit: the issue names "the first full test run" as the
 * marker, and the measure beside it counts *passing* runs. Staging, a review
 * and a skill either happened or did not, so none of them can fail this way.
 *
 * The failure is read from two places, because a test run can fail two ways.
 * The host's own verdict catches the run it reported as an error. A run whose
 * failure a pipe hid is reported as a *success* by the host, so its output is
 * the only evidence — the same evidence the hidden-exit-code measure uses.
 * `outputMarkers` carries that evidence: the failure markers found in the
 * run's output, empty when there were none.
 */
export function isFailedPreparation(command: string, isError: boolean, outputMarkers: readonly string[] = []): boolean {
	if (!TEST_RUN_PATTERNS.some((re) => re.test(command))) return false;
	if (isError) return true;
	return outputMarkers.length > 0;
}

/**
 * Whether a command marks the start of a commit's preparation.
 *
 * The issue names four markers: a full test run, `git add`, a review, and a
 * PR skill. The first three are shell commands and are matched here. The
 * fourth is a tool call, so the analyzer passes the skill's name in
 * separately — see `isPreparationSkill` in the phase-span options.
 */
export function isPreparationCommand(command: string): boolean {
	const stripped = stripCommandText(command);
	// Staging: the agent is assembling the commit. The subcommand may sit
	// behind git's global options, so it is read the way git reads it.
	if (gitSubcommands(stripped).includes("add")) return true;
	return PREPARATION_COMMAND_PATTERNS.some((p) => p.re.test(stripped));
}

// ─────────────────────────── skill spans ───────────────────────────

export const SkillSpanSchema = Type.Object({
	/** The message that issued the Skill call. */
	message_id: Type.String(),
	/** The skill's name, as the host recorded it. */
	skill: Type.String(),
	/** How long the span took, in seconds. */
	seconds: Type.Number(),
	/** How many turns the span covered. */
	turns: Type.Number(),
	/** The tokens spent in the span, when the transcript recorded them. */
	tokens: Type.Union([Type.Number(), Type.Null()]),
	/** What ended the span. */
	end_reason: Type.Union([
		Type.Literal("next_skill"),
		Type.Literal("turn_end"),
		Type.Literal("pr_created"),
		Type.Literal("session_end"),
	]),
});
export type SkillSpan = Static<typeof SkillSpanSchema>;

/** The tool name a skill invocation uses. */
export const SKILL_TOOL = "Skill";

/**
 * The skill a call invoked, or null when the call is not a skill invocation.
 *
 * Claude Code names the skill in `skill`; other harnesses may use `name`.
 */
export function skillNameOf(args: Record<string, unknown>): string | null {
	for (const key of ["skill", "name"]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/**
 * Whether a command is the successful creation of a pull request.
 *
 * A PR skill ends at its `gh pr create`, so the span's end has to be found by
 * the command itself. Only a *successful* creation ends the span: a failed
 * `gh pr create` is a retry, not the end of the skill's work.
 */
const PR_CREATE = /\bgh\s+pr\s+create\b/;

/** Whether a shell command is a `gh pr create`. */
export function isPrCreateCommand(command: string): boolean {
	return PR_CREATE.test(command);
}

/**
 * Whether a skill is one that opens a pull request.
 *
 * Only such a skill ends at its `gh pr create`. A review skill, a lint skill
 * or any other skill must end at the next skill or at the end of its turn: a
 * pull request created later, by other work, is not that skill's end, and
 * stretching the span across the gap would report a duration the skill never
 * occupied.
 */
export function isPullRequestSkill(skill: string): boolean {
	const name = skill.toLowerCase();
	return name === "pr" || name === "pull-request" || name === "pull_request" || name === "prs" || name === "open-pr";
}
