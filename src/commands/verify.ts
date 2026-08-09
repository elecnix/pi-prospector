import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getAllAnalysisNodes } from "../db/analysis-queries.js";
import { checkGraphIntegrity, type DanglingEdge } from "../db/graph-integrity.js";
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

export interface VerifyResult {
	nodes: number;
	contentMismatches: VerifyMismatch[];
	edges: number;
	dangling: DanglingEdge[];
}

/**
 * Recompute every node's `output_key` from its stored `(input_key, content)` and
 * confirm it matches. Because identities are content-addressed, any drift means
 * the content was altered out of band or the stored key is stale. Pure read.
 *
 * This alone is NOT a complete verification: content hashing cannot detect a
 * broken evidence trail (see {@link verifyGraph}). Kept exported for callers
 * that only need the content check.
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

/**
 * Recompute every node's `output_key` from its stored `(input_key, content)` and
 * confirm it matches, then validate every edge's referential integrity. Because
 * identities are content-addressed, any drift means the content was altered out
 * of band; a dangling edge means a trail back to the evidence is broken. Pure
 * read.
 *
 * The edge check is what makes verification honest: content hashing alone cannot
 * represent the failure of a broken evidence trail, which is the defect class
 * this tool exists to catch. (`prospect show` walking a trail will fail
 * silently — `verify` must not.)
 */
export function verifyGraph(db: Database.Database): VerifyResult {
	const { total, mismatches } = verifyNodes(db);
	const integrity = checkGraphIntegrity(db);
	return {
		nodes: total,
		contentMismatches: mismatches,
		edges: integrity.checked,
		dangling: integrity.all,
	};
}

/** Group dangling edges by (analyzer, edge kind) for the report. */
function groupDangling(dangling: DanglingEdge[]): string[] {
	const byKey = new Map<string, DanglingEdge[]>();
	for (const d of dangling) {
		const key = `${d.fromAnalyzerId} · ${d.edgeKind} → ${d.toRefKind}`;
		const list = byKey.get(key);
		if (list) list.push(d);
		else byKey.set(key, [d]);
	}
	const lines: string[] = [];
	for (const [key, list] of byKey) {
		lines.push(`  ${key}: ${list.length} edge(s)`);
		for (const d of list.slice(0, 10)) {
			lines.push(`      ${d.edgeId.slice(0, 8)} -> ${d.toRefId.slice(0, 12)}… (expected ${d.expectedIn})`);
		}
		if (list.length > 10) lines.push(`      …${list.length - 10} more`);
	}
	return lines;
}

export async function prospectVerify(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const r = verifyGraph(db);
		const empty = r.nodes === 0 && r.edges === 0;
		const failures = r.contentMismatches.length + r.dangling.length;

		if (empty) {
			output(ctx, "No analysis graph to verify (no nodes, no edges).");
			return;
		}

		const nodeLine =
			r.contentMismatches.length === 0
				? `✓ ${r.nodes} node(s): every output_key is consistent with its content.`
				: `✗ ${r.nodes} node(s): ${r.contentMismatches.length} output_key mismatch(es).`;
		const edgeLine =
			r.dangling.length === 0
				? `✓ ${r.edges} edge(s): every reference resolves (evidence trails intact).`
				: `✗ ${r.edges} edge(s): ${r.dangling.length} dangling reference(s).`;

		if (failures === 0) {
			output(ctx, `${nodeLine}\n${edgeLine}`);
			return;
		}

		const lines: string[] = [`✗ ${failures} integrity problem(s) found:`, nodeLine, edgeLine];
		if (r.contentMismatches.length > 0) {
			lines.push(`  Content mismatches (${r.contentMismatches.length}):`);
			for (const m of r.contentMismatches.slice(0, 50)) {
				lines.push(`    ${m.id.slice(0, 8)} ${m.analyzerId} stored=${m.stored} recomputed=${m.recomputed}`);
			}
			if (r.contentMismatches.length > 50) lines.push(`    …${r.contentMismatches.length - 50} more`);
		}
		if (r.dangling.length > 0) {
			lines.push(`  Dangling edges by analyzer · edge kind (${r.dangling.length}):`);
			lines.push(...groupDangling(r.dangling));
		}
		output(ctx, lines.join("\n"), "error");
	} finally {
		db.close();
	}
}

export function registerVerifyCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-verify", {
		description:
			"Verify analysis-graph integrity: recompute each node's output_key AND validate every edge's referential integrity (evidence trails resolve to real targets).",
		handler: prospectVerify,
	});
}
