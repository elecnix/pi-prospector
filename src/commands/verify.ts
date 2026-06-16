import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getAllAnalysisNodes } from "../db/analysis-queries.js";
import { computeOutputKey } from "../analyze/input-hash.js";
import { getDbPath } from "../config.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

export interface VerifyMismatch {
	id: string;
	analyzerId: string;
	stored: string;
	recomputed: string;
}

/**
 * Recompute every node's `output_key` from its stored `(input_key, content)` and
 * confirm it matches. Because identities are content-addressed, any drift means
 * the content was altered out of band or the stored key is stale. Pure read.
 */
export function verifyNodes(db: Database.Database): { total: number; mismatches: VerifyMismatch[] } {
	const nodes = getAllAnalysisNodes(db);
	const mismatches: VerifyMismatch[] = [];
	for (const n of nodes) {
		let content: unknown;
		try {
			content = JSON.parse(n.content_json);
		} catch {
			mismatches.push({ id: n.id, analyzerId: n.analyzer_id, stored: n.output_key, recomputed: "<unparseable content>" });
			continue;
		}
		const recomputed = computeOutputKey(n.input_key, content);
		if (recomputed !== n.output_key) {
			mismatches.push({ id: n.id, analyzerId: n.analyzer_id, stored: n.output_key, recomputed });
		}
	}
	return { total: nodes.length, mismatches };
}

export async function prospectVerify(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const { total, mismatches } = verifyNodes(db);
		if (total === 0) {
			output(ctx, "No analysis nodes to verify.");
			return;
		}
		if (mismatches.length === 0) {
			output(ctx, `✓ ${total} node(s) verified: every output_key is consistent with its content.`);
			return;
		}
		const lines = mismatches
			.slice(0, 50)
			.map((m) => `  ${m.id.slice(0, 8)} ${m.analyzerId} stored=${m.stored} recomputed=${m.recomputed}`);
		output(
			ctx,
			`✗ ${mismatches.length} of ${total} node(s) failed verification (content does not match output_key):\n${lines.join("\n")}`,
			"error",
		);
	} finally {
		db.close();
	}
}

export function registerVerifyCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-verify", {
		description: "Verify analysis-graph integrity: recompute each node's content-addressed output_key and confirm it matches.",
		handler: prospectVerify,
	});
}
