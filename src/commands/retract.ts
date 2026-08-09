/**
 * `/prospect-retract` — make retraction legible and reversible, and provide the
 * space-reclaim escape hatch.
 *
 *   prospect retract --list                                   → retracted nodes + provenance
 *   prospect retract --undo <gcRunId>                         → reverse a retraction (clear the tombstone)
 *   prospect retract --purge --retracted-before <timestamp>   → physically delete retracted nodes before ts
 *
 * Retraction itself is performed by `/prospect-gc` (which sets retracted_at
 * rather than deleting). This command surfaces, reverses, and — only when space
 * is actually needed — physically purges the deliberately retained tombstones.
 * Human decisions and remediations are never touched by any of these.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { parseFlags, parseTimestamp } from "../timepoint.js";
import { listRetracted, unretract, purgeRetractedBefore } from "../db/gc.js";
import { getDbPath } from "../config.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function short(s: string, n = 8): string {
	return s.length > n ? s.slice(0, n) : s;
}

export async function prospectRetract(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const { flags } = parseFlags(rawArgs ?? "");

	const db = new Database(getDbPath());
	migrate(db);
	try {
		if (flags["list"] !== undefined) {
			const rows = listRetracted(db);
			if (rows.length === 0) {
				output(ctx, "No retracted nodes.");
				return;
			}
			const lines = [`Retracted nodes (${rows.length}):`];
			for (const r of rows) {
				lines.push(`  ${short(r.id)}  ${r.analyzer_id.padEnd(20)} kind=${r.node_kind}  created=${r.created_at}  retracted=${r.retracted_at}  by=${short(r.retracted_by_run, 12)}`);
			}
			output(ctx, lines.join("\n"));
			return;
		}

		if (flags["undo"] !== undefined) {
			const count = unretract(db, flags["undo"]);
			output(ctx, count > 0 ? `Un-retracted ${count} node(s) (restored them to the live view).` : `No retracted nodes found for gc id '${flags["undo"]}'.`);
			return;
		}

		if (flags["purge"] !== undefined) {
			const ts = flags["retracted-before"];
			if (!ts) {
				output(ctx, "Usage: prospect retract --purge --retracted-before <timestamp>", "warning");
				return;
			}
			const at = parseTimestamp(ts);
			const res = purgeRetractedBefore(db, at);
			output(ctx, `Purged ${res.nodes} retracted node(s), ${res.edges} edge(s), ${res.proposals} proposal(s) retracted before ${at}.`);
			return;
		}

		output(ctx, "Usage: prospect retract --list | --undo <gcRunId> | --purge --retracted-before <ts>", "warning");
	} finally {
		db.close();
	}
}

export function registerRetractCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-retract", {
		description:
			"Make retraction (from /prospect-gc) legible and reversible, and provide the space escape hatch. --list shows retracted nodes + provenance; --undo <gcRunId> reverses a retraction; --purge --retracted-before <ts> physically deletes retracted nodes from before ts. Never touches decisions/remediations.",
		handler: prospectRetract,
	});
}
