/**
 * Deterministic timing of a session's tool calls (issue #306).
 *
 * A call's duration runs from the message that issued it to the message that
 * carried its result. Both are host-recorded timestamps, so nothing here is
 * estimated: a call whose start, end, or result is missing is counted as
 * **untimed**, never as zero seconds, because a silent zero reads as "this was
 * instant" to every consumer.
 *
 * Four findings come out of the same pass:
 *
 *   - **families** — total seconds per command family (a shell call's leading
 *     words, or a non-shell tool's name), so one slow test runner or one
 *     polling habit shows up as one row;
 *   - **in-call waits** — calls that block inside a single invocation (a loop
 *     that sleeps, a long `sleep`, a blocking watcher). The trajectory
 *     analyzer's polling-loop sees only waits spread over repeated calls;
 *   - **harness timeouts** — calls whose result says the harness stopped
 *     waiting for them, so the agent sat out the whole tool timeout;
 *   - **self-matching waits** — `pgrep -f` or `ps | grep` loops whose pattern
 *     also matches the shell running the loop, so the loop cannot observe the
 *     process it waits on ending. Syntax only nominates a candidate; the loop
 *     counts as confirmed when it ran to its own bound or to the harness
 *     timeout, because a loop that broke out early did see its target exit.
 *     A harness timeout covers the whole call, so a loop followed by other
 *     long work in the same call can be confirmed when the later work, not
 *     the loop, outlived the timeout.
 */

import { Type, type Static } from "typebox";
import type { BackgroundTaskRow, MessageRow } from "../../types.js";
import { buildToolStream, singleResult } from "../../tool-stream.js";
import { parseTime } from "../stale-verification/command-vocabulary.js";
import { completionTime, indexBackgroundTasks, isBackgroundCall } from "./background.js";
import { findFailureMarkers, HiddenExitCodeSchema, roundSeconds as r, type HiddenExitCode } from "./spans.js";
import type { TimeEconomyConfig } from "./config.js";

export const FamilyTimeSchema = Type.Object({
	family: Type.String(),
	calls: Type.Number(),
	seconds: Type.Number(),
	max_seconds: Type.Number(),
	error_count: Type.Number(),
});
export type FamilyTime = Static<typeof FamilyTimeSchema>;

export const InCallWaitsSchema = Type.Object({
	call_count: Type.Number(),
	seconds: Type.Number(),
	longest_seconds: Type.Number(),
	/** The issuing messages of the longest waits, longest first, capped. */
	message_ids: Type.Array(Type.String()),
});
export type InCallWaits = Static<typeof InCallWaitsSchema>;

export const SelfMatchingWaitSchema = Type.Object({
	message_id: Type.String(),
	seconds: Type.Number(),
	family: Type.String(),
	/**
	 * Whether the loop ran until something outside it stopped it: the harness
	 * timed the call out, or a bounded loop used up its own bound. A loop that
	 * matched itself can only end that way; one that broke out early saw its
	 * target exit, so its pattern did not match the loop after all.
	 */
	ran_to_limit: Type.Boolean(),
});
export type SelfMatchingWait = Static<typeof SelfMatchingWaitSchema>;

export const TimedOutCallsSchema = Type.Object({
	call_count: Type.Number(),
	seconds: Type.Number(),
	/** The issuing messages, in session order, capped. */
	message_ids: Type.Array(Type.String()),
});
export type TimedOutCalls = Static<typeof TimedOutCallsSchema>;

/** A backgrounded call whose real end the host recorded. */
export const BackgroundCallSchema = Type.Object({
	/** The message that issued the call. */
	message_id: Type.String(),
	/** The tool's name. */
	tool: Type.String(),
	/** The command family the call belongs to. */
	family: Type.String(),
	/** How long the background work really took, in seconds. */
	seconds: Type.Number(),
	/** The host's verdict, verbatim: completed | failed | killed | … */
	status: Type.Union([Type.String(), Type.Null()]),
});
export type BackgroundCall = Static<typeof BackgroundCallSchema>;

export const BackgroundCallsSchema = Type.Object({
	/** Backgrounded calls whose real end is known. */
	timed_call_count: Type.Number(),
	/** Total seconds of backgrounded work. */
	seconds: Type.Number(),
	/**
	 * Backgrounded calls whose completion was never recorded. Their duration is
	 * unknown, so it is never counted as zero.
	 */
	untimed_call_count: Type.Number(),
	/** The timed calls, longest first, capped. */
	calls: Type.Array(BackgroundCallSchema),
});
export type BackgroundCalls = Static<typeof BackgroundCallsSchema>;

export const TimeScanSchema = Type.Object({
	timed_call_count: Type.Number(),
	untimed_call_count: Type.Number(),
	tool_seconds: Type.Number(),
	wall_clock_seconds: Type.Number(),
	active_seconds: Type.Number(),
	families: Type.Array(FamilyTimeSchema),
	in_call_waits: InCallWaitsSchema,
	self_matching_waits: Type.Array(SelfMatchingWaitSchema),
	/** Calls whose result says the harness stopped waiting for them. */
	timed_out_calls: TimedOutCallsSchema,
	/** Backgrounded calls, timed by their real completion. */
	background_calls: BackgroundCallsSchema,
	/** Successful calls whose output says the work failed anyway. */
	hidden_exit_codes: Type.Array(HiddenExitCodeSchema),
});
export type TimeScan = Static<typeof TimeScanSchema>;

const CD_PREFIX = /^\s*cd\s+\S+\s*(&&|;)\s*/;
const ENV_PREFIX = /^\s*([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const TIMEOUT_PREFIX = /^\s*timeout\s+\S+\s+/;

/**
 * The family a shell command belongs to: its first `words` words, after
 * dropping what does not change which program runs — a leading `cd`,
 * environment assignments, and a `timeout` wrapper.
 */
export function commandFamily(command: string, words: number): string {
	let c = command.split("\n")[0] ?? "";
	for (let prev = ""; prev !== c; ) {
		prev = c;
		c = c.replace(CD_PREFIX, "").replace(ENV_PREFIX, "").replace(TIMEOUT_PREFIX, "");
	}
	const family = c.trim().split(/\s+/).filter(Boolean).slice(0, words).join(" ");
	return family || "(empty)";
}

const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1\b/g;
const ANY_LOOP = /\b(until|while|for)\b[\s\S]*?\bdo\b/;
const LOOP_CONDITION = /\b(?:until|while)\b([\s\S]*?)\bdo\b/g;
const LOOP_SLEEP = /\bsleep\s+\d/;
const STANDALONE_SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)/g;
const PGREP = /\bpgrep\b([^;|&\n]*)/g;
const PGREP_BREAK = /\bpgrep\b([^;|&\n]*)[^;\n]*?(?:\|\||&&)\s*break\b/g;
const PS_GREP = /\bps\b[^|;\n]*\|\s*grep\b([^|;\n]*)/g;
const GREP_V_GREP = /\bgrep\s+-v\s+['"]?grep\b/;

/** Whether the first non-flag argument is a bracketed pattern like `[r]unner`, which cannot match itself. */
function firstPatternIsBracketed(args: string): boolean {
	const pattern = args
		.trim()
		.split(/\s+/)
		.find((t) => t !== "" && !t.startsWith("-"));
	return pattern !== undefined && /^['"]?\[/.test(pattern);
}

/** A `pgrep` argument list that matches full command lines with a pattern that can match itself. */
function selfMatchingPgrep(args: string): boolean {
	const fullCommandLine = args.split(/\s+/).some((t) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t));
	return fullCommandLine && !firstPatternIsBracketed(args);
}

/**
 * Classify one shell command: does it wait inside the call, and is it a wait
 * loop that matches its own command line?
 *
 * Heredoc bodies are removed first: a loop written into a file is text, not a
 * wait. A self-matching wait must be a loop that sleeps and that tests a
 * `pgrep -f` or `ps | grep` match either in its condition or in a
 * `… || break` inside its body. A loop that iterates over pgrep's output
 * (`pgrep -f x | while read p`) tests nothing and is not a wait.
 */
export function classifyWait(
	command: string,
	config: Pick<TimeEconomyConfig, "minSleepSeconds" | "blockingWaitPatterns">,
): { inCallWait: boolean; selfMatching: boolean } {
	const run = command.replace(HEREDOC, "<<HEREDOC");
	const sleepingLoop = ANY_LOOP.test(run) && LOOP_SLEEP.test(run);
	let longSleep = false;
	for (const m of run.matchAll(STANDALONE_SLEEP)) {
		if (Number(m[1]) >= config.minSleepSeconds) longSleep = true;
	}
	const watcher = configRegExps("blockingWaitPatterns", config.blockingWaitPatterns, "i").some((re) => re.test(run));

	let selfMatching = false;
	if (sleepingLoop) {
		for (const cond of run.matchAll(LOOP_CONDITION)) {
			const text = cond[1] ?? "";
			for (const m of text.matchAll(PGREP)) if (selfMatchingPgrep(m[1] ?? "")) selfMatching = true;
			if (!GREP_V_GREP.test(text)) {
				for (const m of text.matchAll(PS_GREP)) if (!firstPatternIsBracketed(m[1] ?? "")) selfMatching = true;
			}
		}
		for (const m of run.matchAll(PGREP_BREAK)) if (selfMatchingPgrep(m[1] ?? "")) selfMatching = true;
	}

	return { inCallWait: sleepingLoop || longSleep || watcher, selfMatching };
}

const SEQ_LOOP = /\bfor\s+\w+\s+in\s+\$\(seq\s+(?:(\d+)\s+)?(\d+)\)/;
const FIRST_SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)/;

/** The seconds a `for i in $(seq a b); do …; sleep S; done` loop can run, or null when it has no such bound. */
export function loopBoundSeconds(command: string): number | null {
	const run = command.replace(HEREDOC, "<<HEREDOC");
	const seq = SEQ_LOOP.exec(run);
	const sleep = FIRST_SLEEP.exec(run);
	if (!seq || !sleep) return null;
	const first = seq[1] === undefined ? 1 : Number(seq[1]);
	const iterations = Number(seq[2]) - first + 1;
	return iterations > 0 ? iterations * Number(sleep[1]) : null;
}

const compiled = new Map<string, RegExp>();

/**
 * Compile a config pattern once. An invalid pattern is a configuration fault,
 * so the error names the config entry rather than surfacing a bare SyntaxError.
 */
function configRegExp(key: string, patterns: readonly string[], index: number, flags: string): RegExp {
	const source = patterns[index]!;
	const cacheKey = `${flags}/${source}`;
	let re = compiled.get(cacheKey);
	if (!re) {
		try {
			re = new RegExp(source, flags);
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			throw new Error(`time-economy config: ${key}[${index}] is not a valid regular expression: ${why}`);
		}
		compiled.set(cacheKey, re);
	}
	return re;
}

function configRegExps(key: string, patterns: readonly string[], flags: string): RegExp[] {
	return patterns.map((_, i) => configRegExp(key, patterns, i, flags));
}

/**
 * The host's verdict on a background task that is a failure.
 *
 * The host records the outcome verbatim: `completed`, `failed`, `killed`,
 * `stopped`, … A `completed` task is not a failure — the host finished the
 * work, and whether the work *succeeded* is a separate question this analyzer
 * does not answer from the status alone.
 */
export function isFailedBackgroundStatus(status: string | null): boolean {
	if (!status) return false;
	return status === "failed" || status === "killed" || status === "stopped" || status === "error";
}

/** Total length of a set of [start, end] intervals, counting overlaps once. */
function unionLength(intervals: Array<[number, number]>): number {
	const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
	let total = 0;
	let curStart = Number.NEGATIVE_INFINITY;
	let curEnd = Number.NEGATIVE_INFINITY;
	for (const [a, b] of sorted) {
		if (a > curEnd) {
			if (curEnd > curStart) total += curEnd - curStart;
			curStart = a;
			curEnd = b;
		} else if (b > curEnd) {
			curEnd = b;
		}
	}
	if (curEnd > curStart) total += curEnd - curStart;
	return total;
}

/**
 * Measure where a session's time went.
 *
 * `backgroundTasks` are the host's records of when a backgrounded call really
 * finished. A backgrounded call's own result is an acknowledgement, so its
 * duration comes from the completion record instead; a call with neither a
 * completion nor a usable result is untimed, never zero.
 */
export function measureTime(
	messages: readonly MessageRow[],
	config: TimeEconomyConfig,
	backgroundTasks: readonly BackgroundTaskRow[] = [],
): TimeScan {
	const timeById = new Map<string, number | null>();
	// A result row's text belongs to its call only when the row carries one
	// result; the transcript joins several results' texts into one field.
	const textById = new Map<string, string>();
	for (const m of messages) {
		timeById.set(m.id, parseTime(m.timestamp));
		if (m.role === "toolResult" && m.content_text && singleResult(m.tool_results)) textById.set(m.id, m.content_text);
	}
	const timeoutPatterns = configRegExps("timeoutResultPatterns", config.timeoutResultPatterns, "i");
	const timedOut: Array<{ messageId: string; seconds: number }> = [];

	const shellNames = new Set(config.shellToolNames.map((n) => n.toLowerCase()));
	const families = new Map<string, FamilyTime>();
	const intervals: Array<[number, number]> = [];
	const waits: Array<{ messageId: string; seconds: number }> = [];
	const selfMatching: SelfMatchingWait[] = [];
	const backgroundCalls: BackgroundCall[] = [];
	let untimedBackground = 0;
	const hiddenExitCodes: HiddenExitCode[] = [];
	let timed = 0;
	let untimed = 0;
	let toolSeconds = 0;

	const completions = indexBackgroundTasks(backgroundTasks);

	for (const inv of buildToolStream([...messages]).invocations) {
		const start = timeById.get(inv.messageId) ?? null;
		const isShell = shellNames.has(inv.name.toLowerCase());
		const command = isShell && typeof inv.args["command"] === "string" ? (inv.args["command"] as string) : "";
		const family = isShell ? commandFamily(command, config.familyWords) : inv.name;

		// A backgrounded call's real end is the host's completion record, not
		// the acknowledgement the transcript recorded for it.
		const completion = inv.callId ? completions.get(inv.callId) : undefined;
		if (completion) {
			const completedMs = completionTime(completion);
			if (start === null || completedMs === null || completedMs < start) {
				untimedBackground++;
			} else {
				const seconds = (completedMs - start) / 1000;
				toolSeconds += seconds;
				intervals.push([start, completedMs]);
				backgroundCalls.push({
					message_id: inv.messageId,
					tool: inv.name,
					family,
					seconds: r(seconds),
					status: completion.status,
				});
				const f = families.get(family) ?? { family, calls: 0, seconds: 0, max_seconds: 0, error_count: 0 };
				f.calls++;
				f.seconds += seconds;
				f.max_seconds = Math.max(f.max_seconds, seconds);
				// The host's own verdict on the background task. A task that
				// completed is not a failure; one the host recorded as failed or
				// killed is, and the family row must say so — otherwise the
				// family understates failures for exactly the calls this
				// analyzer makes measurable.
				if (isFailedBackgroundStatus(completion.status)) f.error_count++;
				families.set(family, f);
			}
			continue;
		}

		// A call the host ran in the background whose completion was never
		// recorded. Its acknowledgement says nothing about how long the work
		// took, so timing it by the acknowledgement would report the
		// near-instant the change exists to remove. It is untimed background:
		// the duration is unknown, never zero.
		if (isBackgroundCall(inv.args)) {
			untimedBackground++;
			continue;
		}

		const end = inv.outcome ? (timeById.get(inv.outcome.messageId) ?? null) : null;
		if (start === null || end === null || end < start) {
			untimed++;
			continue;
		}
		timed++;
		const seconds = (end - start) / 1000;
		toolSeconds += seconds;
		intervals.push([start, end]);

		const f = families.get(family) ?? { family, calls: 0, seconds: 0, max_seconds: 0, error_count: 0 };
		f.calls++;
		f.seconds += seconds;
		f.max_seconds = Math.max(f.max_seconds, seconds);
		if (inv.outcome?.isError) f.error_count++;
		families.set(family, f);

		const resultText = inv.outcome ? (textById.get(inv.outcome.messageId) ?? "") : "";
		const harnessTimedOut = timeoutPatterns.some((p) => p.test(resultText));
		if (harnessTimedOut) timedOut.push({ messageId: inv.messageId, seconds });

		// A call the harness called successful whose output says it failed: the
		// exit code a pipe hid. `cmd 2>&1 | tail -40` returns tail's status, so
		// the failure never reaches the exit code — only the output shows it.
		//
		// Only a *shell* call is examined. A read of a document that happens to
		// contain the phrase "Permission denied" is not a failed command, and a
		// non-shell tool has no exit code for a pipe to hide in the first place.
		if (isShell && inv.outcome && !inv.outcome.isError && resultText) {
			const markers = findFailureMarkers(resultText, config.failureMarkers);
			if (markers.length > 0) {
				hiddenExitCodes.push({ message_id: inv.messageId, family, seconds: r(seconds), markers });
			}
		}

		if (isShell) {
			const w = classifyWait(command, config);
			if (w.inCallWait) waits.push({ messageId: inv.messageId, seconds });
			if (w.selfMatching) {
				const bound = loopBoundSeconds(command);
				const ranToBound = bound !== null && seconds >= config.boundedLoopTolerance * bound;
				selfMatching.push({ message_id: inv.messageId, seconds: r(seconds), family, ran_to_limit: harnessTimedOut || ranToBound });
			}
		}
	}

	// Active time: every tool call's own span, plus each gap between messages
	// up to the idle cap. A gap a call spans stays fully active through the
	// call's interval; the union counts the overlap once.
	const times = messages
		.map((m) => timeById.get(m.id) ?? null)
		.filter((t): t is number => t !== null)
		.sort((a, b) => a - b);
	const capMs = config.idleCapSeconds * 1000;
	for (let i = 0; i + 1 < times.length; i++) {
		const a = times[i]!;
		const b = times[i + 1]!;
		intervals.push([a, a + Math.min(b - a, capMs)]);
	}
	const wall = times.length > 1 ? (times[times.length - 1]! - times[0]!) / 1000 : 0;

	const ranked = [...families.values()]
		.sort((a, b) => b.seconds - a.seconds || b.calls - a.calls || a.family.localeCompare(b.family))
		.slice(0, config.topFamilies)
		.map((f) => ({ ...f, seconds: r(f.seconds), max_seconds: r(f.max_seconds) }));

	const longestFirst = [...waits].sort((a, b) => b.seconds - a.seconds);
	const backgroundLongestFirst = [...backgroundCalls].sort((a, b) => b.seconds - a.seconds);
	return {
		timed_call_count: timed,
		untimed_call_count: untimed,
		tool_seconds: r(toolSeconds),
		wall_clock_seconds: r(wall),
		active_seconds: r(unionLength(intervals) / 1000),
		families: ranked,
		in_call_waits: {
			call_count: waits.length,
			seconds: r(waits.reduce((s, w) => s + w.seconds, 0)),
			longest_seconds: r(longestFirst[0]?.seconds ?? 0),
			message_ids: longestFirst.slice(0, config.evidenceCap).map((w) => w.messageId),
		},
		self_matching_waits: selfMatching,
		timed_out_calls: {
			call_count: timedOut.length,
			seconds: r(timedOut.reduce((s, t) => s + t.seconds, 0)),
			message_ids: timedOut.slice(0, config.evidenceCap).map((t) => t.messageId),
		},
		background_calls: {
			timed_call_count: backgroundCalls.length,
			seconds: r(backgroundCalls.reduce((s, b) => s + b.seconds, 0)),
			untimed_call_count: untimedBackground,
			calls: backgroundLongestFirst.slice(0, config.evidenceCap),
		},
		hidden_exit_codes: hiddenExitCodes.slice(0, config.evidenceCap),
	};
}

