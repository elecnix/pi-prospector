/**
 * Deterministic detection of verification runs that a later edit made stale.
 *
 * A verification run is a shell call that tests, lints, type-checks, builds,
 * or runs a gate script. Once it passes, its result describes the working tree
 * as it was. An edit to a work file after that, before any commit, means the
 * result no longer describes the tree that gets committed. The run was paid
 * for and then thrown away: either the agent ran it again, or the commit took
 * changes that nothing verified.
 *
 * For each passing run that a later edit made stale, the scan records:
 *
 *   - **cause** — what came between the run and the edit: a human prompt
 *     (`user`), a subagent such as a reviewer (`subagent`), or neither
 *     (`agent`, the agent's own decision);
 *   - **outcome** — what came after the edit: another verification run
 *     (`rerun`), a commit with no run in between (`committed_unverified`), or
 *     neither before the session ended (`unverified_at_end`).
 *
 * An edit outside the directory a run changed into (`cd /repo/admin && …`)
 * does not make that run stale, so work in a second checkout or a sibling
 * package is not charged to the first one. A run with no `cd` to an absolute
 * or home-relative path, and an edit with a relative path, are always
 * compared, because their location is unknown.
 *
 * A run that the harness timed out did not finish in its call, so it is
 * counted apart and never passes.
 *
 * A run fails when its result is an error or when its output matches a
 * failure pattern. The second test catches `cmd | tail`, which exits with
 * `tail`'s status. The scan counts such runs as zero-exit failures: a metric
 * only, because the agent saw the failure text, and a red test run on purpose
 * looks the same.
 *
 * A failing run is never stale: editing after a failure is the fix loop. A
 * passing run shorter than `minRunSeconds` is not counted either, because a
 * quick test between edits is the normal edit-test loop. A run without a
 * result or timestamps is counted as untimed, never as zero seconds.
 *
 * A run the harness started in the background returns at once, so it times as
 * near-instant and falls under `minRunSeconds`. This version does not see it.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import type { StaleVerificationConfig } from "./config.js";
import { commandSegments, normaliseCommand, normalisePath, workDir } from "./command-vocabulary.js";

export const STALE_CAUSES = ["agent", "user", "subagent"] as const;
export type StaleCause = (typeof STALE_CAUSES)[number];

export const StaleRunSchema = Type.Object({
	/** The message that issued the verification run. */
	message_id: Type.String(),
	seconds: Type.Number(),
	/** The command in the shell line that matched a verification pattern, truncated. */
	command: Type.String(),
	cause: Type.Union([Type.Literal("agent"), Type.Literal("user"), Type.Literal("subagent")]),
	/** The message that issued the first edit after the run. */
	edit_message_id: Type.String(),
	/** The edited path, or the in-place shell command that edited, truncated. */
	edit_target: Type.String(),
	outcome: Type.Union([Type.Literal("rerun"), Type.Literal("committed_unverified"), Type.Literal("unverified_at_end")]),
});
export type StaleRun = Static<typeof StaleRunSchema>;

export const StaleScanSchema = Type.Object({
	/** Verification runs that passed and lasted at least `minRunSeconds`. */
	passing_run_count: Type.Number(),
	passing_run_seconds: Type.Number(),
	/** Verification runs with no result or no usable timestamps. */
	untimed_run_count: Type.Number(),
	stale_runs: Type.Array(StaleRunSchema),
	stale_seconds: Type.Number(),
	stale_seconds_by_cause: Type.Object({ agent: Type.Number(), user: Type.Number(), subagent: Type.Number() }),
	/** Verification runs whose result says the harness timed them out. */
	timed_out_run_count: Type.Number(),
	/** Verification runs that exited 0 but printed a failure. */
	zero_exit_failures: Type.Object({ count: Type.Number(), message_ids: Type.Array(Type.String()) }),
	/** Commits that took an edit made after the last passing run, with no run in between. */
	unverified_commit_count: Type.Number(),
});
export type StaleScan = Static<typeof StaleScanSchema>;

export type CallKind =
	| { kind: "commit" | "subagent" | "other" }
	| { kind: "verification"; command: string; dir: string | null }
	| { kind: "edit"; target: string; dir?: string | null };

const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1\b/g;
const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;

/** Whether an edit at `editPath` can change what a run in `runDir` checked. Unknown locations always can. */
function editReaches(runDir: string | null, editPath: string | null): boolean {
	if (runDir === null || editPath === null) return true;
	const dir = normalisePath(runDir);
	const path = normalisePath(editPath);
	return path === dir || path.startsWith(`${dir}/`);
}

const compiled = new Map<string, RegExp>();

/**
 * Compile the config patterns under `key` once. An invalid pattern is a
 * configuration fault, so the error names the config entry rather than
 * surfacing a bare SyntaxError.
 */
function configRegExps(key: string, patterns: readonly string[], anchored: boolean, flags = "i"): RegExp[] {
	return patterns.map((source, index) => {
		const full = anchored ? `^(?:${source})` : source;
		let re = compiled.get(`${flags}/${full}`);
		if (!re) {
			try {
				re = new RegExp(full, flags);
			} catch (err) {
				const why = err instanceof Error ? err.message : String(err);
				throw new Error(`stale-verification config: ${key}[${index}] is not a valid regular expression: ${why}`);
			}
			compiled.set(`${flags}/${full}`, re);
		}
		return re;
	});
}

/** Classify one tool call by what it does to the working tree. */
export function classifyCall(
	name: string,
	args: Record<string, unknown>,
	config: StaleVerificationConfig,
	learned: ReadonlySet<string> = new Set(),
): CallKind {
	const tool = name.toLowerCase();
	const ignored = configRegExps("ignoredPathPatterns", config.ignoredPathPatterns, false);

	if (config.editToolNames.some((n) => n.toLowerCase() === tool)) {
		const path = config.editPathArguments.map((a) => args[a]).find((v): v is string => typeof v === "string" && v !== "");
		if (path === undefined || ignored.some((re) => re.test(path))) return { kind: "other" };
		return { kind: "edit", target: path };
	}
	if (config.subagentToolNames.some((n) => n.toLowerCase() === tool)) return { kind: "subagent" };
	if (!config.shellToolNames.some((n) => n.toLowerCase() === tool)) return { kind: "other" };

	const command = typeof args["command"] === "string" ? (args["command"] as string) : "";
	const segments = commandSegments(command);
	const commits = configRegExps("commitPatterns", config.commitPatterns, true);
	if (segments.some((s) => commits.some((re) => re.test(s)))) return { kind: "commit" };
	const verifications = configRegExps("verificationPatterns", config.verificationPatterns, true);
	const matched = segments.find((s) => verifications.some((re) => re.test(s)));
	if (matched !== undefined) return { kind: "verification", command: firstLine(matched), dir: workDir(command) };
	// A command the corpus judged to verify the tree, which the pattern list does
	// not cover. The judgement is on the whole command line, so it matches the
	// line rather than one of its segments.
	if (learned.has(normaliseCommand(command))) {
		return { kind: "verification", command: firstLine(command), dir: workDir(command) };
	}
	const run = command.replace(HEREDOC, "<<HEREDOC");
	const shellEdits = configRegExps("shellEditPatterns", config.shellEditPatterns, false);
	const editing = run.split(SEGMENT_SPLIT).find((s) => shellEdits.some((re) => re.test(s)));
	if (editing !== undefined && !ignored.some((re) => re.test(run))) {
		return { kind: "edit", target: firstLine(editing.trim()), dir: workDir(command) };
	}
	return { kind: "other" };
}

function firstLine(text: string, max = 160): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parseTime(ts: string | null): number | null {
	if (!ts) return null;
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? null : ms;
}

/** Round to a tenth of a second, so node content stays stable and readable. */
function r(seconds: number): number {
	return Math.round(seconds * 10) / 10;
}

type Event =
	| { at: number; kind: "prompt" }
	| { at: number; kind: "verification"; messageId: string; seconds: number; command: string; dir: string | null }
	| { at: number; kind: "edit"; messageId: string; target: string; location: string | null }
	| { at: number; kind: "commit" | "subagent" };

/**
 * Find the passing verification runs that a later edit made stale.
 *
 * `learned` holds the command lines the corpus judged to verify the working
 * tree, which the shipped pattern list does not cover. A command in that set
 * counts as a verification run like any other.
 */
export function findStaleVerifications(
	messages: readonly MessageRow[],
	config: StaleVerificationConfig,
	learned: ReadonlySet<string> = new Set(),
): StaleScan {
	const timeById = new Map<string, number | null>();
	// A result row's text belongs to its call only when the row carries one
	// result; the transcript joins several results' texts into one field.
	const textById = new Map<string, string>();
	for (const m of messages) {
		timeById.set(m.id, parseTime(m.timestamp));
		if (m.role === "toolResult" && m.content_text && singleResult(m.tool_results)) textById.set(m.id, m.content_text);
	}
	const failures = configRegExps("failureResultPatterns", config.failureResultPatterns, false, "m");
	const timeouts = configRegExps("timeoutResultPatterns", config.timeoutResultPatterns, false);
	const zeroExit: string[] = [];
	let timedOut = 0;
	const injected = configRegExps("injectedPromptPatterns", config.injectedPromptPatterns, false);

	// One ordered event list. A call sorts by its result's time, because that
	// is when its effect exists; a human prompt sorts by its own time.
	const events: Event[] = [];
	for (const m of messages) {
		const t = timeById.get(m.id) ?? null;
		if (m.role === "user" && t !== null && m.content_text && m.content_text.trim() !== "") {
			if (!injected.some((re) => re.test(m.content_text!))) events.push({ at: t, kind: "prompt" });
		}
	}
	let untimed = 0;
	for (const inv of buildToolStream([...messages]).invocations) {
		const c = classifyCall(inv.name, inv.args, config, learned);
		if (c.kind === "other") continue;
		const start = timeById.get(inv.messageId) ?? null;
		const end = inv.outcome ? (timeById.get(inv.outcome.messageId) ?? null) : null;
		if (start === null || end === null || end < start) {
			if (c.kind === "verification") untimed++;
			continue;
		}
		if (inv.outcome?.isError && c.kind !== "subagent") continue;
		if (c.kind === "verification") {
			const text = inv.outcome ? (textById.get(inv.outcome.messageId) ?? "") : "";
			if (timeouts.some((re) => re.test(text))) {
				timedOut++;
				continue;
			}
			if (failures.some((re) => re.test(text))) {
				zeroExit.push(inv.messageId);
				continue;
			}
			const seconds = (end - start) / 1000;
			if (seconds < config.minRunSeconds) continue;
			events.push({ at: end, kind: "verification", messageId: inv.messageId, seconds, command: c.command, dir: c.dir });
		} else if (c.kind === "edit") {
			const location = c.dir !== undefined ? c.dir : /^(\/|~\/)/.test(c.target) ? c.target : null;
			events.push({ at: end, kind: "edit", messageId: inv.messageId, target: c.target, location });
		} else {
			events.push({ at: end, kind: c.kind });
		}
	}
	events.sort((a, b) => a.at - b.at);

	const stale: StaleRun[] = [];
	let passingCount = 0;
	let passingSeconds = 0;
	let unverifiedCommits = 0;
	// Passing runs since the last commit or edit, each with the cause seen so far.
	let pending: Array<{ run: Extract<Event, { kind: "verification" }>; prompt: boolean; subagent: boolean }> = [];
	// Stale runs whose outcome waits on the next verification run or commit.
	let awaiting: StaleRun[] = [];

	for (const e of events) {
		switch (e.kind) {
			case "prompt":
				for (const p of pending) p.prompt = true;
				break;
			case "subagent":
				for (const p of pending) p.subagent = true;
				break;
			case "verification":
				passingCount++;
				passingSeconds += e.seconds;
				for (const s of awaiting) s.outcome = "rerun";
				awaiting = [];
				pending.push({ run: e, prompt: false, subagent: false });
				break;
			case "edit": {
				const reached = pending.filter((p) => editReaches(p.run.dir, e.location));
				for (const p of reached) {
					const s: StaleRun = {
						message_id: p.run.messageId,
						seconds: r(p.run.seconds),
						command: p.run.command,
						cause: p.prompt ? "user" : p.subagent ? "subagent" : "agent",
						edit_message_id: e.messageId,
						edit_target: firstLine(e.target),
						outcome: "unverified_at_end",
					};
					stale.push(s);
					awaiting.push(s);
				}
				pending = pending.filter((p) => !reached.includes(p));
				break;
			}
			case "commit":
				if (awaiting.length > 0) unverifiedCommits++;
				for (const s of awaiting) s.outcome = "committed_unverified";
				awaiting = [];
				pending = [];
				break;
		}
	}

	const byCause = { agent: 0, user: 0, subagent: 0 };
	for (const s of stale) byCause[s.cause] += s.seconds;
	return {
		passing_run_count: passingCount,
		passing_run_seconds: r(passingSeconds),
		untimed_run_count: untimed,
		stale_runs: stale,
		stale_seconds: r(stale.reduce((sum, s) => sum + s.seconds, 0)),
		stale_seconds_by_cause: { agent: r(byCause.agent), user: r(byCause.user), subagent: r(byCause.subagent) },
		timed_out_run_count: timedOut,
		zero_exit_failures: { count: zeroExit.length, message_ids: zeroExit.slice(0, config.evidenceCap) },
		unverified_commit_count: unverifiedCommits,
	};
}

function singleResult(json: string | null): boolean {
	if (!json) return false;
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) && parsed.length === 1;
	} catch {
		return false;
	}
}
