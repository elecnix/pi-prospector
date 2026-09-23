/**
 * Navigation extraction and structural anti-pattern detection (issue #254).
 *
 * Graphectory (Chen et al., 2026, arXiv:2512.02393, §2.2/§3.4) separates the
 * *temporal* order of an agent's actions from their *structural* position in
 * the repository — directory ↦ file ↦ block — and names four localization
 * inefficiencies as mismatches between the two. This module reconstructs the
 * structural coordinate from a stored transcript (it does not build the full
 * graph) and detects those four patterns offline.
 *
 * Extraction reads the shared action stream (`src/analyze/tool-stream.ts`), so
 * "the Nth call" means one thing everywhere. Each call becomes at most a few
 * *navigation actions*:
 *
 *  - a **view** of a directory (`ls`, `find`, `glob`, `rg`/`grep` over a
 *    directory), a whole file (`read` with no range, `cat`), or a **block** — a
 *    bounded line range of a file (`read` with offset/limit, `sed -n 'A,Bp'`,
 *    `head -n N`);
 *  - an **edit** of a path (`edit`, `write`, a bash redirect/`tee`/`sed -i`
 *    target), carrying whether it succeeded.
 *
 * Every other call is not navigation and is ignored: running the tests between
 * two reads neither ends nor starts a navigation pattern.
 *
 * **Structural level.** A view's level is its path depth: the number of path
 * segments below the repository root (`.` is 0, `src` is 1, `src/a.ts` is 2),
 * plus one for a block. Transcripts do not carry the session's working
 * directory, so absolute paths are made relative to the longest directory
 * prefix all absolute navigated paths share, aligned with the relative paths
 * the session also used — a uniform shift, which leaves every depth
 * *difference* (all the detectors use) unchanged.
 *
 * Everything here is pure and deterministic.
 */

import { Type, type Static } from "typebox";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import type { MessageRow } from "../../types.js";
import { bashPathTargets } from "../files-in-play/detect.js";
import { readRangeFromArgs, readRangesOverlap, type ReadRange } from "../context-economy/index.js";
import {
	DEFAULT_NAVIGATION_EFFICIENCY_CONFIG,
	type NavigationEfficiencyConfig,
} from "./config.js";

// ─────────────────────────── shapes ───────────────────────────

/** One navigation action: a view of a structural region, or an edit of a path. */
export const NavAction = Type.Object({
	kind: Type.Union([Type.Literal("view"), Type.Literal("edit")]),
	/** What a view looked at. Edits are always `file`. */
	level: Type.Union([Type.Literal("dir"), Type.Literal("file"), Type.Literal("block")]),
	/** Normalised path, relative to the inferred root (`.` is the root itself). */
	path: Type.String(),
	/** Line range of a block view, [start, end); `end` is Infinity when unbounded. Whole files are [0, Infinity). */
	start: Type.Number(),
	end: Type.Number(),
	/** Structural level: path depth, plus one for a block. */
	depth: Type.Integer(),
	/** For edits: whether the tool reported success. Views are always true. */
	ok: Type.Boolean(),
	tool: Type.String(),
	/** Position of the issuing call in the session's tool-call stream. */
	ordinal: Type.Integer(),
	messageId: Type.String(),
});
export type NavAction = Static<typeof NavAction>;

export const NavPattern = Type.Union([
	Type.Literal("scroll"),
	Type.Literal("zoom_out"),
	Type.Literal("overly_deep_zoom"),
	Type.Literal("repeated_view"),
]);
export type NavPattern = Static<typeof NavPattern>;

/** One detected occurrence of a navigation anti-pattern. */
export const NavEpisode = Type.Object({
	pattern: NavPattern,
	/** The region the episode is about: the scrolled/zoomed/revisited path, or the directory backed out to. */
	path: Type.String(),
	/** How many views participate (slices, run length, or revisits). */
	views: Type.Integer(),
	/** For zoom_out: depth of the deep view, the shallow view, and the view that went back down. */
	depths: Type.Array(Type.Integer()),
	/** Tool-call ordinals that participate, in stream order. */
	ordinals: Type.Array(Type.Integer()),
	/** Messages that issued the participating calls, deduplicated, in stream order. */
	messageIds: Type.Array(Type.String()),
});
export type NavEpisode = Static<typeof NavEpisode>;

/** Graphectory's structural metrics over the set of viewed regions. */
export const StructuralMetrics = Type.Object({
	/** Distinct structural regions viewed (directories, files, blocks). */
	regions: Type.Integer(),
	/** Structural-edge count: viewed regions whose nearest viewed ancestor exists. */
	sec: Type.Integer(),
	/** Structural breadth: the most viewed children under any one viewed region. */
	sb: Type.Integer(),
	/** Deepest structural level viewed. */
	maxDepth: Type.Integer(),
});
export type StructuralMetrics = Static<typeof StructuralMetrics>;

export const NavigationScan = Type.Object({
	actions: Type.Array(NavAction),
	viewCount: Type.Integer(),
	editCount: Type.Integer(),
	metrics: StructuralMetrics,
	episodes: Type.Array(NavEpisode),
});
export type NavigationScan = Static<typeof NavigationScan>;

// ─────────────────────────── extraction ───────────────────────────

/** Structured tools that read a file, optionally a range of it. */
const READ_TOOLS = new Set(["read", "view", "cat"]);
/** Structured tools that list or search a directory (or a single file). */
const SEARCH_TOOLS = new Set(["ls", "find", "glob", "grep"]);
/** Structured tools that change a file. */
const EDIT_TOOLS = new Set(["edit", "write", "create", "patch", "notebookEdit"]);

/** Shell commands that list or search a directory tree. A bare invocation views the root. */
const BASH_DIR_COMMANDS = new Set(["ls", "tree", "find", "fd", "rg", "grep", "ag", "ack"]);
/** Shell commands that print a file's contents. */
const BASH_FILE_COMMANDS = new Set(["cat", "head", "tail", "sed", "less", "more", "bat", "nl"]);

/** A sed substitution or transliteration script: `s/a/b/g`, `2,5s|x|y|`, `y/ab/cd/`. */
const SED_SCRIPT = /^(?:\d+(?:,\d+)?)?[sy]([^\w\s]).*\1.*\1[a-zA-Z0-9]*$/;

const PATH_KEYS = ["file_path", "path", "filename", "file", "notebook_path"] as const;

function pathFromArgs(args: Record<string, unknown>): string | null {
	for (const key of PATH_KEYS) {
		const v = args[key];
		if (typeof v === "string" && v.trim().length > 0) return v.trim();
	}
	return null;
}

/**
 * Whether a path's final segment looks like a file name (`name.ext`, `.env`).
 * `.` and `..` are directories: neither pattern matches them, since both need
 * a non-dot character after the last dot.
 */
export function looksLikeFile(path: string): boolean {
	const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
	return /^[^.].*\.[^.]+$/.test(base) || /^\.[^.]+$/.test(base);
}

/** Split a shell command into simple-command segments on unquoted `&&`, `||`, `;`, and `|`. */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		if (!inSingle && !inDouble && (ch === ";" || ch === "|" || ch === "&" || ch === "\n")) {
			// `&` alone backgrounds a command; `&>` is a redirect, not a separator.
			if (ch === "&" && command[i + 1] === ">") {
				cur += ch;
				continue;
			}
			if (cur.trim()) segments.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) segments.push(cur.trim());
	return segments;
}

/** The line range a `sed -n 'A,Bp'` or `head -n N` segment prints, 1-based and half-open. */
function bashLineRange(base: string, segment: string): ReadRange | null {
	if (base === "sed") {
		const m = /-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?/.exec(segment);
		if (m) return { start: Number(m[1]), end: Number(m[2]) + 1 };
		return null;
	}
	if (base === "head") {
		const m = /(?:-n\s*|-)(\d+)\b/.exec(segment);
		if (m) return { start: 1, end: Number(m[1]) + 1 };
	}
	return null;
}

/** A raw action, before paths are normalised against the inferred root. */
type RawAction = Omit<NavAction, "depth">;

function bashActions(inv: ToolInvocation, command: string, ok: boolean): RawAction[] {
	const out: RawAction[] = [];
	const common = { tool: inv.name, ordinal: inv.ordinal, messageId: inv.messageId };
	for (const segment of splitShellSegments(command)) {
		const words = segment.split(/\s+/);
		// Skip env assignments and `sudo`-style wrappers to reach the command.
		let bi = 0;
		while (bi < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[bi]!) || words[bi] === "sudo")) bi++;
		const base = (words[bi] ?? "").replace(/^.*\//, "");
		const targets = bashPathTargets(words.slice(bi).join(" "));
		const inPlace = base === "sed" && /\s-i\b/.test(segment);

		for (const t of targets) {
			if (inPlace && SED_SCRIPT.test(t.path)) continue;
			if (t.direction === "write" || inPlace) {
				out.push({ kind: "edit", level: "file", path: t.path, start: 0, end: Infinity, ok, ...common });
			}
		}
		if (inPlace) continue;

		// A sed script (`s/a/b/`, `y/ab/cd/`) has slashes but is not a path.
		const reads = targets
			.filter((t) => t.direction === "read" && !(base === "sed" && SED_SCRIPT.test(t.path)))
			.map((t) => t.path);
		if (BASH_FILE_COMMANDS.has(base)) {
			const range = bashLineRange(base, segment);
			for (const path of reads) {
				if (range) out.push({ kind: "view", level: "block", path, start: range.start, end: range.end, ok: true, ...common });
				else out.push({ kind: "view", level: "file", path, start: 0, end: Infinity, ok: true, ...common });
			}
		} else if (BASH_DIR_COMMANDS.has(base)) {
			const paths = reads.length > 0 ? reads : ["."];
			for (const path of paths) {
				out.push({ kind: "view", level: looksLikeFile(path) ? "file" : "dir", path, start: 0, end: Infinity, ok: true, ...common });
			}
		}
	}
	return out;
}

function structuredActions(inv: ToolInvocation, ok: boolean): RawAction[] {
	const common = { tool: inv.name, ordinal: inv.ordinal, messageId: inv.messageId };
	const path = pathFromArgs(inv.args);
	if (EDIT_TOOLS.has(inv.name)) {
		return path === null ? [] : [{ kind: "edit", level: "file", path, start: 0, end: Infinity, ok, ...common }];
	}
	if (READ_TOOLS.has(inv.name)) {
		if (path === null) return [];
		const range = readRangeFromArgs(inv.args);
		const bounded = range.start > 0 || range.end !== Infinity;
		return [{ kind: "view", level: bounded ? "block" : "file", path, start: range.start, end: range.end, ok: true, ...common }];
	}
	if (SEARCH_TOOLS.has(inv.name)) {
		const target = path ?? ".";
		return [{ kind: "view", level: looksLikeFile(target) ? "file" : "dir", path: target, start: 0, end: Infinity, ok: true, ...common }];
	}
	return [];
}

/** Lexical normalisation: collapse `./`, duplicate and trailing slashes, and `..` segments. */
function cleanPath(path: string): string {
	const absolute = path.startsWith("/");
	const parts: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
		else parts.push(seg);
	}
	const joined = parts.join("/");
	return absolute ? `/${joined}` : joined || ".";
}

/**
 * The root absolute paths are made relative to: the longest directory prefix
 * they all share, backed up to just above a segment some relative path starts
 * with (`/repo/src/x.ts` beside `src/y.ts` roots at `/repo`, so both land on
 * the same `src`). Null when there are no absolute paths.
 */
function inferRoot(paths: readonly { path: string; isDir: boolean }[]): string | null {
	const root = commonAbsoluteRoot(paths);
	if (root === null) return null;
	const heads = new Set(paths.filter((p) => !p.path.startsWith("/") && p.path !== ".").map((p) => p.path.split("/")[0]!));
	const segs = root.split("/").filter(Boolean);
	for (let i = segs.length - 1; i >= 0; i--) {
		if (heads.has(segs[i]!)) return `/${segs.slice(0, i).join("/")}`;
	}
	return root;
}

/** The longest directory prefix shared by every absolute path, or null when there are none. */
function commonAbsoluteRoot(paths: readonly { path: string; isDir: boolean }[]): string | null {
	let root: string[] | null = null;
	for (const { path, isDir } of paths) {
		if (!path.startsWith("/")) continue;
		const segs = path.split("/").filter(Boolean);
		const dirSegs = isDir ? segs : segs.slice(0, -1);
		if (root === null) {
			root = dirSegs;
			continue;
		}
		let i = 0;
		while (i < root.length && i < dirSegs.length && root[i] === dirSegs[i]) i++;
		root = root.slice(0, i);
	}
	return root === null ? null : `/${root.join("/")}`;
}

function depthOf(path: string): number {
	return path === "." ? 0 : path.split("/").length;
}

/**
 * Extract every navigation action in a session, in tool-stream order. A call
 * that names several targets (`cat a.ts b.ts`) yields one action per target.
 */
export function extractNavigation(messages: readonly MessageRow[]): NavAction[] {
	const stream = buildToolStream([...messages]);
	const raw: RawAction[] = [];
	for (const inv of stream.invocations) {
		const ok = inv.outcome === null ? true : !inv.outcome.isError;
		if (inv.name === "bash") {
			const command = typeof inv.args["command"] === "string" ? inv.args["command"] : "";
			if (command.length > 0) raw.push(...bashActions(inv, command, ok));
			continue;
		}
		raw.push(...structuredActions(inv, ok));
	}

	const cleaned = raw
		.map((a) => ({ ...a, path: cleanPath(a.path) }))
		// Whitespace means a heredoc body or a glob the tokenizer could not split — not a path.
		.filter((a) => !/\s/.test(a.path));
	const root = inferRoot(cleaned.map((a) => ({ path: a.path, isDir: a.level === "dir" })));
	return cleaned.map((a) => {
		let path = a.path;
		if (root !== null && path.startsWith("/")) {
			if (path === root) path = ".";
			else if (root === "/") path = path.slice(1);
			else if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
		}
		return { ...a, path, depth: depthOf(path) + (a.level === "block" ? 1 : 0) };
	});
}

// ─────────────────────────── structure helpers ───────────────────────────

/** Whether `dir` is a proper ancestor directory of `path`. */
export function isAncestor(dir: string, path: string): boolean {
	if (dir === path) return false;
	return dir === "." ? path !== "." : path.startsWith(`${dir}/`);
}

/** The directory holding a path: `.` for a top-level name, `/` for a child of the filesystem root. */
function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	if (i < 0) return ".";
	return i === 0 ? "/" : path.slice(0, i);
}

/** The directory a view sits in: the directory itself, or a file's (or block's) parent. */
function containerDir(a: NavAction): string {
	return a.level === "dir" ? a.path : parentDir(a.path);
}

/** Two views look at the same structural region: one directory, or overlapping ranges of one file. */
export function sameRegion(a: NavAction, b: NavAction): boolean {
	if (a.path !== b.path) return false;
	if (a.level === "dir" || b.level === "dir") return a.level === b.level;
	return readRangesOverlap(a, b);
}

/** Overlap of two bounded ranges as a fraction of the shorter one; 0 when either is unbounded. */
export function sliceOverlap(a: ReadRange, b: ReadRange): number {
	if (!Number.isFinite(a.end) || !Number.isFinite(b.end)) return 0;
	const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
	const shorter = Math.min(a.end - a.start, b.end - b.start);
	return overlap <= 0 || shorter <= 0 ? 0 : overlap / shorter;
}

function episode(pattern: NavPattern, path: string, parts: readonly NavAction[], depths: number[] = []): NavEpisode {
	const messageIds: string[] = [];
	for (const p of parts) if (!messageIds.includes(p.messageId)) messageIds.push(p.messageId);
	return { pattern, path, views: parts.length, depths, ordinals: parts.map((p) => p.ordinal), messageIds };
}

// ─────────────────────────── detectors ───────────────────────────

/**
 * Scroll: consecutive bounded slices of one file, each overlapping the one
 * before it by at least `scrollOverlap` of the shorter slice, and not merely
 * repeating it. Consecutive means no view of anything else and no edit in
 * between. Disjoint pagination never overlaps, so it is not scrolling.
 */
export function detectScroll(actions: readonly NavAction[], config: NavigationEfficiencyConfig): NavEpisode[] {
	const out: NavEpisode[] = [];
	let run: NavAction[] = [];
	const flush = (): void => {
		if (run.length >= config.scrollMinSlices) out.push(episode("scroll", run[0]!.path, run));
		run = [];
	};
	for (const a of actions) {
		if (a.kind !== "view" || a.level !== "block") {
			flush();
			continue;
		}
		const prev = run[run.length - 1];
		const identical = prev !== undefined && prev.start === a.start && prev.end === a.end;
		if (prev && prev.path === a.path && !identical && sliceOverlap(prev, a) >= config.scrollOverlap) {
			run.push(a);
			continue;
		}
		flush();
		run = [a];
	}
	flush();
	return out;
}

/**
 * ZoomOut: temporal order contradicting the hierarchy — deep, then shallow,
 * then deep again, with no edit in between. A view backs out when it sits at
 * least `zoomOutDepthDelta` levels above the deepest view of the current
 * descent and its directory is an ancestor of that view (the agent climbed back
 * up the branch it had just explored). The episode completes when a later view
 * descends at least `zoomOutDepthDelta` levels below the shallow one again. An
 * edit ends the descent: navigating after acting is a new search, not a retreat.
 */
export function detectZoomOut(actions: readonly NavAction[], config: NavigationEfficiencyConfig): NavEpisode[] {
	const out: NavEpisode[] = [];
	const delta = config.zoomOutDepthDelta;
	let deepest: NavAction | null = null;
	let shallow: NavAction | null = null;
	for (const a of actions) {
		if (a.kind === "edit") {
			deepest = null;
			shallow = null;
			continue;
		}
		if (deepest && shallow) {
			if (a.depth >= shallow.depth + delta) {
				out.push(episode("zoom_out", containerDir(shallow), [deepest, shallow, a], [deepest.depth, shallow.depth, a.depth]));
				deepest = a;
				shallow = null;
			} else if (a.depth < shallow.depth && isAncestor(containerDir(a), deepest.path)) {
				shallow = a;
			}
			continue;
		}
		if (deepest && a.depth <= deepest.depth - delta && isAncestor(containerDir(a), deepest.path)) {
			shallow = a;
			continue;
		}
		if (!deepest || a.depth >= deepest.depth) deepest = a;
	}
	return out;
}

/**
 * OverlyDeepZoom: an uninterrupted run of at least `viewOnlyRunLen` views of
 * one path with no edit on that path (or, for a directory, anywhere under it)
 * at any later point — the agent kept looking and never converged on where to
 * patch. Only a session that edits something is judged: a session that never
 * edits anything was not trying to patch, and reading is its whole job.
 */
export function detectOverlyDeepZoom(actions: readonly NavAction[], config: NavigationEfficiencyConfig): NavEpisode[] {
	const edits = actions.filter((a) => a.kind === "edit");
	if (edits.length === 0) return [];
	const out: NavEpisode[] = [];
	let run: NavAction[] = [];
	let runEnd = 0;
	const flush = (): void => {
		const head = run[0];
		if (head && run.length >= config.viewOnlyRunLen) {
			const editedLater = actions
				.slice(runEnd)
				.some((a) => a.kind === "edit" && (a.path === head.path || isAncestor(head.path, a.path)));
			if (!editedLater) out.push(episode("overly_deep_zoom", head.path, run));
		}
		run = [];
	};
	actions.forEach((a, i) => {
		if (a.kind === "view" && run[0]?.path === a.path) {
			run.push(a);
			runEnd = i + 1;
			return;
		}
		flush();
		if (a.kind === "view") {
			run = [a];
			runEnd = i + 1;
		}
	});
	flush();
	return out;
}

/**
 * RepeatedView: returning to a region already viewed after having left it — an
 * intervening view of a different region, or an edit. Re-reading a
 * file right after a *successful* edit to it is verification, not a revisit;
 * after a *failed* edit it counts, since that is exactly the paper's "failed
 * edit or incomplete localization". A region revisited at least
 * `structuralRevisitMin` times is one episode.
 */
export function detectRepeatedView(actions: readonly NavAction[], config: NavigationEfficiencyConfig): NavEpisode[] {
	const revisits = new Map<string, NavAction[]>();
	const order: string[] = [];
	const views: Array<{ action: NavAction; index: number }> = [];
	actions.forEach((a, index) => {
		if (a.kind !== "view") return;
		let prior: { action: NavAction; index: number } | undefined;
		for (let j = views.length - 1; j >= 0; j--) {
			if (sameRegion(views[j]!.action, a)) {
				prior = views[j];
				break;
			}
		}
		views.push({ action: a, index });
		if (!prior) return;
		const between = actions.slice(prior.index + 1, index);
		// Any edit leaves the reading context; a successful one to this very file is excluded below.
		const left = between.some((b) => b.kind === "edit" || !sameRegion(b, a));
		const verified = between.some((b) => b.kind === "edit" && b.ok && b.path === a.path);
		if (!left || verified) return;
		let list = revisits.get(a.path);
		if (!list) {
			list = [prior.action];
			revisits.set(a.path, list);
			order.push(a.path);
		}
		list.push(a);
	});
	const out: NavEpisode[] = [];
	for (const path of order) {
		const list = revisits.get(path)!;
		// The first entry is the original view; the rest are the returns.
		if (list.length - 1 >= config.structuralRevisitMin) out.push(episode("repeated_view", path, list));
	}
	return out;
}

// ─────────────────────────── structural metrics ───────────────────────────

/**
 * Structural-edge count (SEC) and structural breadth (SB) over the viewed
 * regions. The regions form a subsumption tree — a block under its file, a
 * file or directory under its directory. A structural edge joins a viewed
 * region to its nearest viewed ancestor; SEC counts them, and SB is the largest
 * number of viewed regions hanging directly under one viewed region. SB > 1
 * means the agent explored more than one sibling beneath a region it had
 * itself opened before converging.
 */
export function structuralMetrics(actions: readonly NavAction[]): StructuralMetrics {
	const regions = new Map<string, { key: string; path: string; level: NavAction["level"]; depth: number }>();
	for (const a of actions) {
		if (a.kind !== "view") continue;
		const key = a.level === "block" ? `${a.path}#${a.start}-${a.end}` : a.level === "dir" ? `${a.path}/` : a.path;
		if (!regions.has(key)) regions.set(key, { key, path: a.path, level: a.level, depth: a.depth });
	}
	const all = [...regions.values()];
	const children = new Map<string, number>();
	let sec = 0;
	for (const r of all) {
		let parent: string | null = null;
		if (r.level === "block" && regions.has(r.path)) parent = r.path;
		// Otherwise the nearest viewed ancestor directory, walking up to the root.
		let dir = r.path === "." || r.path === "/" ? null : parentDir(r.path);
		while (parent === null && dir !== null) {
			if (regions.has(`${dir}/`)) parent = `${dir}/`;
			else dir = dir === "." || dir === "/" ? null : parentDir(dir);
		}
		if (parent === null) continue;
		sec++;
		children.set(parent, (children.get(parent) ?? 0) + 1);
	}
	return {
		regions: all.length,
		sec,
		sb: Math.max(0, ...children.values()),
		maxDepth: Math.max(0, ...all.map((r) => r.depth)),
	};
}

// ─────────────────────────── scan ───────────────────────────

/** Run every detector over a session's navigation. Pure and deterministic. */
export function scanNavigation(
	messages: readonly MessageRow[],
	config: NavigationEfficiencyConfig = DEFAULT_NAVIGATION_EFFICIENCY_CONFIG,
): NavigationScan {
	const actions = extractNavigation(messages);
	return {
		actions,
		viewCount: actions.filter((a) => a.kind === "view").length,
		editCount: actions.filter((a) => a.kind === "edit").length,
		metrics: structuralMetrics(actions),
		episodes: [
			...detectScroll(actions, config),
			...detectZoomOut(actions, config),
			...detectOverlyDeepZoom(actions, config),
			...detectRepeatedView(actions, config),
		],
	};
}
