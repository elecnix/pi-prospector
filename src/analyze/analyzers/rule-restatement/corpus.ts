/**
 * The instruction corpus: the standing-instruction text a session ran under.
 *
 * The transcript does not record it — a harness loads its instruction files
 * into the system prompt, and no session file keeps a copy — so it is read from
 * disk, from the places the session's harness would have looked. What is read is
 * the files as they are *now*, which is the question a reader of a proposal is
 * actually asking: "is this rule already in the file I would add it to?"
 *
 * Each file enters the unit's source set by path and content hash, so editing
 * an instruction file changes the identity of every check that read it and the
 * next scan finds those checks missing. A file that does not exist is simply
 * not in scope; that is not an error.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { shortHash } from "../../input-hash.js";
import type { RuleRestatementConfig } from "./config.js";

export const InstructionScope = Type.Union([
	Type.Literal("global"),
	Type.Literal("project"),
	Type.Literal("configured"),
]);
export type InstructionScope = Static<typeof InstructionScope>;

export const InstructionFile = Type.Object({
	/** Absolute path the file was read from. */
	path: Type.String(),
	/** Why the file is in scope: the harness's global file, a project file on the cwd path, or configured. */
	scope: InstructionScope,
	content: Type.String(),
	/** Content hash; folded into the unit's source set. */
	contentHash: Type.String(),
});
export type InstructionFile = Static<typeof InstructionFile>;

export const InstructionCandidate = Type.Object({ path: Type.String(), scope: InstructionScope });
export type InstructionCandidate = Static<typeof InstructionCandidate>;

/** The home directory the harness files live under; `PROSPECTOR_INSTRUCTIONS_HOME` overrides it. */
export function instructionHome(): string {
	return process.env["PROSPECTOR_INSTRUCTIONS_HOME"] || os.homedir();
}

function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	return p;
}

/** Directories from the filesystem root down to `cwd`, general first. */
function ancestorsRootFirst(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = path.resolve(cwd);
	for (;;) {
		dirs.unshift(dir);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

/**
 * Where the session's harness would have looked for instructions, in load
 * order (general first). Pi loads one of `AGENTS.md`/`CLAUDE.md` per directory;
 * Claude Code loads `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`. A
 * session whose harness is unknown gets no harness-derived files — guessing a
 * host would put the wrong host's rules in scope.
 *
 * Pi's per-directory choice depends on which file exists, so candidates are
 * grouped: the first existing path of a group is the one that loads.
 */
export function instructionCandidateGroups(params: {
	source: string;
	cwd: string;
	home: string;
	config: Pick<RuleRestatementConfig, "includeHarnessGlobal" | "discoverProjectFiles" | "instructionPaths">;
}): InstructionCandidate[][] {
	const { source, cwd, home, config } = params;
	const groups: InstructionCandidate[][] = [];
	const harness = source === "pi" || source === "claude" ? source : null;

	if (harness && config.includeHarnessGlobal) {
		const global = harness === "pi" ? path.join(home, ".pi", "agent", "AGENTS.md") : path.join(home, ".claude", "CLAUDE.md");
		groups.push([{ path: global, scope: "global" }]);
	}

	if (harness && config.discoverProjectFiles && cwd && path.isAbsolute(cwd)) {
		for (const dir of ancestorsRootFirst(cwd)) {
			if (harness === "pi") {
				groups.push([
					{ path: path.join(dir, "AGENTS.md"), scope: "project" },
					{ path: path.join(dir, "CLAUDE.md"), scope: "project" },
				]);
			} else {
				groups.push([{ path: path.join(dir, "CLAUDE.md"), scope: "project" }]);
				groups.push([{ path: path.join(dir, ".claude", "CLAUDE.md"), scope: "project" }]);
				groups.push([{ path: path.join(dir, "CLAUDE.local.md"), scope: "project" }]);
			}
		}
	}

	for (const p of config.instructionPaths) {
		const resolved = expandHome(p, home);
		if (path.isAbsolute(resolved)) groups.push([{ path: resolved, scope: "configured" }]);
	}
	return groups;
}

function isReadableFile(p: string): boolean {
	return fs.existsSync(p) && fs.statSync(p).isFile();
}

/** Read the corpus: the first existing file of each group, each path once, empty files dropped. */
export function readInstructionCorpus(groups: readonly InstructionCandidate[][]): InstructionFile[] {
	const seen = new Set<string>();
	const files: InstructionFile[] = [];
	for (const group of groups) {
		const hit = group.find((c) => isReadableFile(c.path));
		if (!hit) continue;
		const real = fs.realpathSync(hit.path);
		if (seen.has(real)) continue;
		seen.add(real);
		const content = fs.readFileSync(real, "utf8");
		if (content.trim().length === 0) continue;
		files.push({ path: hit.path, scope: hit.scope, content, contentHash: shortHash(content) });
	}
	return files;
}

// ─────────────────────────── passage selection ───────────────────────────

export const CorpusExcerpt = Type.Object({
	path: Type.String(),
	/** The text the model reads for this file: whole, or its most relevant passages. */
	text: Type.String(),
	/** Whether passages were dropped to fit the budget. */
	excerpted: Type.Boolean(),
});
export type CorpusExcerpt = Static<typeof CorpusExcerpt>;

/** Lowercased word tokens of four or more letters — enough to rank passages, not to judge them. */
function terms(text: string): Set<string> {
	return new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? []));
}

/** Split a file into paragraphs, keeping a heading with the paragraph under it. */
export function splitPassages(content: string): string[] {
	const blocks = content.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
	const passages: string[] = [];
	let pendingHeading: string | null = null;
	for (const b of blocks) {
		if (/^#{1,6}\s/.test(b) && !b.includes("\n")) {
			pendingHeading = pendingHeading ? `${pendingHeading}\n${b}` : b;
			continue;
		}
		passages.push(pendingHeading ? `${pendingHeading}\n${b}` : b);
		pendingHeading = null;
	}
	if (pendingHeading) passages.push(pendingHeading);
	return passages;
}

/**
 * Fit the corpus into `maxChars`. Under budget it is sent whole. Over budget,
 * every passage is scored by how many of the proposal's terms it shares, and the
 * best are kept until the budget runs out, then restored to document order so
 * the model reads each file as written. A proposal that restates a rule in
 * entirely different words can lose its passage here — which is why the budget
 * is generous and the whole corpus is preferred whenever it fits.
 */
export function selectCorpus(files: readonly InstructionFile[], proposalText: string, maxChars: number): CorpusExcerpt[] {
	const total = files.reduce((n, f) => n + f.content.length, 0);
	if (total <= maxChars) return files.map((f) => ({ path: f.path, text: f.content, excerpted: false }));

	const wanted = terms(proposalText);
	const scored = files.flatMap((f, fileIndex) =>
		splitPassages(f.content).map((text, passageIndex) => {
			let score = 0;
			for (const t of terms(text)) if (wanted.has(t)) score++;
			return { fileIndex, passageIndex, text, score };
		}),
	);
	const ranked = [...scored].sort(
		(a, b) => b.score - a.score || a.fileIndex - b.fileIndex || a.passageIndex - b.passageIndex,
	);
	const kept = new Set<(typeof scored)[number]>();
	let used = 0;
	for (const p of ranked) {
		if (p.score === 0) break;
		if (used + p.text.length > maxChars) continue;
		kept.add(p);
		used += p.text.length;
	}

	return files
		.map((f, fileIndex) => ({
			path: f.path,
			text: scored.filter((p) => p.fileIndex === fileIndex && kept.has(p)).map((p) => p.text).join("\n\n[…]\n\n"),
			excerpted: true,
		}))
		.filter((e) => e.text.length > 0);
}
