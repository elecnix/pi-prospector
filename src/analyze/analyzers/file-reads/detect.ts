/**
 * File reads: extraction per session, and the read-time fold into a graph per
 * repository.
 *
 * Extraction reads the session's action stream through the same seam as
 * files-in-play (`extractFileInteractions`), so "a read" means the same thing in
 * both. Only reads are graphed; edits are kept as a set of paths, so the report
 * can tell reference material (read in many sessions, rarely edited) from working
 * code (read and edited).
 *
 * Paths are made relative to the session's working directory, because that is
 * the only base the transcript records and it lines worktrees of one repository
 * up with each other. A path outside the working directory is kept but marked,
 * and the graph leaves it out.
 *
 * Everything here is pure and deterministic.
 */

import * as path from "node:path";
import { Type, type Static } from "typebox";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import type { MessageRow } from "../../types.js";
import { extractFileInteractions } from "../files-in-play/detect.js";
import type { FileReadsConfig } from "./config.js";

// ─────────────────────────── extraction ───────────────────────────

export const FileRead = Type.Object({
	/** Relative to the working directory when inside it; as written otherwise. */
	path: Type.String(),
	/** False for a path outside the working directory (a home-directory file, `../x`). */
	in_repo: Type.Boolean(),
	/** Position of the file among the session's distinct files, in first-read order, from 1. */
	rank: Type.Number(),
	/** The call's position in the session's tool-call stream. */
	ordinal: Type.Number(),
	tool: Type.String(),
	/** Characters the read returned, or null when unknown (no result, or a bash call that read several files). */
	chars: Type.Union([Type.Number(), Type.Null()]),
	/** True when the read asked for part of the file (an offset or limit, `sed -n`, `head`, `tail`). */
	ranged: Type.Boolean(),
	message_id: Type.String(),
});
export type FileRead = Static<typeof FileRead>;

export const SessionFileReads = Type.Object({
	reads: Type.Array(FileRead),
	/** Distinct in-repo paths the session edited or wrote. */
	edited: Type.Array(Type.String()),
});
export type SessionFileReads = Static<typeof SessionFileReads>;

/** Structured-tool argument keys that ask for part of a file. */
const RANGE_KEYS = ["offset", "limit", "view_range", "start_line", "end_line", "line_start", "line_end"];
/** Bash commands that print part of a file. */
const RANGED_BASH = new Set(["head", "tail", "sed"]);
/** Bash commands whose path arguments are files they read. */
const READING_BASH = new Set(["cat", "less", "more", "bat", "head", "tail", "sed", "nl", "wc", "jq", "yq"]);
/** File names with no extension that are still files. */
const EXTENSIONLESS = new Set(["Makefile", "Dockerfile", "LICENSE", "README", "Gemfile", "Rakefile", "Procfile", "Justfile", "Containerfile"]);

/** Whether a bash token names a file rather than a directory, a glob or a flag. */
function bashTokenIsFile(token: string): boolean {
	if (token.startsWith("-") || /[*?{}[\]$]/.test(token)) return false;
	const base = token.replace(/\/+$/, "").split("/").pop() ?? "";
	if (token.endsWith("/") || base.length === 0) return false;
	return EXTENSIONLESS.has(base) || /^[^.].*\.[A-Za-z0-9]+$/.test(base) || /^\.[A-Za-z0-9][\w.-]*$/.test(base);
}

/**
 * The path relative to `cwd` when it lies inside it. A path that leaves the
 * working directory, or an absolute path when the directory is unknown, is kept
 * as written and marked outside.
 */
export function normaliseReadPath(raw: string, cwd: string): { path: string; inRepo: boolean } {
	const trimmed = raw.trim().replace(/^["']|["']$/g, "");
	if (trimmed.startsWith("~")) return { path: trimmed, inRepo: false };
	if (path.posix.isAbsolute(trimmed)) {
		const normalised = path.posix.normalize(trimmed);
		if (cwd && path.posix.isAbsolute(cwd)) {
			const rel = path.posix.relative(path.posix.normalize(cwd), normalised);
			if (rel.length > 0 && !rel.startsWith("..") && !path.posix.isAbsolute(rel)) return { path: rel, inRepo: true };
		}
		return { path: normalised, inRepo: false };
	}
	const rel = path.posix.normalize(trimmed).replace(/^\.\//, "");
	if (rel === ".." || rel.startsWith("../")) return { path: rel, inRepo: false };
	return { path: rel, inRepo: true };
}

/**
 * How many files a simple file-printing command names, counted from its own
 * arguments rather than from the extracted paths (which skip names such as
 * `Makefile`). Any pipe, chain or redirect makes the output more than one file's
 * text, so it counts as unknown (-1). `sed`'s first operand is its script.
 */
function bashFileArgCount(inv: ToolInvocation): number {
	const command = typeof inv.args["command"] === "string" ? inv.args["command"] : "";
	if (/[|;&><`]|\$\(/.test(command)) return -1;
	const [base, ...rest] = command.trim().split(/\s+/);
	const operands = rest.filter((t) => !t.startsWith("-"));
	if (base === "sed") operands.shift();
	return operands.length;
}

function bashBase(inv: ToolInvocation): string {
	const command = typeof inv.args["command"] === "string" ? inv.args["command"] : "";
	return command.trim().split(/\s+/)[0] ?? "";
}

/** The session's reads in order, and the files it edited. */
export function extractReads(messages: readonly MessageRow[], cwd: string): SessionFileReads {
	const byOrdinal = new Map<number, ToolInvocation>(buildToolStream([...messages]).invocations.map((inv) => [inv.ordinal, inv]));
	const interactions = extractFileInteractions(messages);

	const reads: FileRead[] = [];
	const edited = new Set<string>();
	const rankOf = new Map<string, number>();
	for (const i of interactions) {
		const inv = byOrdinal.get(i.ordinal);
		if (!inv) throw new Error(`file-reads: interaction at ordinal ${i.ordinal} has no tool call in the stream`);
		const { path: p, inRepo } = normaliseReadPath(i.path, cwd);
		if (i.direction !== "read") {
			if (inRepo) edited.add(p);
			continue;
		}
		let ranged: boolean;
		let chars: number | null = inv.outcome ? inv.outcome.textLength : null;
		if (i.tool === "bash") {
			const base = bashBase(inv);
			// A path token in `grep -rn x src` or `ls docs` is a search scope, not a file read.
			if (!READING_BASH.has(base) || !bashTokenIsFile(i.path)) continue;
			ranged = RANGED_BASH.has(base);
			// The result is one text for everything the command printed, so its size
			// belongs to this file only when the command printed exactly one file.
			if (bashFileArgCount(inv) !== 1) chars = null;
		} else {
			ranged = RANGE_KEYS.some((k) => inv.args[k] !== undefined && inv.args[k] !== null);
		}
		if (!rankOf.has(p)) rankOf.set(p, rankOf.size + 1);
		reads.push({ path: p, in_repo: inRepo, rank: rankOf.get(p)!, ordinal: i.ordinal, tool: i.tool, chars, ranged, message_id: i.messageId });
	}
	return { reads, edited: [...edited].sort() };
}

// ─────────────────────────── the fold ───────────────────────────

/** The virtual node every session's read path starts from. */
export const SESSION_ROOT = "(session start)";

export const SessionInput = Type.Object({
	sessionId: Type.String(),
	repo: Type.String(),
	reads: Type.Array(FileRead),
	edited: Type.Array(Type.String()),
});
export type SessionInput = Static<typeof SessionInput>;

export const FileNode = Type.Object({
	repo: Type.String(),
	path: Type.String(),
	/** Sessions that read the file at least once. */
	sessions: Type.Number(),
	/** Reads of the file across all sessions, re-reads included. */
	reads: Type.Number(),
	/** Sessions whose first file it was. */
	first_sessions: Type.Number(),
	/** Sessions that read it among their first `openingReads` distinct files. */
	opening_sessions: Type.Number(),
	/** Median of its first-read rank across the sessions that read it. */
	median_rank: Type.Number(),
	/** Median characters of a session's first sized read of it; null when no read was sized. */
	median_chars: Type.Union([Type.Number(), Type.Null()]),
	/** Share of its reads that asked for the whole file. */
	full_read_share: Type.Number(),
	/** Sessions that edited or wrote it. */
	edited_sessions: Type.Number(),
});
export type FileNode = Static<typeof FileNode>;

export const ReadEdge = Type.Object({
	repo: Type.String(),
	from: Type.String(),
	to: Type.String(),
	/** Sessions in which this transition happened at least once. */
	sessions: Type.Number(),
	/** Times it happened across all sessions. */
	transitions: Type.Number(),
});
export type ReadEdge = Static<typeof ReadEdge>;

export const RepoGraph = Type.Object({
	repo: Type.String(),
	/** Sessions in the repository, including those that read no in-repo file. */
	sessions: Type.Number(),
	files: Type.Array(FileNode),
	edges: Type.Array(ReadEdge),
	/** Reads of paths outside the working directory, left out of the graph. */
	outside_reads: Type.Number(),
});
export type RepoGraph = Static<typeof RepoGraph>;

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Fold sessions into one read graph per repository, largest repository first. */
export function foldReadGraphs(sessions: readonly SessionInput[], config: FileReadsConfig): RepoGraph[] {
	const byRepo = new Map<string, SessionInput[]>();
	for (const s of sessions) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s]);

	const graphs: RepoGraph[] = [];
	for (const [repo, repoSessions] of byRepo) {
		const files = new Map<string, { sessions: Set<string>; reads: number; first: number; opening: number; ranks: number[]; chars: number[]; full: number; edited: number }>();
		const edges = new Map<string, { from: string; to: string; sessions: Set<string>; transitions: number }>();
		let outside = 0;

		for (const s of repoSessions) {
			const inRepo = s.reads.filter((r) => r.in_repo);
			outside += s.reads.length - inRepo.length;
			// Ranks among in-repo files only, so an early read of a home-directory file
			// does not push the repository's first file to second place.
			const rank = new Map<string, number>();
			const sized = new Set<string>();
			for (const r of inRepo) {
				if (!rank.has(r.path)) rank.set(r.path, rank.size + 1);
				let f = files.get(r.path);
				if (!f) {
					f = { sessions: new Set(), reads: 0, first: 0, opening: 0, ranks: [], chars: [], full: 0, edited: 0 };
					files.set(r.path, f);
				}
				f.reads++;
				if (!r.ranged) f.full++;
				if (!f.sessions.has(s.sessionId)) {
					f.sessions.add(s.sessionId);
					const k = rank.get(r.path)!;
					f.ranks.push(k);
					if (k === 1) f.first++;
					if (k <= config.openingReads) f.opening++;
				}
				if (r.chars !== null && !sized.has(r.path)) {
					sized.add(r.path);
					f.chars.push(r.chars);
				}
			}
			for (const p of s.edited) {
				const f = files.get(p);
				if (f) f.edited++;
			}

			let prev = SESSION_ROOT;
			for (const r of inRepo) {
				if (r.path === prev) continue;
				const key = `${prev}\u0000${r.path}`;
				let e = edges.get(key);
				if (!e) {
					e = { from: prev, to: r.path, sessions: new Set(), transitions: 0 };
					edges.set(key, e);
				}
				e.transitions++;
				e.sessions.add(s.sessionId);
				prev = r.path;
			}
		}

		graphs.push({
			repo,
			sessions: repoSessions.length,
			outside_reads: outside,
			files: [...files.entries()]
				.map(([p, f]) => ({
					repo,
					path: p,
					sessions: f.sessions.size,
					reads: f.reads,
					first_sessions: f.first,
					opening_sessions: f.opening,
					median_rank: median(f.ranks)!,
					median_chars: median(f.chars),
					full_read_share: f.reads === 0 ? 0 : f.full / f.reads,
					edited_sessions: f.edited,
				}))
				.sort((a, b) => b.sessions - a.sessions || b.reads - a.reads || a.path.localeCompare(b.path)),
			edges: [...edges.values()]
				.map((e) => ({ repo, from: e.from, to: e.to, sessions: e.sessions.size, transitions: e.transitions }))
				.sort((a, b) => b.sessions - a.sessions || b.transitions - a.transitions || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
		});
	}
	return graphs.sort((a, b) => b.sessions - a.sessions || a.repo.localeCompare(b.repo));
}

// ─────────────────────────── leads ───────────────────────────

export const Leads = Type.Object({
	/** Files many sessions open on: candidates for a summary or map in the instruction file. */
	orientation: Type.Array(FileNode),
	/** Large files read across sessions: candidates for splitting or an index. */
	large: Type.Array(FileNode),
	/** File pairs read one after the other across sessions: candidates for a cross-link or co-location. */
	paths: Type.Array(ReadEdge),
});
export type Leads = Static<typeof Leads>;

export function leadsFor(graph: RepoGraph, config: FileReadsConfig): Leads {
	const orientation = graph.files
		.filter((f) => f.opening_sessions >= config.minSessions && f.opening_sessions / graph.sessions >= config.minOpeningShare)
		.sort((a, b) => b.opening_sessions - a.opening_sessions || a.median_rank - b.median_rank || a.path.localeCompare(b.path))
		.slice(0, config.maxLeads);
	const large = graph.files
		.filter((f) => f.sessions >= config.minSessions && f.median_chars !== null && f.median_chars >= config.largeFileChars)
		.sort((a, b) => b.sessions * (b.median_chars ?? 0) - a.sessions * (a.median_chars ?? 0) || a.path.localeCompare(b.path))
		.slice(0, config.maxLeads);
	const paths = graph.edges.filter((e) => e.from !== SESSION_ROOT && e.sessions >= config.minSessions).slice(0, config.maxLeads);
	return { orientation, large, paths };
}

// ─────────────────────────── rendering ───────────────────────────

function csvCell(v: string | number | null): string {
	if (v === null) return "";
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function filesCsv(graphs: readonly RepoGraph[]): string {
	const header = "repo,path,sessions,reads,first_sessions,opening_sessions,median_rank,median_chars,full_read_share,edited_sessions";
	const rows = graphs.flatMap((g) =>
		g.files.map((f) =>
			[f.repo, f.path, f.sessions, f.reads, f.first_sessions, f.opening_sessions, f.median_rank, f.median_chars, f.full_read_share.toFixed(2), f.edited_sessions].map(csvCell).join(","),
		),
	);
	return [header, ...rows].join("\n") + "\n";
}

export function edgesCsv(graphs: readonly RepoGraph[]): string {
	const header = "repo,from,to,sessions,transitions";
	const rows = graphs.flatMap((g) => g.edges.map((e) => [e.repo, e.from, e.to, e.sessions, e.transitions].map(csvCell).join(",")));
	return [header, ...rows].join("\n") + "\n";
}

/** Mermaid flowchart of a repository's strongest edges, the session root first. */
export function mermaidGraph(graph: RepoGraph, maxEdges: number): string {
	const edges = graph.edges.slice(0, maxEdges);
	const ids = new Map<string, string>([[SESSION_ROOT, "root"]]);
	const id = (p: string): string => {
		if (!ids.has(p)) ids.set(p, `f${ids.size}`);
		return ids.get(p)!;
	};
	const sessionsOf = new Map(graph.files.map((f) => [f.path, f.sessions]));
	const label = (p: string): string => (p === SESSION_ROOT ? "session start" : `${p} · ${plural(sessionsOf.get(p) ?? 0, "session")}`).replace(/"/g, "'");
	const lines = ["flowchart LR", `  root(("${label(SESSION_ROOT)}"))`];
	for (const e of edges) {
		for (const p of [e.from, e.to]) {
			if (!ids.has(p)) lines.push(`  ${id(p)}["${label(p)}"]`);
		}
		lines.push(`  ${id(e.from)} -->|${e.sessions}| ${id(e.to)}`);
	}
	return lines.join("\n");
}

/**
 * A root instruction file the harness loads at session start: `AGENTS.md` (Pi,
 * Codex), `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` (Claude Code).
 * A nested one is left out, because not every harness loads it up front.
 */
export function isLoadedInstructionFile(p: string): boolean {
	return ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"].includes(p);
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function tokens(chars: number | null, config: FileReadsConfig): string {
	return chars === null ? "unknown" : `~${Math.round(chars / config.charsPerToken).toLocaleString("en-US")}`;
}

export function reportMarkdown(graphs: readonly RepoGraph[], config: FileReadsConfig): string {
	const out: string[] = [
		"# File reads by repository",
		"",
		"Each session starts at a virtual root; an edge goes from each file to the next distinct file the session read, and the label is the number of sessions that took it. Reads outside the session's working directory are left out.",
		"",
		"The leads below are computed when this report is rendered. They are not proposals, and their token figures are upper bounds: they assume every listed read could be avoided, and ignore what a summary or index would cost to read.",
	];
	for (const g of graphs) {
		const leads = leadsFor(g, config);
		out.push("", `## ${g.repo}`, "", `${plural(g.sessions, "session")}, ${plural(g.files.length, "file")} read in the repository, ${plural(g.outside_reads, "read")} outside it.`);
		if (g.edges.length > 0) out.push("", "```mermaid", mermaidGraph(g, config.maxGraphEdges), "```");

		out.push("", "### Files sessions open on (documentation)");
		if (leads.orientation.length === 0) out.push("", "None reached the thresholds.");
		for (const f of leads.orientation) {
			const share = Math.round((100 * f.opening_sessions) / g.sessions);
			const opening = `among the first ${config.openingReads} files in ${f.opening_sessions} of ${g.sessions} sessions (${share}%), first in ${f.first_sessions}. A read costs ${tokens(f.median_chars, config)} tokens.`;
			const total = tokens(f.median_chars === null ? null : f.median_chars * f.opening_sessions, config);
			if (isLoadedInstructionFile(f.path)) {
				// The harness already put this file in the context, so the lead is the re-read itself.
				out.push(
					"",
					`- \`${f.path}\`: ${opening} The harness whose file this is loads it at session start, so a session that also reads it pays for it twice: up to ${total} tokens across these sessions. Look for what sends agents to re-read it, such as a skill or prompt that says to, or a compaction that dropped it.`,
				);
				continue;
			}
			const stable = f.edited_sessions === 0 ? "never edited, so a summary of it would stay current" : `edited in ${plural(f.edited_sessions, "session")}, so a summary of it would need upkeep`;
			out.push(
				"",
				`- \`${f.path}\`: ${opening} It is ${stable}. If agents read it to orient themselves, a short summary or a map in the instruction file could replace the read: up to ${total} tokens across these sessions.`,
			);
		}

		out.push("", "### Large files read across sessions (refactoring)");
		if (leads.large.length === 0) out.push("", "None reached the thresholds.");
		for (const f of leads.large) {
			const full = Math.round(100 * f.full_read_share);
			out.push(
				"",
				`- \`${f.path}\`: read in ${f.sessions} sessions, ${tokens(f.median_chars, config)} tokens per read, ${full}% of reads whole. ${full >= 50 ? "Most reads take the whole file: splitting it, or an index at the top that lets a ranged read suffice, would shrink each of them." : "Most reads are already ranged; the cost is in how often it is opened, not how much of it."}`,
			);
		}

		out.push("", "### Files read one after the other (cross-links)");
		if (leads.paths.length === 0) out.push("", "None reached the thresholds.");
		for (const e of leads.paths) {
			out.push("", `- \`${e.from}\` → \`${e.to}\`: in ${e.sessions} sessions (${e.transitions} times). A pointer from the first to the second, or a note in the instruction file that names both, could save the search between them; if they always change together, they may belong together.`);
		}
	}
	return out.join("\n") + "\n";
}
