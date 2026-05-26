import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getDbPath } from "../config.js";

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics",
		handler: async (_args, ctx) => {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const s = getStats(db);
				const lines = [
					"╔══════════════════════════════════════════╗",
					"║          ⛏️  Prospector Stats             ║",
					"╚══════════════════════════════════════════╝",
					"",
					`  Sessions indexed:    ${s.totalSessions}`,
					`  Messages (user+asst):${s.totalMessages}`,
					`  Tool results:        ${s.totalToolResults}`,
					`  Sessions analyzed:   ${s.messagesProcessed}`,
					"",
					"  Proposals:",
					`    new:      ${s.proposalsByStatus.new}`,
					`    accepted: ${s.proposalsByStatus.accepted}`,
					`    rejected: ${s.proposalsByStatus.rejected}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} finally {
				db.close();
			}
		},
	});
}