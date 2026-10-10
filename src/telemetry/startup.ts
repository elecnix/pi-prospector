import type { ExtensionCommandContext } from "../pi-stubs.js";
import { getDbPath } from "../config.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { askInPi } from "./consent.js";
import { sendDailyReport, type SendResult } from "./report.js";

/**
 * At pi startup: ask once whether to share usage totals, then send today's
 * report if one is due. The question needs pi's UI, so a headless run
 * (`--prospect`, print mode) skips it and sends nothing until the user answers.
 */
export async function onPiStartup(ctx: ExtensionCommandContext, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const select = ctx.ui.select;
	if (ctx.hasUI && select) await askInPi((title, options) => select(title, options), env);
	await sendWithOwnDb(env);
}

/** Send today's report with a database connection opened only when a send is due. */
export async function sendWithOwnDb(env: NodeJS.ProcessEnv = process.env): Promise<SendResult> {
	let db: AsyncDatabase | undefined;
	try {
		return await sendDailyReport({
			env,
			db: async () => {
				db = openAsyncDatabase(getDbPath());
				await migrate(db);
				return db;
			},
		});
	} finally {
		await db?.close();
	}
}
