import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DiscoveredSession, SessionSource } from "../types.js";

/**
 * How deep below a project directory discovery may descend looking for .jsonl
 * session files. The nested async-subagent layout (#157) needs three levels
 * (<timestamp>_<uuid>/<runhash>/run-N/session.jsonl); Claude layouts are flat.
 * The bound keeps a pathological tree (or a symlink loop surfaced as dirs)
 * from walking unbounded — recursion simply stops and anything deeper stays
 * undiscovered rather than hanging the sync.
 */
export const MAX_DISCOVERY_DEPTH = 8;

/**
 * Optional filters that narrow which sessions discovery returns. Scoping lets a
 * caller sync one project (or one harness) instead of walking every session on
 * disk — the fresh-install case where a full sync ingests hundreds of files.
 * Filters combine with AND.
 */
export interface DiscoverOptions {
	/** Only sessions whose project (derived from the directory name) equals this. */
	project?: string;
	/** Only sessions from one coding harness ("pi" | "claude" | "codex" | "opencode" | "cline"). */
	source?: SessionSource;
}

/**
 * What a source claims inside the session tree it walks.
 *
 * **Discovery claims nothing by extension.** Every source names the file shapes
 * it owns, and a `.jsonl` file no source names is not a session and is never
 * read. The default used to be `fileName.endsWith(".jsonl")`, which is a wildcard:
 * a session root is not a directory of sessions, and the other `.jsonl` files
 * living in it belong to whoever wrote them. That default quietly ingested things
 * no parser could read — pi-subagents' `<runId>_<agent>_<index>_transcript.jsonl`
 * artifacts and the RPC daemon's `out.jsonl` streams, which threw "No session
 * header" 3032 times per sync and re-read ~59 GB on every run; and Claude Code's
 * `agent-*.jsonl` child transcripts and `journal.jsonl` workflow logs, which threw
 * nothing at all and became 4582 sessions with ids taken from their file names.
 *
 * So `matchFile` is required rather than optional: an adapter that has not said
 * which names it owns does not compile. Each shape belongs to the origin that
 * writes it — the pi harness, the Claude harness, the pi-subagents extension — and
 * a new origin means a new source, never a wider wildcard.
 */
export interface WalkOptions {
	/**
	 * The file names this source owns. Receives the file's basename, its immediate
	 * parent directory's name, and its full path — a shape may depend on where the
	 * file sits, not only on what it is called.
	 */
	matchFile: (fileName: string, parentDirName: string, filePath: string) => boolean;
	/**
	 * Directories matching this hold discoverable files directly, but are never
	 * descended beyond — e.g. PiSubagentSource's run-N leaves, where a deeper
	 * session.jsonl is not this source's shape.
	 */
	leafDirPattern?: RegExp;
}

/**
 * Walk one session root for the files one source claims, tagged with the given
 * source. Exported for SessionSourceAdapter implementations, which own discovery
 * for their source and reuse this walker for the shared directory layout —
 * passing the shapes they claim and, where their tree shape is narrower than the
 * full walk, a leaf-directory rule.
 *
 * Discovery recurses below each project directory up to {@link MAX_DISCOVERY_DEPTH}
 * levels, so nested async-subagent session files (<project-dir>/<timestamp>_<uuid>
 * /<runhash>/run-N/session.jsonl) are discovered alongside top-level ones (#157).
 * Each claimed file — wherever it sits in that bounded tree — is discovered as its
 * own session; which session each file *is* remains the parser's job (the header's
 * own id), never a function of the path.
 */
export async function walkSessionDir(
	sessionsDir: string,
	source: SessionSource,
	opts: WalkOptions,
): Promise<DiscoveredSession[]> {
	const results: DiscoveredSession[] = [];

	let entries: string[];
	try {
		entries = await fs.readdir(sessionsDir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(sessionsDir, entry);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}

		if (!stat.isDirectory()) continue;

		// Skip non-session directories (e.g. var-folders)
		if (entry.includes("var-folders")) continue;

		const project = projectNameFromDir(entry);

		await collectJsonlFiles(fullPath, project, 1, source, results, opts);
	}

	return results;
}

/**
 * Recursively gather the files under `dir` that the source claims, descending at
 * most to `depth === MAX_DISCOVERY_DEPTH`. Files at any visited level count;
 * unreadable subdirectories are skipped quietly (they may vanish mid-walk), while
 * deeper levels beyond the bound are simply not visited.
 */
async function collectJsonlFiles(
	dir: string,
	project: string,
	depth: number,
	source: SessionSource,
	results: DiscoveredSession[],
	opts: WalkOptions,
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return;
	}

	// Directories first, then files, so the depth bound governs descent before
	// any file at this level is recorded — but both come from the single readdir.
	for (const entry of entries) {
		const fullPath = path.join(dir, entry);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			if (depth >= MAX_DISCOVERY_DEPTH) continue;
			// Entering a leaf directory at the bound blocks any descent past it
			// while its own direct entries stay visible to the match above.
			const childDepth = opts.leafDirPattern?.test(entry) ? MAX_DISCOVERY_DEPTH : depth + 1;
			await collectJsonlFiles(fullPath, project, childDepth, source, results, opts);
			continue;
		}

		if (!opts.matchFile(entry, path.basename(dir), fullPath)) continue;
		results.push({
			filePath: fullPath,
			project,
			mtime: stat.mtimeMs,
			size: stat.size,
			source,
		});
	}
}

/**
 * Extract a human-readable project name from a session directory name.
 * Handles both Pi encoding (-- separator) and Claude encoding (- separator).
 *
 * Pi:    /Users/nicolas/Source/project  → --Users-nicolas--Source--project
 * Claude: /Users/nicolas/Source/project  → -Users-nicolas-Source-project
 */
export function projectNameFromDir(dirname: string): string {
	const user = process.env.USER ?? "user";
	let name = dirname;

	// Pi encoding: -- separator
	const macPiPrefix = `--Users-${user}--`;
	const linuxPiPrefix = `--home-${user}--`;

	// Claude encoding: - separator
	const macClaudePrefix = `-Users-${user}-`;
	const linuxClaudePrefix = `-home-${user}-`;

	if (name.startsWith(macPiPrefix)) {
		name = name.slice(macPiPrefix.length);
		name = name.replace(/--/g, "/");
	} else if (name.startsWith(linuxPiPrefix)) {
		name = name.slice(linuxPiPrefix.length);
		name = name.replace(/--/g, "/");
	} else if (name.startsWith(macClaudePrefix)) {
		name = name.slice(macClaudePrefix.length);
		name = name.replace(/-/g, "/");
	} else if (name.startsWith(linuxClaudePrefix)) {
		name = name.slice(linuxClaudePrefix.length);
		name = name.replace(/-/g, "/");
	} else if (name.startsWith("--")) {
		// Pi encoding: absolute paths that don't match home
		name = name.slice(2);
		name = name.replace(/--/g, "/");
	} else if (name.startsWith("-")) {
		// Claude encoding: absolute path
		name = name.slice(1);
		name = name.replace(/-/g, "/");
	}

	// Strip trailing slashes/dashes
	name = name.replace(/[-/]+$/, "");

	return name || "workspace";
}