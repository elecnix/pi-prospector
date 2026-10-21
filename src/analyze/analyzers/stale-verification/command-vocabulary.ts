/**
 * The command vocabulary both verification analyzers share.
 *
 * A shell line is a sequence of commands, and which of them matters depends
 * on the question. `stale-verification` asks "which command verified the
 * tree?", and this asks "which command is worth a model call?". Both need the
 * same three things, and both need them to agree: the commands a line holds,
 * the directory it changed into, and the edits it made in place.
 *
 * One module owns them, so a command `stale-verification` counts as a
 * verification run is the same command `verification-commands` nominates for
 * judgement. Two private walkers over the same shell lines would drift the
 * moment either was fixed.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";

export const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1\b/g;
export const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const SEGMENT_PREFIX =
	/^\s*(?:[({]\s*|[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:timeout\s+(?:-\S+\s+)*\S+|time|npx|bunx|exec|nice|uv\s+run|poetry\s+run|python3?\s+-m|bash|sh)\s+)/;

const CD = /^cd\s+['"]?((?:\/|~\/)[^\s'"]*)/;
const HOME = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

/**
 * The commands in a shell line, each with leading wrappers dropped: a subshell
 * paren, environment assignments, and `timeout`, `time`, `npx`, `python -m`,
 * `bash`, and similar launchers. Heredoc bodies are removed first, because a
 * command written into a file is text, not a run.
 */
export function commandSegments(command: string): string[] {
	return command
		.replace(HEREDOC, "<<HEREDOC")
		.split(SEGMENT_SPLIT)
		.map((s) => {
			for (let prev = ""; prev !== s; ) {
				prev = s;
				s = s.replace(SEGMENT_PREFIX, "");
			}
			return s.trim();
		})
		.filter(Boolean);
}

/**
 * A timestamp in epoch milliseconds, or null when it is absent or unparsable.
 *
 * An unparsable timestamp is null rather than zero, so a call the host did
 * not time is counted as untimed and never as an instant run.
 */
export function parseTime(ts: string | null): number | null {
	if (!ts) return null;
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * A command line as a stable key: trimmed, with a leading `./` removed and
 * interior runs of whitespace collapsed. The same command under a different
 * directory is one entry, so the corpus pays for it once.
 */
export function normaliseCommand(command: string): string {
	return command.trim().replace(/^\.\//, "").replace(/\s+/g, " ");
}

/** A path with a home directory prefix rewritten to `~`, and no trailing slash. */
export function normalisePath(path: string): string {
	return path.replace(HOME, "~").replace(/\/+$/, "");
}

/** The first absolute or home-relative directory a shell line changes into, or null. */
export function workDir(command: string): string | null {
	for (const seg of command.replace(HEREDOC, "<<HEREDOC").split(SEGMENT_SPLIT)) {
		const m = CD.exec(seg.trim());
		if (m) return m[1]!;
	}
	return null;
}

/** One shell call in a session's action stream, with the text of its command. */
export interface ShellCall {
	/** The provider's tool-call id. */
	callId: string;
	/** The assistant message that issued the call. */
	messageId: string;
	/** The message that carried the result, or null when none was recorded. */
	resultMessageId: string | null;
	/** The raw command line. */
	command: string;
	/** The commands the line holds, with launchers dropped. */
	segments: string[];
	/** Whether the result recorded an error. */
	isError: boolean;
	/** The call's start and end, in epoch milliseconds, or null when untimed. */
	startMs: number | null;
	endMs: number | null;
	/** The call's duration in seconds, or null when untimed. */
	seconds: number | null;
}

/** Every shell call of a session, in stream order. */
export function shellCalls(messages: readonly MessageRow[], shellToolNames: readonly string[]): ShellCall[] {
	const times = new Map<string, number | null>();
	for (const m of messages) {
		const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
		times.set(m.id, Number.isNaN(ts) ? null : ts);
	}
	const names = shellToolNames.map((n) => n.toLowerCase());
	const out: ShellCall[] = [];
	for (const inv of buildToolStream([...messages]).invocations) {
		if (!names.includes(inv.name.toLowerCase())) continue;
		const command = inv.args["command"];
		if (typeof command !== "string" || command.trim() === "") continue;
		const start = times.get(inv.messageId) ?? null;
		const end = inv.outcome ? (times.get(inv.outcome.messageId) ?? null) : null;
		out.push({
			callId: inv.callId,
			messageId: inv.messageId,
			resultMessageId: inv.outcome?.messageId ?? null,
			command,
			segments: commandSegments(command),
			isError: inv.outcome?.isError ?? false,
			startMs: start,
			endMs: end,
			seconds: start !== null && end !== null && end >= start ? (end - start) / 1000 : null,
		});
	}
	return out;
}

/** The edit calls of a session, by the tool names that edit a file. */
export function editCallTimes(
	messages: readonly MessageRow[],
	editToolNames: readonly string[],
): number[] {
	const names = new Set(editToolNames.map((n) => n.toLowerCase()));
	const out: number[] = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !m.tool_calls) continue;
		const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
		if (Number.isNaN(ts)) continue;
		for (const name of parseCallNames(m.tool_calls)) {
			if (names.has(name)) out.push(ts);
		}
	}
	return out;
}

/** The tool names a stored assistant row called, lowercased. */
export function parseCallNames(json: string): string[] {
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		const names: string[] = [];
		for (const raw of parsed) {
			if (!raw || typeof raw !== "object") continue;
			const name = (raw as Record<string, unknown>)["name"];
			if (typeof name === "string") names.push(name.toLowerCase());
		}
		return names;
	} catch {
		return [];
	}
}
