import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveredSession, SessionSource } from "../types.js";
import { getClaudeSessionsDir } from "../config.js";

/**
 * Walk session directories (Pi: ~/.pi/agent/sessions/, Claude: ~/.claude/projects/)
 * and discover all .jsonl files. Groups by project directory name.
 *
 * Pi dir is passed explicitly (overridable via PROSPECTOR_SESSIONS_DIR).
 * Claude dir is resolved via getClaudeSessionsDir() (overridable via PROSPECTOR_CLAUDE_SESSIONS_DIR).
 */
export function discoverSessions(
	sessionsDir: string,
): DiscoveredSession[] {
	const claudeDir = getClaudeSessionsDir();
	return [
		...discoverPiSessions(sessionsDir),
		...discoverClaudeSessions(claudeDir),
	];
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