import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getDbPath } from "../config.js";

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const s = getStats(db);
				const kindLines = Object.entries(s.analysis.nodesByKind).map(([k, v]) => `    ${k}: ${v}`);
				const lines = [
					"╔══════════════════════════════════════════╗",
					"║          ⛏️  Prospector Stats             ║",
					"╚══════════════════════════════════════════╝",
					"",
					"  ── Sessions ──",
					`  Sessions indexed:     ${s.totalSessions}`,
					`  Messages (user+asst): ${s.totalMessages}`,
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
				];
				const text = lines.join("\n");
				ctx.ui.notify(text, "info");
				console.log(text);
			} finally {
				db.close();
			}
		},
	});
}
