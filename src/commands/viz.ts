/**
 * `/prospect-viz` — render one analysed session as a self-contained
 * interactive HTML page: transcript rail, analysis graph with typed edges,
 * proposals with click-through evidence, and remediations.
 *
 * This is output machinery, not analysis. It opens the index read-only in
 * spirit — it writes no node, no run, no edge, no proposal — so rendering is
 * safe to repeat any number of times, and the artifact is re-derivable from
 * scratch every time.
 *
 *   viz <session-id> [--out DIR]    render that session's page
 *   viz                             list sessions to pick from
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { getDbPath, loadConfig } from "../config.js";
import { getSessionLabels } from "../db/queries.js";
import { collectVizData } from "../viz/collect.js";
import { renderVizHtml, vizFilename } from "../viz/render.js";
import { VizArgsSchema, type VizArgs } from "../viz/types.js";
import { Check } from "typebox/value";

/** The command's own knobs, parsed from `--key value` pairs (schema: VizArgsSchema). */
export function parseVizArgs(raw: string): VizArgs {
	const args: VizArgs = { sessionId: "", outDir: "" };
	const parts = (raw ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if ((p === "--out" || p === "--out-dir") && parts[i + 1]) args.outDir = parts[++i]!;
		else if (!args.sessionId) args.sessionId = p;
	}
	if (!Check(VizArgsSchema, args)) throw new Error("viz: parsed arguments do not match the command schema");
	return args;
}

export async function prospectViz(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = parseVizArgs(rawArgs ?? "");
	const dbPath = getDbPath(loadConfig());
	if (!fs.existsSync(dbPath)) {
		out(ctx, `No index at ${dbPath}. Run sync first.`, "warning");
		return;
	}

	const db = openAsyncDatabase(dbPath);
	await migrate(db);
	try {
		if (!args.sessionId) {
			const labels = await getSessionLabels(db);
			const lines = ["Sessions — pass an id to render it:"];
			for (const s of labels) {
				lines.push(`  ${s.id}  ${s.name ?? "(unnamed)"}  [${s.source}] ${s.message_count} msgs`);
			}
			out(ctx, lines.join("\n"), labels.length === 0 ? "warning" : "info");
			return;
		}

		const target = await renderSessionPage(db, args.sessionId, args.outDir);
		out(ctx, `Wrote ${target}`, "info");
	} catch (err) {
		out(ctx, `viz: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		await db.close();
	}
}

/**
 * Collect + render + write one session's page. Returns the artifact path.
 * Exposed separately from the slash-command wrapper so tests can call it
 * against a fixture DB directly. A pure read: nothing here writes to the DB.
 */
export async function renderSessionPage(db: AsyncDatabase, sessionId: string, outDir: string): Promise<string> {
	const data = await collectVizData(db, { sessionId });
	const html = renderVizHtml(data);

	const dir = outDir || path.join(os.homedir(), "Documents");
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, vizFilename(sessionId));
	fs.writeFileSync(target, html, "utf8");
	return target;
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

export function registerVizCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-viz", {
		description:
			"Render one session as a self-contained interactive HTML page: transcript rail, analysis graph with typed edges, proposal click-through to anchored messages, remediations, revises lineage, filters and depth-collapse. `viz` lists sessions; `viz <session-id> [--out DIR]` renders. Reads only — never writes to the graph.",
		handler: prospectViz,
	});
}
