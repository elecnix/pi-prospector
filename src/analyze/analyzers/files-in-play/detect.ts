/**
 * File-in-play extraction and churn detection (issue #103).
 *
 * Reads the session's action stream through the shared seam
 * (`src/analyze/tool-stream.ts`) — the same reconstruction every analyzer that
 * reads what the agent did uses, so "the Nth call" means one thing everywhere.
 *
 * Extraction: every tool call whose arguments name a file path becomes a
 * *file interaction* — an ordered (path, direction) event. Structured tools
 * carry their path in a named argument (`file_path` on Claude's normalized
 * shapes, `path` on Pi's); `bash` commands are tokenised quote-aware and their
 * redirect / `tee` / output-flag targets count as writes, other path-shaped
 * tokens as reads — the same convention dataprofiler's file-touch seam uses.
 *
 * The churn heuristic is deliberately simple and windowed:
 *
 *  1. Slide a window of `windowSize` consecutive interactions across the
 *     session's ordered interaction stream (step 1). Within a window, an
 *     interaction whose path was already touched earlier *in that window* is a
 *     repeat. A window whose repeat share reaches `churnRepeatRatio` is
 *     churning. Distant revisits do not co-occur in one window, so ordinary
 *     long-session re-reads stay quiet; tight read→edit→read cycling clears
 *     the ratio easily.
 *  2. Per file, count re-reads (a read of a file already read before) and
 *     edit→re-read cycles (a read of a file that was edited since its previous
 *     read) — the "no net progress" signal: the agent keeps re-establishing
 *     context instead of moving forward.
 *
 * `churn_score` is the fraction of windows classified as churning. A session
 * with at most one window of interactions is scored against that single
 * (possibly partial) window, so short sessions still get a measurement.
 * Everything here is pure and deterministic.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import {
	DEFAULT_FILES_IN_PLAY_CONFIG,
	type FilesInPlayConfig,
} from "./config.js";

/** The direction a tool call touched a file with. */
export type TouchDirection = "read" | "edit" | "write";

/** One ordered file interaction: a path, how it was touched, where it happened. */
export interface FileInteraction {
	path: string;
	direction: TouchDirection;
	tool: string;
	ordinal: number;
	messageId: string;
}

/** Structured tools whose job is reading files. */
const READ_TOOLS = new Set(["read", "view", "cat"]);
/** Structured tools whose job is creating whole files. */
const WRITE_TOOLS = new Set(["write", "create"]);
/** Structured tools that patch part of a file. */
const EDIT_TOOLS = new Set(["edit", "patch"]);

/** Structured-tool argument keys that may hold a file path, in priority order. */
const PATH_KEYS = ["file_path", "path", "filename", "file"] as const;

function pathFromArgs(args: Record<string, unknown>): string | null {
	for (const key of PATH_KEYS) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return null;
}

// ─────────────────────────── bash tokenisation ───────────────────────────

/** Bash output flags whose following token is a write target. */
const OUTPUT_FLAGS = new Set(["-o", "--output", "--out"]);

interface Token {
	text: string;
	/** True when produced by quote stripping (still a single token either way). */
	quoted: boolean;
}

/** Quote-aware whitespace tokenizer for bash command strings. */
function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let cur = "";
	let quoted = false;
	let hasContent = false;
	let inSingle = false;
	let inDouble = false;
	for (const ch of command) {
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			hasContent = true;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			hasContent = true;
			continue;
		}
		if (ch === " " && !inSingle && !inDouble) {
			if (hasContent || cur.length > 0) tokens.push({ text: cur, quoted: hasContent });
			cur = "";
			hasContent = false;
			continue;
		}
		cur += ch;
	}
	if (hasContent || cur.length > 0) tokens.push({ text: cur, quoted: hasContent });
	return tokens;
}

/**
 * Whether a bare token looks like a file path rather than a subcommand, flag
 * value, URL, or punctuation. Deliberately conservative: a slash anywhere
 * (absolute or relative paths), or a dotted final segment (`name.ext`,
 * `.env`, `archive.tar.gz`). Flags, URLs, operators, and bare words
 * (`test`, `build`) are rejected.
 */
export function looksLikePath(token: string): boolean {
	if (token.includes("://")) return false; // URLs, not files
	if (/^[|&;<>()]+$/.test(token)) return false; // shell operators
	if (token.includes("/")) return true;
	// Dotted final segment: something before the dot, a non-empty extension,
	// and no trailing dot. Dotfiles (`.env`) qualify; `1.` does not.
	return /^[^.].*\.[^.]+$/.test(token);
}

/** Strip trailing shell punctuation a path may drag along (`src/x.ts;`). */
function stripTrailingPunctuation(token: string): string {
	return token.replace(/[;,]+$/, "");
}

interface BashTarget {
	path: string;
	direction: TouchDirection;
}

/** Extract candidate path targets from a bash command, classified by direction. */
export function bashPathTargets(command: string): BashTarget[] {
	const targets: BashTarget[] = [];
	const tokens = tokenize(command);
	const base = tokens[0]?.text ?? "";
	const teeMode = base === "tee";

	let afterRedirect = false;
	let afterOutputFlag = false;
	let teePending = false;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		const t = tok.text;
		if (!tok.quoted && (t === ">" || t === ">>" || t === "&>" || t === ">|")) {
			afterRedirect = true;
			continue;
		}
		if (!tok.quoted && OUTPUT_FLAGS.has(t)) {
			afterOutputFlag = true;
			continue;
		}
		// A `tee` anywhere in a pipeline makes its next path argument a write.
		if (!tok.quoted && t === "tee") {
			teePending = true;
			continue;
		}
		if (t.includes(" ") || t.includes("\n")) continue; // heredoc bodies etc.
		const isWriteTarget = i > 0 && (afterRedirect || afterOutputFlag || teeMode || teePending);
		afterRedirect = false;
		afterOutputFlag = false;
		teePending = false;
		if (t.startsWith("-") && !isWriteTarget) continue; // flags and their values
		const candidate = stripTrailingPunctuation(t);
		if (!looksLikePath(candidate)) continue;
		targets.push({ path: candidate, direction: isWriteTarget ? "write" : "read" });
	}
	return targets;
}

// ─────────────────────────── extraction ───────────────────────────

/**
 * Extract every file interaction in a session's messages, in tool-stream
 * order. Pure and deterministic; a call naming several path-bearing arguments
 * yields one interaction (first matching key wins, the priority order above).
 */
export function extractFileInteractions(messages: readonly MessageRow[]): FileInteraction[] {
	const stream = buildToolStream([...messages]);
	const interactions: FileInteraction[] = [];

	function add(rawPath: string, direction: TouchDirection, inv: ToolInvocation): void {
		const path = rawPath.trim();
		if (path.length === 0) return;
		interactions.push({ path, direction, tool: inv.name, ordinal: inv.ordinal, messageId: inv.messageId });
	}

	for (const inv of stream.invocations) {
		if (inv.name === "bash") {
			const command = typeof inv.args["command"] === "string" ? inv.args["command"] : "";
			if (command.length === 0) continue;
			for (const target of bashPathTargets(command)) {
				add(target.path, target.direction, inv);
			}
			continue;
		}
		const path = pathFromArgs(inv.args);
		if (path === null) continue;
		const direction: TouchDirection = EDIT_TOOLS.has(inv.name)
			? "edit"
			: WRITE_TOOLS.has(inv.name)
				? "write"
				: READ_TOOLS.has(inv.name)
					? "read"
					: // Unknown structured tool carrying a path argument: judge by
						// nothing, treat as a read (the conservative direction).
						"read";
		add(path, direction, inv);
	}

	return interactions;
}

// ─────────────────────────── churn scan ───────────────────────────

/** Per-file handling counts, the raw material of the top-churned list. */
export interface FileStats {
	path: string;
	reads: number;
	edits: number;
	writes: number;
	/** Reads of this file that came after a previous read of it. */
	rereads: number;
	/** Read→edit→read cycles observed on this file. */
	cycles: number;
}

/**
 * Aggregate per-file counts for every touched file, ranked by churn weight
 * (rereads + cycles + edits, ties broken by path so the ranking is stable).
 * Session-level totals in {@link ChurnScan} are the sums over this list, so
 * there is exactly one place where an event becomes a count.
 */
export function fileStatistics(interactions: readonly FileInteraction[]): FileStats[] {
	interface State extends FileStats {
		pendingCycle: boolean;
	}
	const byPath = new Map<string, State>();
	for (const it of interactions) {
		let st = byPath.get(it.path);
		if (!st) {
			st = { path: it.path, reads: 0, edits: 0, writes: 0, rereads: 0, cycles: 0, pendingCycle: false };
			byPath.set(it.path, st);
		}
		if (it.direction === "edit") {
			st.edits++;
			if (st.reads > 0) st.pendingCycle = true;
		} else if (it.direction === "write") {
			// A whole-file rewrite re-establishes the content; it neither opens nor
			// continues a partial-edit cycle.
			st.writes++;
		} else {
			st.reads++;
			if (st.reads > 1) st.rereads++;
			if (st.pendingCycle) {
				st.cycles++;
				st.pendingCycle = false;
			}
		}
	}

	return [...byPath.values()]
		.sort((a, b) => (b.rereads + b.cycles + b.edits) - (a.rereads + a.cycles + a.edits) || (a.path < b.path ? -1 : 1))
		.map(({ pendingCycle: _pendingCycle, ...stats }) => stats);
}

/**
 * Evaluate one sliding window of interaction paths: an interaction hitting a
 * path already seen earlier *in this window* is a repeat; a window whose
 * repeat share reaches the configured ratio is churning. Exported pure so the
 * unit tests can pin the classification independently of the stream walk.
 */
export function isWindowChurning(paths: readonly string[], churnRepeatRatio: number): boolean {
	const seen = new Set<string>();
	let repeats = 0;
	for (const p of paths) {
		if (seen.has(p)) repeats++;
		else seen.add(p);
	}
	return paths.length > 0 && repeats / paths.length >= churnRepeatRatio;
}

export interface ChurnScan {
	/** All extracted interactions, in tool-stream order. */
	interactions: FileInteraction[];
	distinctFiles: number;
	readCount: number;
	editCount: number;
	writeCount: number;
	/** Total re-read events across all files. */
	rereadEvents: number;
	/** Total read→edit→read cycles across all files. */
	editRereadCycles: number;
	/** Number of windows evaluated (never zero while any interaction exists). */
	churnWindows: number;
	churningWindows: number;
	/** Fraction of evaluated windows classified as churning, 0–1. */
	churnScore: number;
	/** Top churned files: ranked by churn weight, capped at `maxTopFiles`. */
	topFiles: FileStats[];
}

/**
 * Message ids (in stream order, deduplicated) whose calls re-touched files
 * already in play: a re-read, or an edit opening a cycle on a previously-read
 * file. This is exactly the evidence a churn finding rests on — everything
 * else is first-touch traffic worth no anchor.
 */
export function churnRelevantMessageIds(interactions: readonly FileInteraction[]): string[] {
	const state = new Map<string, { reads: number; pendingCycle: boolean }>();
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const it of interactions) {
		let s = state.get(it.path);
		if (!s) {
			s = { reads: 0, pendingCycle: false };
			state.set(it.path, s);
		}
		if (it.direction === "write") continue;
		if (it.direction === "edit") {
			const opens = s.reads > 0;
			if (opens && !seen.has(it.messageId)) {
				seen.add(it.messageId);
				ids.push(it.messageId);
			}
			if (opens) s.pendingCycle = true;
		} else {
			const revisit = s.reads > 0 || s.pendingCycle;
			if (revisit && !seen.has(it.messageId)) {
				seen.add(it.messageId);
				ids.push(it.messageId);
			}
			s.reads++;
			s.pendingCycle = false;
		}
	}
	return ids;
}

/**
 * Detect churn over the session's file interactions. Pure and deterministic
 * over the message rows; see the module doc comment for the heuristic.
 */
export function scanSessionChurn(
	messages: readonly MessageRow[],
	config: FilesInPlayConfig = DEFAULT_FILES_IN_PLAY_CONFIG,
): ChurnScan {
	const interactions = extractFileInteractions(messages);

	let churnWindows = 0;
	let churningWindows = 0;

	function evaluateWindow(paths: readonly string[]): void {
		churnWindows++;
		if (isWindowChurning(paths, config.churnRepeatRatio)) churningWindows++;
	}

	const windowSize = config.windowSize;
	if (interactions.length <= windowSize) {
		// At most one window exists: evaluate it even if partial, so a short
		// session still carries a measurement instead of a silent zero.
		evaluateWindow(interactions.map((i) => i.path));
	} else {
		for (let start = 0; start + windowSize <= interactions.length; start++) {
			const windowPaths: string[] = [];
			for (let j = start; j < start + windowSize; j++) windowPaths.push(interactions[j]!.path);
			evaluateWindow(windowPaths);
		}
	}

	const allStats = fileStatistics(interactions);
	return {
		interactions,
		distinctFiles: allStats.length,
		readCount: allStats.reduce((acc, s) => acc + s.reads, 0),
		editCount: allStats.reduce((acc, s) => acc + s.edits, 0),
		writeCount: allStats.reduce((acc, s) => acc + s.writes, 0),
		rereadEvents: allStats.reduce((acc, s) => acc + s.rereads, 0),
		editRereadCycles: allStats.reduce((acc, s) => acc + s.cycles, 0),
		churnWindows,
		churningWindows,
		churnScore: churnWindows === 0 ? 0 : churningWindows / churnWindows,
		topFiles: allStats.slice(0, Math.max(1, config.maxTopFiles)),
	};
}

export { DEFAULT_FILES_IN_PLAY_CONFIG };
