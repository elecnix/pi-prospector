import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveredSession, SessionSource } from "../types.js";

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
export function discoverSessions(
	sessionsDir: string,
	claudeSessionsDir: string,
	opts?: DiscoverOptions,
): DiscoveredSession[] {
	const pi: DiscoveredSession[] = opts?.source && opts.source !== "pi" ? [] : discoverPiSessions(sessionsDir);
	const claude: DiscoveredSession[] =
		opts?.source && opts.source !== "claude" ? [] : discoverClaudeSessions(claudeSessionsDir);
	const all = [...pi, ...claude];
	if (opts?.project) return all.filter((s) => s.project === opts.project);
	return all;
}

function discoverPiSessions(sessionsDir: string): DiscoveredSession[] {
	return walkSessionDir(sessionsDir, "pi");
}

function discoverClaudeSessions(sessionsDir: string): DiscoveredSession[] {
	return walkSessionDir(sessionsDir, "claude");
}

function walkSessionDir(
	sessionsDir: string,
	source: SessionSource,
): DiscoveredSession[] {
	const results: DiscoveredSession[] = [];

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsDir);
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(sessionsDir, entry);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}

		if (!stat.isDirectory()) continue;

		// Skip non-session directories (e.g. var-folders)
		if (entry.includes("var-folders")) continue;

		const project = projectNameFromDir(entry);

		let files: string[];
		try {
			files = fs.readdirSync(fullPath);
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const filePath = path.join(fullPath, file);
			let fileStat: fs.Stats;
			try {
				fileStat = fs.statSync(filePath);
			} catch {
				continue;
			}

			results.push({
				filePath,
				project,
				mtime: fileStat.mtimeMs,
				size: fileStat.size,
				source,
			});
		}
	}

	return results;
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