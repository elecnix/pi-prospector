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
	/** Only sessions from one coding harness ("pi" | "claude"). */
	source?: SessionSource;
}

/**
 * Walk both session directories (Pi: `~/.pi/agent/sessions/`, Claude:
 * `~/.claude/projects/`) and discover all .jsonl files, grouped by project
 * directory name.
 *
 * **Both directories are required parameters, and nothing here reads ambient
 * config.** They used to be asymmetric — the Pi dir was passed in while the
 * Claude dir was resolved from the environment — so a caller that supplied an
 * explicit fixture path still ingested the developer's real session history. The
 * damage was quiet: with no `~/.claude/projects` present (CI) everything looked
 * fine, while locally two suites failed for reasons unrelated to the change under
 * test, and two others had independently discovered the hazard and were juggling
 * `PROSPECTOR_CLAUDE_SESSIONS_DIR` around every call to defend themselves.
 *
 * Required rather than defaulted is the whole point: a caller can no longer
 * *forget* the Claude directory, so the failure mode cannot quietly return.
 * Resolving defaults belongs to the composition root — `getSessionsDir()` and
 * `getClaudeSessionsDir()` in `src/config.ts`, called from the command layer.
 */
export async function discoverSessions(
	sessionsDir: string,
	claudeSessionsDir: string,
	opts?: DiscoverOptions,
): Promise<DiscoveredSession[]> {
	const pi: DiscoveredSession[] = opts?.source && opts.source !== "pi" ? [] : await discoverPiSessions(sessionsDir);
	const claude: DiscoveredSession[] =
		opts?.source && opts.source !== "claude" ? [] : await discoverClaudeSessions(claudeSessionsDir);
	const all = [...pi, ...claude];
	if (opts?.project) return all.filter((s) => s.project === opts.project);
	return all;
}

async function discoverPiSessions(sessionsDir: string): Promise<DiscoveredSession[]> {
	return walkSessionDir(sessionsDir, "pi");
}

async function discoverClaudeSessions(sessionsDir: string): Promise<DiscoveredSession[]> {
	return walkSessionDir(sessionsDir, "claude");
}

/**
 * Walk one session root for its .jsonl files, tagged with the given source.
 * Exported for SessionSourceAdapter implementations, which own discovery for
 * their source and reuse this walker for the shared directory layout.
 *
 * Discovery recurses below each project directory up to {@link MAX_DISCOVERY_DEPTH}
 * levels, so nested async-subagent session files (<project-dir>/<timestamp>_<uuid>
 * /<runhash>/run-N/session.jsonl) are discovered alongside top-level ones (#157).
 * Each .jsonl found — wherever it sits in that bounded tree — is discovered as
 * its own session; which session each file *is* remains the parser's job (the
 * header's own id), never a function of the path.
 */
export async function walkSessionDir(
	sessionsDir: string,
	source: SessionSource,
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

		await collectJsonlFiles(fullPath, project, 1, source, results);
	}

	return results;
}

/**
 * Recursively gather every .jsonl file under `dir`, descending at most to
 * `depth === MAX_DISCOVERY_DEPTH`. Files at any visited level count; unreadable
 * subdirectories are skipped quietly (they may vanish mid-walk), while deeper
 * levels beyond the bound are simply not visited.
 */
async function collectJsonlFiles(
	dir: string,
	project: string,
	depth: number,
	source: SessionSource,
	results: DiscoveredSession[],
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
			await collectJsonlFiles(fullPath, project, depth + 1, source, results);
			continue;
		}

		if (!entry.endsWith(".jsonl")) continue;
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