import type { AsyncDatabase } from "./async-db.js";
import { prep } from "./prepared.js";

/**
 * Raw per-analyzer totals over a time window, for the anonymous usage report
 * (#290). The window is half-open, `(since, until]`, so consecutive windows
 * never count a row twice. Rows come back keyed by the analyzer id as stored;
 * the caller decides which ids it may report. Proposals with no analyzer id,
 * which only the v1 migration produces, belong to no analyzer and aren't counted.
 */

export interface UsageCounts {
	analyzer: string;
	harness: string;
	runs: number;
	runsFailed: number;
	sessions: number;
	nodes: number;
	durationSec: number;
	proposals: number;
	friction: number;
	correction: number;
	waste: number;
	suggestion: number;
	reinforcement: number;
	accepted: number;
	rejected: number;
	acceptedModified: number;
}

export async function collectUsageCounts(db: AsyncDatabase, since: string, until: string): Promise<UsageCounts[]> {
	const runs = (await prep(
		db,
		`SELECT r.analyzer_id AS analyzer, COALESCE(s.source, 'pi') AS harness,
		        COUNT(*) AS runs,
		        SUM(CASE WHEN r.status = 'ok' THEN 0 ELSE 1 END) AS runsFailed,
		        COUNT(DISTINCT r.session_id) AS sessions,
		        SUM(r.nodes_produced) AS nodes,
		        CAST(ROUND(SUM(CASE WHEN r.finished_at IS NULL THEN 0
		              ELSE (julianday(r.finished_at) - julianday(r.started_at)) * 86400 END)) AS INTEGER) AS durationSec
		   FROM analysis_runs r LEFT JOIN sessions s ON s.id = r.session_id
		  WHERE r.started_at > ? AND r.started_at <= ?
		  GROUP BY 1, 2`,
	).all(since, until)) as Array<Pick<UsageCounts, "analyzer" | "harness" | "runs" | "runsFailed" | "sessions" | "nodes" | "durationSec">>;

	const proposals = (await prep(
		db,
		`SELECT p.analyzer_id AS analyzer, COALESCE(s.source, 'pi') AS harness, p.severity AS severity, COUNT(*) AS n
		   FROM proposals p LEFT JOIN sessions s ON s.id = p.session_id
		  WHERE p.analyzer_id IS NOT NULL
		    AND p.created_at > ? AND p.created_at <= ?
		  GROUP BY 1, 2, 3`,
	).all(since, until)) as Array<{ analyzer: string; harness: string; severity: string; n: number }>;

	// A decision is an assertion on the proposal's input_key, which is
	// H(source output_key | ordinal): one source node, so one analyzer and one
	// session. The materializer (src/analyze/proposal-materializer.ts) skips the
	// insert when a row with that key exists, so there is one row per key. The
	// MIN(id) only keeps the join to one row if that rule ever loosens.
	const decisions = (await prep(
		db,
		`SELECT p.analyzer_id AS analyzer, COALESCE(s.source, 'pi') AS harness, a.verdict AS verdict, COUNT(*) AS n
		   FROM assertions a
		   JOIN proposals p ON p.id = (SELECT MIN(id) FROM proposals WHERE input_key = a.subject_key)
		   LEFT JOIN sessions s ON s.id = p.session_id
		  WHERE a.subject_kind = 'proposal'
		    AND p.analyzer_id IS NOT NULL
		    AND a.verdict IN ('accepted', 'rejected', 'accepted_modified')
		    AND a.asserted_at > ? AND a.asserted_at <= ?
		  GROUP BY 1, 2, 3`,
	).all(since, until)) as Array<{ analyzer: string; harness: string; verdict: string; n: number }>;

	const byKey = new Map<string, UsageCounts>();
	const row = (analyzer: string, harness: string): UsageCounts => {
		const key = `${analyzer}\u0000${harness}`;
		let r = byKey.get(key);
		if (!r) {
			r = {
				analyzer,
				harness,
				runs: 0,
				runsFailed: 0,
				sessions: 0,
				nodes: 0,
				durationSec: 0,
				proposals: 0,
				friction: 0,
				correction: 0,
				waste: 0,
				suggestion: 0,
				reinforcement: 0,
				accepted: 0,
				rejected: 0,
				acceptedModified: 0,
			};
			byKey.set(key, r);
		}
		return r;
	};

	for (const r of runs) {
		const target = row(r.analyzer, r.harness);
		target.runs = r.runs;
		target.runsFailed = r.runsFailed;
		target.sessions = r.sessions;
		target.nodes = r.nodes ?? 0;
		target.durationSec = Math.max(0, r.durationSec ?? 0);
	}
	for (const p of proposals) {
		const r = row(p.analyzer, p.harness);
		r.proposals += p.n;
		if (p.severity === "friction" || p.severity === "correction" || p.severity === "waste" || p.severity === "suggestion" || p.severity === "reinforcement") {
			r[p.severity] += p.n;
		}
	}
	for (const d of decisions) {
		const r = row(d.analyzer, d.harness);
		if (d.verdict === "accepted") r.accepted += d.n;
		else if (d.verdict === "rejected") r.rejected += d.n;
		else r.acceptedModified += d.n;
	}
	return [...byKey.values()];
}
