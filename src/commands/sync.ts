import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getDbPath, getSessionsDir } from "../config.js";

export function registerSyncCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-sync", {
		description: "Index session files into the prospector database (no LLM)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const dbPath = getDbPath();
			const db = new Database(dbPath);
			migrate(db);

			try {
				const result = runSync(db, getSessionsDir());
				const lines = [
					"⛏️ Prospect sync complete",
					`  Sessions processed: ${result.sessionsProcessed}`,
					`  Sessions skipped:   ${result.sessionsSkipped}`,
					`  Messages inserted:  ${result.messagesInserted}`,
					`  Forks resolved:     ${result.forksResolved}`,
				];
				if (result.errors.length > 0) {
					lines.push(`  Errors: ${result.errors.length}`);
					for (const e of result.errors.slice(0, 5)) lines.push(`    ${e}`);
				}
				const text = lines.join("\n");
				console.log(text);
				ctx.ui.notify(text, "info");
			} finally {
				db.close();
			}
		},
	});
}