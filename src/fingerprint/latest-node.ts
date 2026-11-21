import type { FingerprintRow } from "./contributor.js";

/**
 * The newest row per session, or per session and `key` when one session holds
 * several subjects (one row per pull request, say).
 *
 * A session that grew between runs keeps a current node per run, each under its
 * own output key, and the newest covers the whole session. `ctx.nodes` returns
 * rows oldest first, so the last row for a key wins.
 */
export function newestPerSession(rows: readonly FingerprintRow[], key: (row: FingerprintRow) => string = () => ""): FingerprintRow[] {
	const newest = new Map<string, FingerprintRow>();
	for (const row of rows) newest.set(`${String(row["session"])}\u0000${key(row)}`, row);
	return [...newest.values()];
}
