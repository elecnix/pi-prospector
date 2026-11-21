/**
 * How pi names its session files and lays out a session's child runs.
 *
 * Pure path rules, with no file access, so both the pi sources and the migration
 * that re-links child runs indexed before the sources read the path (#416) use
 * the same rule.
 */
import * as path from "node:path";

/**
 * Pi's own session-file naming, as the harness's session store writes it:
 * `<timestamp>_<uuid>.jsonl`, wherever below a project directory pi put it.
 *
 * The timestamp is written with dashes, not with the colons and dot of the ISO
 * 8601 string it comes from: the session that started at `19:00:24.951Z` is stored
 * as `2026-09-11T19-00-24-951Z_01a091d7-…jsonl`. Hence `[\d-]+` between the `T`
 * and the `Z` rather than a looser class: discovery claims the shape the harness
 * writes, and every one of the 4262 session files on a live machine matches it.
 *
 * The stem is also the name pi gives the directory holding a session's child runs,
 * which is how those attach to their parent: see
 * {@link parentSessionFromRunPath}.
 */
const PI_SESSION_STEM_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * A child run's session directory, named `run-N` by the pi-subagents extension.
 * The file inside it, `session.jsonl`, is a pi session.
 */
export const RUN_DIR_RE = /^run-\d+$/;

/**
 * The session id pi's own file name carries, or null when the name is not one pi
 * gives its session files. Pi names a session file after the session it holds, so
 * the name is a record of the id wherever the file itself has gone.
 */
export function piSessionIdFromFileName(fileName: string): string | null {
	if (!fileName.endsWith(".jsonl")) return null;
	return PI_SESSION_STEM_RE.exec(fileName.slice(0, -".jsonl".length))?.[1] ?? null;
}

/** True when a file name is one pi gives its own session files. */
export function isPiSessionFileName(fileName: string): boolean {
	return piSessionIdFromFileName(fileName) !== null;
}

/** True when a path is a child run's session file: `session.jsonl` directly inside a `run-N` directory. */
export function isChildRunSessionPath(filePath: string): boolean {
	return path.basename(filePath) === "session.jsonl" && RUN_DIR_RE.test(path.basename(path.dirname(filePath)));
}

/**
 * The session that spawned a child run, from the run's path.
 *
 * Pi keeps a session's child runs inside a directory named after the session file
 * itself: `<project>/<timestamp>_<uuid>/<runhash>/run-N/session.jsonl`. So the
 * nearest ancestor directory carrying that naming holds the parent's session id,
 * while everything between it and the file (the `run-N` directory, the run's own
 * hash) belongs to the run and names no session. A run a child run started sits
 * below the child's `run-N/session/` directory, and attaches to the same session.
 */
export function parentSessionFromRunPath(filePath: string): string | null {
	let dir = path.dirname(filePath);
	while (dir !== path.dirname(dir)) {
		const id = piSessionIdFromFileName(`${path.basename(dir)}.jsonl`);
		if (id) return id;
		dir = path.dirname(dir);
	}
	return null;
}
