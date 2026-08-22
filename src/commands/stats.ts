import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getAnalyzerCoverage } from "../db/analysis-queries.js";
import { getAnalyzerPaths, getDbPath, loadConfig } from "../config.js";
import { BUILTIN_ANALYZERS } from "../analyze/defaults.js";
import { loadCustomAnalyzers } from "../analyze/loader.js";
import { parseFlags, resolveTimepoint } from "../timepoint.js";
import type { TokenStats } from "../types.js";

function fmt(n: number): string {
	return n.toLocaleString();
}

function fmtRatio(r: number | null): string {
	if (r === null) return "N/A";
	if (r > 1) return `${r}× Pi`;
	return `${(1 / r).toFixed(1)}× Claude`;
}

function tokenBlock(label: string, stats: TokenStats): string[] {
	const lines: string[] = [];
	lines.push(`  ── ${label} ──`);
	lines.push(`  Turns:              ${fmt(stats.turnCount)}`);
	lines.push(`  Tool calls:         ${fmt(stats.toolCallCount)}`);
	lines.push("");
	lines.push(`  ── Tokens ──`);
	lines.push(`  Input:              ${fmt(stats.totalInput)}`);
	lines.push(`  Output:             ${fmt(stats.totalOutput)}`);
	lines.push(`  Cache read:         ${fmt(stats.totalCacheRead)}`);
	lines.push(`  Cache write:        ${fmt(stats.totalCacheWrite)}`);
	lines.push(`  Total:              ${fmt(stats.totalTokens)}`);
	lines.push("");
	lines.push(`  ── Per turn ──`);
	lines.push(`  Input / turn:       ${fmt(stats.inputPerTurn)}`);
	lines.push(`  Output / turn:      ${fmt(stats.outputPerTurn)}`);
	lines.push(`  Cache read / turn:  ${fmt(stats.cacheReadPerTurn)}`);
	lines.push(`  Tool calls / turn:  ${stats.toolCallsPerTurn}`);
	lines.push(`  ── Per tool call ──`);
	const tc = stats.toolCallCount > 0 ? stats.toolCallCount : 1;
	lines.push(`  Input / tool call:  ${fmt(Math.round(stats.totalInput / tc))}`);
	lines.push(`  Output / tool call: ${fmt(Math.round(stats.totalOutput / tc))}`);
	lines.push(`  Tokens / tool call: ${fmt(Math.round(stats.totalTokens / tc))}`);
	return lines;
}

/**
 * The analyzer-coverage summary (#195): which registered analyzers have ever
 * produced analysis for which sessions. The registry is the live one — built-ins
 * plus every custom analyzer that loads from the configured paths — so an
 * analyzer that just shipped shows up here as a wall of gaps before any analyze
 * run has ever heard of it.
 */
export async function coverageLines(db: AsyncDatabase): Promise<string[]> {
	const config = loadConfig();
	const builtinIds = BUILTIN_ANALYZERS.map((a) => a.def.id);
	const { loaded } = await loadCustomAnalyzers({ paths: getAnalyzerPaths([], config), builtinIds });
	const coverage = await getAnalyzerCoverage(db, [...builtinIds, ...loaded.map((a) => a.def.id)]);

	const lines: string[] = [];
	lines.push("  ── Analyzer coverage ──");
	if (coverage.analyzerIds.length === 0) {
		lines.push("  (no analyzers registered)");
		return lines;
	}
	lines.push(`  Sessions considered: ${coverage.sessionsConsidered}`);
	// Only the analyzers with something to fix are enumerated; a fully-covered
	// registry is summarised in one line so the section stays scannable.
	const gapped = coverage.perAnalyzer.filter((a) => a.sessionsMissing > 0);
	for (const a of gapped) {
		lines.push(
			`    ${a.analyzerId}: covered ${a.sessionsCovered}/${coverage.sessionsConsidered}` +
				` (nodes in ${a.sessionsWithNodes}, missing ${a.sessionsMissing})`,
		);
	}
	if (gapped.length === 0) {
		lines.push("  Every registered analyzer has run against every session.");
	} else {
		lines.push(
			`  ${coverage.gaps.length} session(s) have coverage gaps — ` +
				"run '/prospect-analyze --backfill-missing' to fill only what is missing.",
		);
	}
	return lines;
}

export async function prospectStats(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const { flags } = parseFlags(args ?? "");
		let asOf: string | undefined;
		let timepointLabel: string | undefined;
		const tp = await resolveTimepoint(db, flags);
		if (tp) {
			asOf = tp.at;
			timepointLabel = tp.source;
		}
		const s = await getStats(db, asOf);
		let coverage: string[] = [];
		try {
			// Coverage reads the live registry off disk; a broken analyzer path must
			// not take the whole stats view down with it.
			coverage = await coverageLines(db);
		} catch (err) {
			coverage = [
				"  ── Analyzer coverage ──",
				`  (unavailable: ${err instanceof Error ? err.message : String(err)})`,
			];
		}
		const kindLines = Object.entries(s.analysis.nodesByKind).map(([k, v]) => `    ${k}: ${v}`);
		const analyzerLines = Object.entries(s.analysis.nodesByAnalyzer).map(([k, v]) => `    ${k}: ${v}`);
		const t = s.tokens;

		const lines = [
			"╔══════════════════════════════════════════╗",
			"║          ⛏️  Prospector Stats             ║",
			"╚══════════════════════════════════════════╝",
			"",
			...(timepointLabel ? [`  (VIEW ${timepointLabel} — not current state)`] : []),
			"  ── Sessions ──",
			`  Sessions indexed:     ${s.totalSessions} (Pi: ${s.piSessions}, Claude: ${s.claudeSessions})`,
			`  Messages (user+asst): ${s.totalMessages} (Pi: ${s.piMessages}, Claude: ${s.claudeMessages})`,
			`  Tool results:         ${s.totalToolResults}`,
			`  Sessions analyzed:    ${s.sessionsAnalyzed}`,
			"",
			"  ── Proposals ──",
			`    open:      ${s.proposalsByStatus.open}`,
			`    applied:   ${s.proposalsByStatus.applied}`,
			`    rejected:  ${s.proposalsByStatus.rejected}`,
			`    duplicate: ${s.proposalsByStatus.duplicate}`,
			"",
			"  ── Analysis graph ──",
			`  Nodes: ${s.analysis.nodes}   Edges: ${s.analysis.edges}   Runs: ${s.analysis.runs}`,
			...(kindLines.length > 0 ? ["  Nodes by kind:", ...kindLines] : []),
			...(analyzerLines.length > 0 ? ["  Nodes by analyzer:", ...analyzerLines] : []),
			"",
			...coverage,
			"",
			"  ═══════════════════════════════════════",
			"  ── Token & tool-call stats ──",
			"",
			...tokenBlock("Combined (Pi + Claude)", t.combined),
			"",
			...tokenBlock("Pi", t.pi),
			"",
			...tokenBlock("Claude", t.claude),
			"",
			"  ── Ratios (Pi / Claude) ──",
			`  Turns:              ${fmtRatio(t.ratios.turns)}`,
			`  Tool calls:         ${fmtRatio(t.ratios.toolCalls)}`,
			`  Input tokens:       ${fmtRatio(t.ratios.input)}`,
			`  Output tokens:      ${fmtRatio(t.ratios.output)}`,
			`  Cache read:         ${fmtRatio(t.ratios.cacheRead)}`,
			`  Cache write:        ${fmtRatio(t.ratios.cacheWrite)}`,
			`  Input / turn:       ${fmtRatio(t.ratios.inputPerTurn)}`,
			`  Output / turn:      ${fmtRatio(t.ratios.outputPerTurn)}`,
			`  Tool calls / turn:  ${fmtRatio(t.ratios.toolCallsPerTurn)}`,
		];
		const text = lines.join("\n");
		ctx.ui.notify(text, "info");
		console.log(text);
	} finally {
		await db.close();
	}
}

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics with token and tool-call breakdowns, plus the analyzer-coverage summary (which registered analyzers have run against which sessions — #195). Flags: --as-of <ts|7d|24h> / --as-of-run <id> to view stats as of a past point (labelled as a view, not current state).",
		handler: prospectStats,
	});
}
