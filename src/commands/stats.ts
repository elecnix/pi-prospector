import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getDbPath } from "../config.js";
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

export async function prospectStats(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const s = getStats(db);
		const kindLines = Object.entries(s.analysis.nodesByKind).map(([k, v]) => `    ${k}: ${v}`);
		const t = s.tokens;

		const lines = [
			"╔══════════════════════════════════════════╗",
			"║          ⛏️  Prospector Stats             ║",
			"╚══════════════════════════════════════════╝",
			"",
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
		db.close();
	}
}

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics with token and tool-call breakdowns",
		handler: prospectStats,
	});
}
