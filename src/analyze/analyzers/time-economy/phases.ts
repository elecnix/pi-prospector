/**
 * Phase spans and skill spans over a session's ordered action stream
 * (issue #306).
 *
 * A **phase span** is the stretch between two markers in the work:
 *
 *   - **start to first commit** — everything the agent did before it first
 *     committed. This is the span an operator feels as "the session was slow
 *     before anything landed".
 *   - **commit preparation** — from the moment the agent began assembling a
 *     commit (its first full test run, its `git add`, a review, or a PR skill,
 *     whichever came first after the previous commit) to the commit itself.
 *     This is the span that says "the commit took 40 minutes", which is a
 *     different fact from "the session took three hours".
 *
 * A **skill span** is the stretch a skill occupied the agent: it opens at the
 * `Skill` call and closes at the next `Skill` call or at the end of the turn,
 * whichever comes first. A PR skill closes at its successful `gh pr create`
 * instead, because that is where the skill's work actually ended — the turns
 * after it are the agent's, not the skill's. Nested skills do not double-count:
 * a `Skill` call inside an open skill span closes the outer span rather than
 * opening a second, overlapping one.
 *
 * Every span reports the same three things, so they can be compared: minutes,
 * turns, and tokens. Tokens are null when the transcript recorded no usage —
 * unknown, never zero.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import { buildToolStream, singleResult } from "../../tool-stream.js";
import { parseTime } from "../stale-verification/command-vocabulary.js";
import {
	findFailureMarkers,
	isPreparationCommand,
	isPrCreateCommand,
	isPullRequestSkill,
	roundSeconds as r,
	skillNameOf,
	SKILL_TOOL,
	type PhaseSpan,
	type SkillSpan,
} from "./spans.js";

export type { PhaseSpan, SkillSpan };

/** A message row with the columns the span measures need. */
export interface SpanRow extends MessageRow {
	/** The row's usage JSON, when the transcript recorded one. */
	usage: string | null;
}

/**
 * One turn boundary in the stream: the messages that share a turn, and the
 * instant the turn opened.
 */
interface Turn {
	/** The message that opened the turn. */
	startMessageId: string;
	/** The instant the turn opened, in ms, or null when unrecorded. */
	startMs: number | null;
	/**
	 * The instant the turn closed, in ms, or null when unrecorded.
	 *
	 * The turn's end is the last message before the next user message. A span
	 * that opens in the middle of a turn still belongs to that turn, so the
	 * turn's end is what says the span is inside it.
	 */
	endMs: number | null;
}

/**
 * The session's turn boundaries.
 *
 * A turn begins at a user message (DESIGN.md's turn definition) and spans
 * everything the agent does in response. A `Skill` span ends at the end of
 * its turn, so the boundaries have to be known before the spans can be.
 */
function turnStarts(rows: readonly SpanRow[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;
	for (const row of rows) {
		if (row.role === "user") {
			current = { startMessageId: row.id, startMs: parseTime(row.timestamp), endMs: null };
			turns.push(current);
			continue;
		}
		if (current === null) {
			// Work before the first user message still belongs to a turn: the
			// harness's own opening actions. It is a turn with no user message.
			current = { startMessageId: row.id, startMs: parseTime(row.timestamp), endMs: null };
			turns.push(current);
		}
		const ms = parseTime(row.timestamp);
		// The turn's end is the latest message in it. Rows are not guaranteed
		// to be in timestamp order, so the latest wins rather than the last.
		if (ms !== null) current.endMs = current.endMs === null ? ms : Math.max(current.endMs, ms);
	}
	return turns;
}

/**
 * The tokens an assistant row's usage records, or null when it records none.
 *
 * The sum of the buckets is the total the row billed. A row with no usage is
 * unknown, not zero.
 */
function tokensOf(usage: string | null): number | null {
	if (!usage) return null;
	try {
		const parsed = JSON.parse(usage) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const total = num(parsed["totalTokens"]);
		if (total > 0) return total;
		return num(parsed["input"]) + num(parsed["output"]) + num(parsed["cacheRead"]) + num(parsed["cacheWrite"]);
	} catch {
		return null;
	}
}

/**
 * The tokens spent between two points in the stream.
 *
 * Returns null when no row in the window recorded any usage: a span whose
 * tokens are unknown says so, rather than reporting zero for work that was
 * billed.
 */
function tokensBetween(rows: readonly SpanRow[], fromMs: number | null, toMs: number | null): number | null {
	if (fromMs === null || toMs === null) return null;
	let sum = 0;
	let seen = false;
	for (const row of rows) {
		if (row.role !== "assistant") continue;
		const ms = parseTime(row.timestamp);
		if (ms === null || ms < fromMs || ms > toMs) continue;
		const tokens = tokensOf(row.usage);
		if (tokens === null) continue;
		sum += tokens;
		seen = true;
	}
	return seen ? sum : null;
}

/**
 * The session's bounds: its earliest message and its latest.
 *
 * Rows are not guaranteed to be in timestamp order, so the bounds are the
 * earliest and the latest message rather than the first and the last row. A
 * session whose last row is earlier than its first is still a session of a
 * real length.
 */
function sessionBounds(rows: readonly SpanRow[]): { firstMs: number | null; lastMs: number | null } {
	let firstMs: number | null = null;
	let lastMs: number | null = null;
	for (const row of rows) {
		const ms = parseTime(row.timestamp);
		if (ms === null) continue;
		if (firstMs === null || ms < firstMs) firstMs = ms;
		if (lastMs === null || ms > lastMs) lastMs = ms;
	}
	return { firstMs, lastMs };
}

/**
 * The number of turns a span covers.
 *
 * A turn counts when the span reaches into it: the turn opened before the
 * span started and the span began while the turn was still open, or the
 * turn opened inside the span. A turn that opened after the span ended is
 * not counted, and neither is one that closed before the span began.
 *
 * A span that starts in the middle of a turn therefore counts that turn: the
 * work the agent did in it belongs to the turn, whether or not the span
 * covers the turn's opening message. A span that reaches across a turn
 * boundary counts both turns, even when the first of them closed before the
 * span ended.
 */
function turnsBetween(startMs: number | null, endMs: number | null, turns: readonly Turn[]): number {
	if (startMs === null || endMs === null) return 0;
	let count = 0;
	for (const turn of turns) {
		if (turn.startMs === null) continue;
		// The turn opened inside the span.
		if (turn.startMs >= startMs && turn.startMs <= endMs) {
			count++;
			continue;
		}
		// The turn opened before the span began and was still open when the
		// span began: the span sits inside the turn.
		if (turn.startMs <= startMs && turn.endMs !== null && turn.endMs >= startMs) count++;
	}
	return count;
}

/**
 * Measure the phase spans of a session.
 *
 * `commit` is a callback telling whether a call is a commit, and `preparation`
 * whether it starts a commit's preparation. Both are injected so this module
 * stays free of the tool vocabulary, and so the shell detection lives with the
 * other shell detection.
 */
export function measurePhaseSpans(
	rows: readonly SpanRow[],
	opts: {
		isCommit: (command: string) => boolean;
		isPreparation: (command: string) => boolean;
		/** The commit's subject, read from the command that made it. */
		commitSubject?: (command: string) => string | null;
		/**
		 * Whether a preparation command prepared nothing, because it failed.
		 *
		 * The issue names "the first full test run" as the marker, and the
		 * measure beside it counts *passing* runs: a test run that failed
		 * left the agent with work to do, so it did not prepare the commit.
		 * Only a test run can fail this way; staging, a review and a skill
		 * either happened or did not.
		 */
		isFailedPreparation?: (command: string, isError: boolean, outputMarkers: readonly string[]) => boolean;
		/**
		 * The failure markers a call's output is checked for. A test run whose
		 * failure a pipe hid is reported as a success by the host, so its
		 * output is the only evidence that it failed.
		 */
		failureMarkers?: readonly string[];
		/**
		 * Whether a skill call marks the start of a commit's preparation.
		 *
		 * The issue names a PR skill as one of the four markers, and a skill
		 * is a tool call, not a shell command: the shell scan never sees it.
		 * The callback is given the skill's name.
		 */
		isPreparationSkill?: (skill: string) => boolean;
	},
): PhaseSpan[] {
	const stream = buildToolStream([...rows]);
	const timeById = new Map<string, number | null>();
	for (const row of rows) timeById.set(row.id, parseTime(row.timestamp));
	const turns = turnStarts(rows);

	// A result row's text belongs to its call only when the row carries one
	// result; the transcript joins several results' texts into one field.
	const outputTextById = new Map<string, string>();
	for (const row of rows) {
		if (row.role !== "toolResult" || !row.content_text) continue;
		if (singleResult(row.tool_results)) outputTextById.set(row.id, row.content_text);
	}

	// The commands the session ran, in order, with the instant each started,
	// whether the host reported it as an error, and the failure markers its
	// output carried. The position is the command's own place in the stream,
	// which is what separates a preparation from the commit it precedes: a
	// combined \`git add -A && git commit\` is both a preparation command and
	// the commit, and it cannot be its own preparation start.
	const commands: Array<{
		messageId: string;
		command: string;
		ms: number | null;
		isError: boolean;
		markers: readonly string[];
		position: number;
		/** Whether this call is a preparation marker of its own. */
		isPreparation: boolean;
	}> = [];
	for (const inv of stream.invocations) {
		const command = typeof inv.args["command"] === "string" ? (inv.args["command"] as string) : "";
		// A skill call is a preparation marker too, and the shell scan never
		// sees it: it carries no command at all.
		const skill = inv.name === SKILL_TOOL ? skillNameOf(inv.args) : null;
		const skillIsPreparation = skill !== null && (opts.isPreparationSkill?.(skill) ?? false);
		if (!command && !skillIsPreparation) continue;
		const output = inv.outcome ? (outputTextById.get(inv.outcome.messageId) ?? "") : "";
		const markers = inv.outcome && !inv.outcome.isError && output ? findFailureMarkers(output, opts.failureMarkers ?? []) : [];
		commands.push({
			messageId: inv.messageId,
			command,
			ms: timeById.get(inv.messageId) ?? null,
			isError: inv.outcome?.isError ?? false,
			markers,
			position: inv.ordinal,
			isPreparation: skillIsPreparation || (command !== "" && opts.isPreparation(command)),
		});
	}

	const spans: PhaseSpan[] = [];
	// The session's bounds are its earliest and its latest message, not its
	// first and its last row: rows are not guaranteed to be in timestamp
	// order, and a session whose last row is earlier than its first is still
	// a session of a real length. The message ids name the rows that carry
	// those bounds, so the id and the time agree.
	const { firstMs, lastMs } = sessionBounds(rows);
	const firstRow = rows.find((r) => parseTime(r.timestamp) === firstMs) ?? null;
	const lastRow = [...rows].reverse().find((r) => parseTime(r.timestamp) === lastMs) ?? null;

	// The first commit ends the start-to-first-commit span.
	const firstCommit = commands.find((c) => opts.isCommit(c.command));
	if (firstCommit) {
		const endMs = timeById.get(firstCommit.messageId) ?? null;
		spans.push({
			kind: "start_to_first_commit",
			start_message_id: firstRow?.id ?? rows[0]?.id ?? "",
			end_message_id: firstCommit.messageId,
			seconds: endMs !== null && firstMs !== null ? r(Math.max(0, endMs - firstMs) / 1000) : 0,
			turns: turnsBetween(firstMs, endMs, turns),
			tokens: tokensBetween(rows, firstMs, endMs),
			end_reason: "commit",
			commit_subject: opts.commitSubject?.(firstCommit.command) ?? null,
		});
	} else if (rows.length > 0) {
		// No commit: the span ran to the end of the session, and says so.
		spans.push({
			kind: "start_to_first_commit",
			start_message_id: firstRow?.id ?? rows[0]!.id,
			end_message_id: lastRow?.id ?? rows[rows.length - 1]!.id,
			seconds: lastMs !== null && firstMs !== null ? r(Math.max(0, lastMs - firstMs) / 1000) : 0,
			turns: turnsBetween(firstMs, lastMs, turns),
			tokens: tokensBetween(rows, firstMs, lastMs),
			end_reason: "session_end",
			commit_subject: null,
		});
	}

	// Each commit's preparation span: from the first preparation command after
	// the previous commit, to the commit itself.
	//
	// A commit with no preparation command after the previous one still gets a
	// span, and its span starts at the previous commit — the earliest moment
	// the new work could have begun. Reporting it as a zero-second span would
	// say "this commit took no preparation time", which is not what was
	// observed; what was observed is that no marker was seen, and the work
	// between the two commits is the honest lower bound of the span.
	//
	// The lower bound is the previous commit's *place in the stream*, not its
	// time: a commit whose timestamp cannot be placed still has a place, and
	// a preparation from before it does not belong to the commit after it.
	let previousCommitPosition = -1;
	let previousCommitMs: number | null = null;
	let previousCommitId: string | null = null;
	for (const commit of commands.filter((c) => opts.isCommit(c.command))) {
		const commitMs = timeById.get(commit.messageId) ?? null;
		const isFailed = opts.isFailedPreparation ?? (() => false);
		const preparation = commands.find(
			(c) =>
				c.isPreparation &&
				// A test run that failed prepared nothing: the agent still had
				// work to do before the commit. Only a run that passed marks
				// the start of the preparation.
				!isFailed(c.command, c.isError, c.markers) &&
				// The preparation precedes the commit in the stream, and comes
				// after the previous commit. A command that both stages and
				// commits is the commit itself, and cannot be its own
				// preparation start.
				c.position < commit.position &&
				c.position > previousCommitPosition &&
				// A commit whose own time cannot be placed cannot bound its
				// preparation: a marker from a later turn is not a start for
				// it. The same rule the pull-request end follows — a bound
				// that cannot be placed excludes the candidate.
				commitMs !== null &&
				c.ms !== null &&
				c.ms <= commitMs,
		);
		const startMs = preparation ? (preparation.ms ?? null) : previousCommitMs ?? firstMs;
		const startMessageId = preparation
			? preparation.messageId
			: previousCommitId ?? rows[0]?.id ?? "";
		const endMs = commitMs;
		spans.push({
			kind: "commit_preparation",
			start_message_id: startMessageId,
			end_message_id: commit.messageId,
			seconds: startMs !== null && endMs !== null ? r(Math.max(0, endMs - startMs) / 1000) : 0,
			turns: turnsBetween(startMs, endMs, turns),
			tokens: tokensBetween(rows, startMs, endMs),
			end_reason: "commit",
			commit_subject: opts.commitSubject?.(commit.command) ?? null,
		});
		// The previous commit's *place in the stream* is the next commit's
		// lower bound. A commit whose time cannot be placed still has a
		// place, so it must not reset that bound: making it unbounded would
		// admit a preparation from before the previous commit, and the span
		// would run across a commit it should not cross.
		previousCommitPosition = commit.position;
		if (commitMs !== null) {
			previousCommitMs = commitMs;
			previousCommitId = commit.messageId;
		}
	}

	return spans;
}

/**
 * Measure the spans a skill occupied the agent.
 *
 * A skill span opens at the `Skill` call. It closes at the next `Skill` call,
 * at the end of the turn it belongs to, or — for a skill that creates a pull
 * request — at its successful `gh pr create`. A `Skill` call inside an open
 * span closes the outer span and opens its own, so nested skills never
 * double-count: the two spans abut, they do not overlap.
 */
export function measureSkillSpans(
	rows: readonly SpanRow[],
): SkillSpan[] {
	const stream = buildToolStream([...rows]);
	const timeById = new Map<string, number | null>();
	for (const row of rows) timeById.set(row.id, parseTime(row.timestamp));
	const turns = turnStarts(rows);
	// The session's latest message, which is where the session ended. Rows are
	// not guaranteed to be in timestamp order, so the latest wins rather than
	// the last.
	const sessionEndMs = sessionBounds(rows).lastMs;

	// The end of each turn, so a skill span can be closed at its turn's end.
	// Keyed by the turn's ordinal, the same key the skill calls carry, so the
	// lookup finds the turn the skill actually ran in. Keying it by the user
	// row's index instead would coincide with the ordinal only for the first
	// turn, and every later skill would fall through to the session's end.
	const turnEndMs = new Map<number, number | null>();
	{
		let turn = -1;
		// The harness's opening turn: everything before the first user
		// message. It gets its own ordinal, -1, and its own end.
		{
			let end: number | null = null;
			for (let j = 0; j < rows.length; j++) {
				if (rows[j]!.role === "user") break;
				const ms = parseTime(rows[j]!.timestamp);
				if (ms !== null) end = end === null ? ms : Math.max(end, ms);
			}
			turnEndMs.set(-1, end);
		}
		for (let i = 0; i < rows.length; i++) {
			if (rows[i]!.role !== "user") continue;
			turn++;
			let end: number | null = null;
			for (let j = i + 1; j < rows.length; j++) {
				if (rows[j]!.role === "user") break;
				const ms = parseTime(rows[j]!.timestamp);
				// The latest message in the turn, not the last one: rows are
				// not guaranteed to be in timestamp order.
				if (ms !== null) end = end === null ? ms : Math.max(end, ms);
			}
			turnEndMs.set(turn, end);
		}
	}
	/**
	 * The turn index a message belongs to.
	 *
	 * Work before the first user message is the harness's opening turn, and
	 * it gets its own ordinal — negative, so it can never collide with a
	 * user turn's. Indexing it as turn 0 would give it the first user
	 * turn's end, and a skill that ran in the opening turn would stretch
	 * past the user message that actually ended it.
	 */
	const turnIndexByMessage = new Map<string, number>();
	{
		let index = -1;
		for (const row of rows) {
			if (row.role === "user") index++;
			turnIndexByMessage.set(row.id, index);
		}
	}

	// The skill calls, in order, with the instant each opened.
	const skillCalls: Array<{ messageId: string; skill: string; ms: number | null; turn: number }> = [];
	for (const inv of stream.invocations) {
		if (inv.name !== SKILL_TOOL) continue;
		const skill = skillNameOf(inv.args);
		if (!skill) continue;
		skillCalls.push({
			messageId: inv.messageId,
			skill,
			ms: timeById.get(inv.messageId) ?? null,
			turn: turnIndexByMessage.get(inv.messageId) ?? -1,
		});
	}

	const spans: SkillSpan[] = [];
	for (let i = 0; i < skillCalls.length; i++) {
		const call = skillCalls[i]!;
		const next = skillCalls[i + 1];

		// A skill that creates a pull request ends at its successful creation.
		// Only a pull-request skill is a candidate: a `code-review` skill
		// followed later by an unrelated `gh pr create` must end at its turn,
		// not stretch across the gap to the PR.
		const prEnd = isPullRequestSkill(call.skill) ? findPrCreateEnd(stream, call, next, timeById) : null;

		let endMs: number | null;
		let endReason: SkillSpan["end_reason"];
		let endMessageId: string | null;
		if (prEnd) {
			endMs = prEnd.ms;
			endReason = "pr_created";
			endMessageId = prEnd.messageId;
		} else if (next && next.turn === call.turn) {
			// The next skill in the same turn closes this one.
			endMs = next.ms;
			endReason = "next_skill";
			endMessageId = next.messageId;
		} else {
			// The end of the turn the skill ran in.
			const turnEnd = turnEndMs.get(call.turn) ?? null;
			const isLast = i === skillCalls.length - 1;
			// The session's end is its latest message, not its last row: rows
			// are not guaranteed to be in timestamp order.
			const sessionEnd = sessionEndMs;
			if (turnEnd !== null) {
				endMs = turnEnd;
				endReason = "turn_end";
			} else if (isLast && sessionEnd !== null) {
				endMs = sessionEnd;
				endReason = "session_end";
			} else {
				endMs = next ? next.ms : null;
				endReason = next ? "next_skill" : "session_end";
			}
			endMessageId = null;
		}

		const startMs = call.ms;
		spans.push({
			message_id: call.messageId,
			skill: call.skill,
			seconds: startMs !== null && endMs !== null ? r(Math.max(0, endMs - startMs) / 1000) : 0,
			turns: turnsBetween(startMs, endMs, turns),
			tokens: tokensBetween(rows, startMs, endMs),
			end_reason: endReason,
		});
	}
	return spans;
}

/**
 * The successful `gh pr create` that ends a PR skill, if there is one.
 *
 * The creation must fall inside the skill's own span: after the skill opened
 * and before the next skill opened. A `gh pr create` that failed is a retry,
 * not the end of the skill's work, so an errored call does not close the span.
 *
 * The span ends at the *result*, not at the call: the pull request exists once
 * the forge answered, and that is the moment the skill's work was done.
 */
function findPrCreateEnd(
	stream: { invocations: Array<{ name: string; args: Record<string, unknown>; messageId: string; outcome: { messageId: string; isError: boolean } | null }> },
	call: { messageId: string; ms: number | null },
	next: { messageId: string; ms: number | null } | undefined,
	timeById: Map<string, number | null>,
): { messageId: string; ms: number | null } | null {
	for (const inv of stream.invocations) {
		if (inv.name !== "bash") continue;
		const command = typeof inv.args["command"] === "string" ? (inv.args["command"] as string) : "";
		if (!isPrCreateCommand(command)) continue;
		const ms = timeById.get(inv.messageId) ?? null;
		// Inside the skill's own span. A bound that cannot be placed excludes
		// the candidate rather than skipping the check: an unbounded span
		// cannot claim a creation it is not known to contain.
		if (call.ms === null || ms === null || ms < call.ms) continue;
		if (next && (next.ms === null || ms > next.ms)) continue;
		// A failed creation is a retry, not the end of the skill's work.
		if (!inv.outcome || inv.outcome.isError) continue;
		// The span ends when the forge answered, so the *result's* time has to
		// be inside the span too. A slow creation whose answer arrives after
		// the next skill started would otherwise run the span past that
		// skill's start, and the two spans would overlap — the same minutes
		// counted twice.
		const endedMs = timeById.get(inv.outcome.messageId) ?? null;
		if (endedMs === null) continue;
		if (next && (next.ms === null || endedMs > next.ms)) continue;
		return { messageId: inv.outcome.messageId, ms: endedMs };
	}
	return null;
}
