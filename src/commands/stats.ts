import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getDbPath } from "../config.js";

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics",
		handler: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
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
				const text = lines.join("\n");
				ctx.ui.notify(text, "info");
				console.log(text);
			} finally {
				db.close();
			}
		},
	});
}