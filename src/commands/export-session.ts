/**
 * `/prospect-export-session` — rebuild a Claude Code transcript from the index (#400).
 *
 *   prospect export-session --session <id> [--out DIR]
 *   prospect export-session --all-missing [--out DIR]
 *
 * Claude Code deletes transcripts after its retention period, and the index is
 * then the only copy. The transcript is rebuilt best-effort from the message
 * columns, the stored extras and the session events, with a `.restore.json`
 * beside it that lists what is lost. Nothing is written into
 * the sessions root unless `--out` points there, and an existing file is never
 * replaced.
 */
import * as path from "node:path";
import type { ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { parseFlags } from "../timepoint.js";
import { getClaudeSessionsDir, getDbPath } from "../config.js";
import { exportClaudeSession, getExportableSession, listMissingClaudeSessions, type ExportOutcome } from "../sync/claude-export.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/** A sibling of the sessions root, which neither Claude Code nor the sync reads. */
function defaultOutDir(): string {
	const root = getClaudeSessionsDir();
	return path.join(path.dirname(root), `${path.basename(root)}-restored`);
}

export async function prospectExportSession(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const { flags } = parseFlags(rawArgs ?? "");
	const sessionId = flags["session"];
	const allMissing = flags["all-missing"] !== undefined;
	if ((sessionId === undefined || sessionId === "") === !allMissing) {
		output(ctx, "Usage: prospect export-session --session <id> | --all-missing [--out DIR]", "warning");
		return;
	}
	const outDir = path.resolve(flags["out"] ? flags["out"].replace(/^~/, process.env["HOME"] ?? "~") : defaultOutDir());

	const db = openAsyncDatabase(getDbPath());
	try {
		await migrate(db);
		const root = getClaudeSessionsDir();
		const sessions = allMissing ? await listMissingClaudeSessions(db) : [];
		if (!allMissing) {
			const s = await getExportableSession(db, sessionId!);
			if (!s) {
				output(ctx, `No Claude Code session "${sessionId}" in the index.`, "error");
				return;
			}
			sessions.push(s);
		}

		const outcomes: ExportOutcome[] = [];
		const failures: string[] = [];
		for (const s of sessions) {
			try {
				outcomes.push(await exportClaudeSession(db, s, outDir, root));
			} catch (err) {
				failures.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const rebuiltOutcomes = outcomes.filter((o): o is Extract<ExportOutcome, { kind: "rebuilt" }> => o.kind === "rebuilt");
		const rebuilt = rebuiltOutcomes.length;
		const fromExtras = rebuiltOutcomes.reduce((n, o) => n + o.fromExtras, 0);
		const fromProjection = rebuiltOutcomes.reduce((n, o) => n + o.fromProjection, 0);
		const omitted = rebuiltOutcomes.reduce((n, o) => n + o.omittedStrings, 0);
		const skipped = outcomes.filter((o): o is Extract<ExportOutcome, { kind: "skipped" }> => o.kind === "skipped");
		const lines = [
			"⛏️ Prospect export-session complete",
			`  Output:              ${outDir}`,
			`  Rebuilt:             ${rebuilt} sessions (each has a .restore.json listing what is lost)`,
			`  Messages:            ${fromExtras} from stored extras, ${fromProjection} from the reduced projection alone`,
			`  Not restorable:      ${omitted} stored as size and hash only`,
			`  Skipped:             ${skipped.length}`,
			`  Failed:              ${failures.length}`,
		];
		for (const s of skipped.slice(0, 5)) lines.push(`    skipped ${s.session}: ${s.reason}`);
		for (const f of failures.slice(0, 5)) lines.push(`    failed ${f}`);
		output(ctx, lines.join("\n"), failures.length > 0 ? "error" : "info");
	} finally {
		await db.close();
	}
}
