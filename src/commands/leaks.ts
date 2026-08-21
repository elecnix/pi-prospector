/**
 * `prospect leaks` — the leak report (issue #196): which sessions contain
 * detected secrets, readable without SQL.
 *
 * Every credential-detector analyzer already writes its findings into the
 * graph as redacted `metric` nodes (see `secret-scanner.ts`, the shared
 * engine). This module is the read surface over those nodes: it lists the
 * sessions that contain findings, tallies them per rule, and anchors every
 * finding to the exact message that contained it — the same walk-back
 * `prospect show` performs for proposals, applied to detector output. It is a
 * reporting surface only: it reads the graph, writes nothing, analyses nothing
 * new, and calls no model.
 *
 * The redaction contract is inherited, not reimplemented: a finding carries
 * the analyzer's `redacted_preview` and SHA-256 `fingerprint`, and the report
 * emits exactly those — never a full secret value.
 *
 * Scope decision: the report covers the credential-detector family
 * (`DETECTOR_ANALYZER_IDS`) — the analyzers emitting the shared
 * `SecretLeakFinding` shape. The generic `prospect nodes --filter` surface
 * already answers "show me one analyzer's leak nodes"; what it cannot do is
 * join findings across the whole family into one operator-facing "which
 * sessions leaked" view, which is what this command is for.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { migrate } from "../db/schema.js";
import { listAnalysisNodes } from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";
import {
	DETECTOR_ANALYZER_IDS,
	SEVERITY_RANK,
	SecretLeakFinding,
} from "../analyze/analyzers/secret-scanner.js";
import type { AnalysisNodeRow } from "../analyze/types.js";

// ─────────────────────────── report shapes ───────────────────────────

/** One finding as the report renders it: the stored finding plus its node provenance. */
export const LeakReportEntry = Type.Object({
	...SecretLeakFinding.properties,
	/** Analyzer that produced the finding. */
	analyzer_id: Type.String(),
	/** Session the finding's node belongs to. */
	session_id: Type.String(),
	/** Output key of the node that recorded the finding (walk it with `prospect node`). */
	output_key: Type.String(),
	/** When the node was created. */
	created_at: Type.String(),
});
export type LeakReportEntry = Static<typeof LeakReportEntry>;

/** Findings grouped by the session that contains them. */
export const LeakSessionGroup = Type.Object({
	session_id: Type.String(),
	/** Harness source of the session (`pi` | `claude`), when the session row is present. */
	source: Type.Optional(Type.String()),
	entries: Type.Array(LeakReportEntry),
});
export type LeakSessionGroup = Static<typeof LeakSessionGroup>;

/** The full report: sessions with findings, plus per-rule tallies. */
export const LeakReport = Type.Object({
	sessions: Type.Array(LeakSessionGroup),
	/** Findings per rule id across all reported sessions. */
	rule_counts: Type.Record(Type.String(), Type.Number()),
	total_findings: Type.Number(),
	/** Findings that met every filter but were dropped by `limit`. */
	omitted_by_limit: Type.Number(),
	/** Findings present in node content but not matching the declared finding schema. */
	malformed_findings: Type.Number(),
});
export type LeakReport = Static<typeof LeakReport>;

// ─────────────────────────── argument parsing ───────────────────────────

/** Parsed `prospect leaks` arguments. */
export interface LeaksQuery {
	/** Minimum severity to report (floor, not exact match): `high` reports critical and high. */
	minSeverity?: string;
	limit?: number;
	source?: string;
}

const LEAKS_FLAGS = [
	"--severity critical|high|medium (floor: report this severity and above)",
	"--limit <n>",
	"--source pi|claude",
];

/** The usage line for `prospect leaks`. */
export function leaksUsage(): string {
	return `Usage: prospect leaks [--severity <critical|high|medium>] [--limit <n>] [--source <pi|claude>]`;
}

const SEVERITIES: readonly string[] = ["medium", "high", "critical"];
const SOURCES: readonly string[] = ["pi", "claude"];

/**
 * Parse `prospect leaks` arguments. Throws an Error with a user-facing
 * message on malformed input.
 */
export function parseLeaksArgs(args: string): LeaksQuery {
	const toks = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
	const q: LeaksQuery = {};
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i]!;
		const val = (): string => {
			const next = toks[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`flag ${tok} needs a value`);
			i++;
			return next;
		};
		switch (tok) {
			case "--severity": {
				const s = val();
				if (!SEVERITIES.includes(s)) {
					throw new Error(`unknown --severity '${s}' (valid: ${SEVERITIES.join(", ")})`);
				}
				q.minSeverity = s;
				break;
			}
			case "--limit": {
				const n = Number(val());
				if (!Number.isInteger(n) || n <= 0) throw new Error("--limit needs a positive integer");
				q.limit = n;
				break;
			}
			case "--source": {
				const s = val();
				if (!SOURCES.includes(s)) {
					throw new Error(`unknown --source '${s}' (valid: ${SOURCES.join(", ")})`);
				}
				q.source = s;
				break;
			}
			default:
				throw new Error(`unknown flag or stray argument: "${tok}"\n${leaksUsage()}`);
		}
	}
	return q;
}

// ─────────────────────────── report assembly ───────────────────────────

/** Hard cap on nodes pulled before rendering — the read path is bounded, not unbounded. */
const MAX_SCAN = 10_000;

/**
 * Extract the reportable findings from one detector node's content. A finding
 * that does not match the declared {@link SecretLeakFinding} schema is counted
 * as malformed and skipped — never silently dropped, and never rendered from
 * unvalidated content.
 */
export function findingsFromNode(row: AnalysisNodeRow): { entries: LeakReportEntry[]; malformed: number } {
	let content: Record<string, unknown>;
	try {
		content = JSON.parse(row.content_json) as Record<string, unknown>;
	} catch {
		return { entries: [], malformed: 0 };
	}
	const leaks = content["leaks"];
	if (!Array.isArray(leaks)) return { entries: [], malformed: 0 };
	const entries: LeakReportEntry[] = [];
	let malformed = 0;
	for (const raw of leaks) {
		if (!Check(SecretLeakFinding, raw)) {
			malformed++;
			continue;
		}
		const finding = raw as Static<typeof SecretLeakFinding>;
		entries.push({
			...finding,
			analyzer_id: row.analyzer_id,
			session_id: row.session_id,
			output_key: row.output_key,
			created_at: row.created_at,
		});
	}
	return { entries, malformed };
}

/**
 * The shared core of `prospect leaks` for the slash command and the tool
 * action. Reads the detector family's live metric nodes, applies the severity
 * floor and source filter, groups by session, tallies per rule.
 */
export function readLeaks(db: Database.Database, q: LeaksQuery): { text: string; report: LeakReport } {
	const minRank = q.minSeverity ? SEVERITY_RANK[q.minSeverity as keyof typeof SEVERITY_RANK] : undefined;
	const rows = listAnalysisNodes(db, {
		analyzerIds: [...DETECTOR_ANALYZER_IDS],
		nodeKind: "metric",
		source: q.source,
		limit: MAX_SCAN,
	});

	const all: LeakReportEntry[] = [];
	let malformed = 0;
	for (const row of rows) {
		const { entries, malformed: bad } = findingsFromNode(row);
		all.push(...entries);
		malformed += bad;
	}

	const matched = minRank === undefined ? all : all.filter((e) => SEVERITY_RANK[e.severity] >= minRank);
	// Newest findings first, then by session so the grouping is stable.
	matched.sort(
		(a, b) => b.created_at.localeCompare(a.created_at) || a.session_id.localeCompare(b.session_id) || a.fingerprint.localeCompare(b.fingerprint),
	);

	const omitted = q.limit !== undefined && matched.length > q.limit ? matched.length - q.limit : 0;
	const reported = q.limit !== undefined ? matched.slice(0, q.limit) : matched;

	const ruleCounts: Record<string, number> = {};
	for (const e of matched) ruleCounts[e.rule_id] = (ruleCounts[e.rule_id] ?? 0) + 1;

	const bySession = new Map<string, LeakReportEntry[]>();
	for (const e of reported) {
		const list = bySession.get(e.session_id);
		if (list) list.push(e);
		else bySession.set(e.session_id, [e]);
	}

	const sources = new Map<string, string>();
	for (const s of db.prepare("SELECT id, source FROM sessions").all() as Array<{ id: string; source: string }>) {
		sources.set(s.id, s.source);
	}

	const sessions: LeakSessionGroup[] = [...bySession.entries()].map(([sessionId, entries]) => ({
		session_id: sessionId,
		source: sources.get(sessionId),
		entries,
	}));

	const report: LeakReport = {
		sessions,
		rule_counts: ruleCounts,
		total_findings: matched.length,
		omitted_by_limit: omitted,
		malformed_findings: malformed,
	};
	return { text: renderLeaks(report, q), report };
}

// ─────────────────────────── rendering ───────────────────────────

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Render one finding: severity, rule, preview, fingerprint shortref, message anchor. */
export function formatLeakEntry(e: LeakReportEntry): string[] {
	const head = `  • [${e.severity}] ${e.rule_id} — ${truncate(e.rule_label, 60)}`;
	const detail =
		`      ${e.analyzer_id} · node ${e.output_key.slice(0, 12)} · message ${e.message_id}` +
		` · ${e.field} · preview ${e.redacted_preview} · fp ${e.fingerprint}`;
	return [head, detail];
}

/** Render the full report as readable text. Pure over its arguments. */
export function renderLeaks(report: LeakReport, q: LeaksQuery): string {
	const floor = q.minSeverity ? ` (severity ≥ ${q.minSeverity})` : "";
	const rules = Object.entries(report.rule_counts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([id, n]) => `${id}=${n}`)
		.join(", ");

	const lines: string[] = [];
	if (report.total_findings === 0) {
		lines.push(`No detected secrets${floor ? floor : ""}. The credential-detector analyzers have recorded no findings in the live graph.`);
	} else {
		lines.push(
			`Leaks — ${report.total_findings} finding(s) across ${report.sessions.length} session(s)${floor}` +
				(rules ? `; by rule: ${rules}` : "") +
				".",
		);
		for (const group of report.sessions) {
			const src = group.source ? ` · ${group.source}` : "";
			lines.push(``, `session ${group.session_id}${src} — ${group.entries.length} finding(s):`);
			for (const e of group.entries) lines.push(...formatLeakEntry(e));
		}
		lines.push(
			``,
			`Walk any finding back to its verbatim message: prospect node <output-key> (prefix ok). ` +
				`Previews are redacted; fingerprints identify the full value without storing it.`,
		);
	}
	if (report.omitted_by_limit > 0) lines.push(`… ${report.omitted_by_limit} more finding(s) omitted by --limit ${q.limit}.`);
	if (report.malformed_findings > 0) {
		lines.push(`note: ${report.malformed_findings} finding(s) in the graph do not match the declared finding schema and were excluded.`);
	}
	return lines.join("\n");
}

// ─────────────────────────── command surfaces ───────────────────────────

function out(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/** `/prospect-leaks` — the leak report. */
export async function prospectLeaks(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		try {
			const q = parseLeaksArgs(rawArgs ?? "");
			const { text } = readLeaks(db, q);
			out(ctx, text);
		} catch (err) {
			out(ctx, `prospect leaks: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	} finally {
		db.close();
	}
}

export function registerLeaksCommands(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-leaks", {
		description:
			"Report which sessions contain detected secrets: every finding from the credential-detector analyzers " +
			"(secret-leak, gitleaks, nosey-parker, detect-secrets, trufflehog, secret-scanner) with its severity, rule, " +
			"redacted preview, fingerprint, and the message it appeared in. Flags: --severity <critical|high|medium> (floor), --limit <n>, --source <pi|claude>.",
		handler: prospectLeaks,
	});
}
