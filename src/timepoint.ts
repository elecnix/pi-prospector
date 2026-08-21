/**
 * Point-in-time ("as-of") support for read commands.
 *
 * The analysis graph is append-only, so "the graph as of T" is simply the nodes
 * with `created_at <= T` — no snapshots or history tables needed (see DESIGN.md).
 * This module resolves a user-supplied timepoint spec to a single absolute
 * timestamp `T`, and provides a small CLI flag parser shared by the read
 * commands so the same `--as-of <ts>` / `--as-of-run <id>` vocabulary works
 * everywhere.
 *
 * Honesty: an as-of view is a *view*, not the live graph. Callers must label it
 * as-of so it is never mistaken for current state, and the resolution here keeps
 * the two unambiguous (`--as-of-run` prefers the recorded run boundary over a
 * wall-clock instant that could land mid-run).
 */

import { type AsyncDatabase } from "./db/async-db.js";

export interface ParsedArgs {
	positionals: string[];
	/** `--flag value` or `--flag=value`; bare `--flag` is stored as "". */
	flags: Record<string, string>;
}

/**
 * Minimal flag parser for command arg strings. Supports `--flag value` and
 * `--flag=value`; a bare `--flag` yields "". Positionals are returned in order
 * and are whatever is not a flag.
 */
export function parseFlags(args: string): ParsedArgs {
	const positionals: string[] = [];
	const flags: Record<string, string> = {};
	const toks = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i]!;
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			if (eq !== -1) {
				flags[tok.slice(2, eq)] = tok.slice(eq + 1);
			} else {
				const name = tok.slice(2);
				const next = toks[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[name] = next;
					i++;
				} else {
					flags[name] = "";
				}
			}
		} else {
			positionals.push(tok);
		}
	}
	return { positionals, flags };
}

const RELATIVE_RE = /^(\d+)\s*(s|m|h|d|w|y)$/;

/** Parse "7d"/"24h"/"30m"/"1w" into milliseconds, or null if not relative. */
export function parseRelative(rel: string): number | null {
	const m = RELATIVE_RE.exec(rel.trim().toLowerCase());
	if (!m) return null;
	const n = parseInt(m[1]!, 10);
	const unit = m[2]!;
	const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 }[unit]!;
	return n * mult;
}

/** True when the argument is a wall-clock ISO timestamp we can parse. */
function isIso(t: string): boolean {
	const ms = Date.parse(t);
	return !Number.isNaN(ms) && /T/.test(t);
}

/**
 * Resolve an `--as-of` value (ISO timestamp or relative duration like `7d`) to an
 * absolute ISO timestamp. Throws with a clear message on an unusable spec.
 */
export function parseTimestamp(spec: string): string {
	const s = spec.trim();
	if (s.length === 0) throw new Error("empty --as-of value");
	if (isIso(s)) return new Date(Date.parse(s)).toISOString();
	const rel = parseRelative(s);
	if (rel !== null) return new Date(Date.now() - rel).toISOString();
	throw new Error(`cannot parse '${s}' as a timestamp (use ISO, e.g. 2025-01-01T00:00:00Z, or a relative duration like 7d/24h/30m)`);
}

export interface Timepoint {
	/** The absolute cutoff: include nodes created at or before this instant. */
	at: string;
	/** Human description of how the cutoff was chosen (for labelling). */
	source: string;
}

/**
 * Resolve `--as-of <ts>` / `--as-of-run <id>` flags (if present) to a cutoff.
 *
 * `--as-of-run` prefers the run's recorded `finished_at` boundary over a
 * wall-clock instant, since nodes written concurrently within a run can
 * interleave and a mid-run instant yields a partial view. When both flags are
 * absent, returns undefined (i.e. live/current graph).
 */
export async function resolveTimepoint(db: AsyncDatabase, flags: Record<string, string>): Promise<Timepoint | undefined> {
	const asOf = flags["as-of"];
	const asOfRun = flags["as-of-run"];
	if (asOf !== undefined && asOfRun !== undefined) {
		throw new Error("use either --as-of or --as-of-run, not both");
	}
	if (asOf !== undefined) {
		const at = parseTimestamp(asOf);
		return { at, source: `as of ${at}` };
	}
	if (asOfRun !== undefined) {
		const run = await resolveRunBoundary(db, asOfRun);
		if (!run) throw new Error(`no run matches '${asOfRun}'`);
		return { at: run.at, source: `as of run ${run.id} (${run.at})` };
	}
	return undefined;
}

interface RunBoundary {
	id: string;
	at: string;
}

async function resolveRunBoundary(db: AsyncDatabase, ref: string): Promise<RunBoundary | undefined> {
	const rows = ((await db.prepare(
		"SELECT id, started_at, finished_at FROM analysis_runs WHERE id = ? OR id LIKE ? ORDER BY started_at DESC",
	).all(ref, `${ref}%`)) as Array<{ id: string; started_at: string; finished_at: string | null }>);
	if (rows.length === 0) return undefined;
	const run = rows[0]!;
	return { id: run.id, at: run.finished_at ?? run.started_at };
}
