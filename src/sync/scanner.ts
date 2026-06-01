import * as fs from "node:fs";
import * as path from "node:path";

export interface DiscoveredSession {
	filePath: string;
	project: string;
	mtime: number; // mtime in ms
	size: number;
}

/**
 * Walk ~/.pi/agent/sessions/ and discover all .jsonl files.
 * Groups by project directory name.
 */
export function discoverSessions(
	sessionsDir: string,
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
			});
		}
	}

	return results;
}

/**
 * Extract a human-readable project name from a session directory name.
 * e.g. "--Users-alice-projects-myapp" → "projects/myapp"
 */
export function projectNameFromDir(dirname: string): string {
	const user = process.env.USER ?? "user";

	// Pi encodes paths with -- as separator:
	// /Users/nicolas.marchildon/Source/project → --Users-nicolas.marchildon--Source--project
	let name = dirname;

	// Strip the user home prefix
	const macPrefix = `--Users-${user}--`;
	const linuxPrefix = `--home-${user}--`;

	if (name.startsWith(macPrefix)) {
		name = name.slice(macPrefix.length);
	} else if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	} else if (name.startsWith("--")) {
		// Strip leading -- for absolute paths that don't match home
		name = name.slice(2);
	}

	// Replace -- with / (path separators)
	name = name.replace(/--/g, "/");
	// Strip trailing slashes/dashes
	name = name.replace(/[-/]+$/, "");

	return name || "workspace";
}