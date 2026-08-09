import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listRuns } from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function short(s: string, n = 8): string {
	return s.length > n ? s.slice(0, n) : s;
}

/** List recent runs so their ids are discoverable for `prospect diff --runs` and `--as-of-run`. */
export async function prospectRuns(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const limitArg = parseInt((rawArgs ?? "").trim().split(/\s+/)[0] ?? "", 10);
	const limit = Number.isNaN(limitArg) || limitArg <= 0 ? 30 : limitArg;

	const db = new Database(getDbPath());
	migrate(db);
	try {
		const runs = listRuns(db, limit);
		if (runs.length === 0) {
			output(ctx, "No runs recorded yet. Run /prospect-analyze first.");
			return;
		}
		const lines = [`Recent runs (${runs.length}):`];
		for (const r of runs) {
			const when = r.finished_at ?? `${r.started_at} (in flight)`;
			lines.push(
				`  ${short(r.id)}  ${r.analyzer_id.padEnd(24)} mode=${r.mode.padEnd(10)} status=${r.status}` +
					` produced=${r.nodes_produced} skipped=${r.nodes_skipped}  ${when}` +
					(r.model_spec ? `  model=${r.model_spec}` : ""),
			);
		}
		lines.push("", "Use the full run id with: prospect diff --runs <A> <B>   or   prospect stats --as-of-run <id>");
		output(ctx, lines.join("\n"));
	} finally {
		db.close();
	}
}

export function registerRunsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-runs", {
		description: "List recent analysis runs (ids, mode, status, node counts, timestamps) so their ids are discoverable for diff --runs and --as-of-run.",
		handler: prospectRuns,
	});
}
