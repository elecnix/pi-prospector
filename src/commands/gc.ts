/**
 * `/prospect-gc` — a supported inverse for a run or an analyzer.
 *
 *   prospect gc --run <id> [--apply]
 *   prospect gc --analyzer <id> [--apply]
 *   prospect gc --since <timestamp> [--apply]
 *
 * Default is a dry run: it reports the full deletion set (nodes grouped by
 * analyzer and node kind, plus the edges and proposals that trail depends on)
 * and changes nothing. Pass `--apply` to actually perform the deletion. Human
 * decisions and remediations are never touched.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { parseFlags, parseTimestamp } from "../timepoint.js";
import { computeDeletionSet, applyDeletionSet, type GcCatalog, type GcTarget } from "../db/gc.js";
import { getDbPath } from "../config.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function renderCatalog(catalog: GcCatalog): string[] {
	const lines: string[] = [];
	lines.push(`  nodes: ${catalog.nodes.length}  (by analyzer:)`);
	for (const [analyzer, n] of Object.entries(catalog.nodesByAnalyzer).sort()) {
		lines.push(`    ${analyzer}: ${n}`);
		// node kind breakdown for each analyzer
		const kinds = catalog.nodes.filter((x) => x.analyzerId === analyzer);
		const byKind: Record<string, number> = {};
		for (const k of kinds) byKind[k.nodeKind] = (byKind[k.nodeKind] ?? 0) + 1;
		lines.push(`        ${Object.entries(byKind).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
	}
	lines.push(`  edges: ${catalog.edgeIds.length}`);
	lines.push(`  proposals: ${catalog.proposalIds.length}`);
	return lines;
}

export async function prospectGc(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const { flags } = parseFlags(rawArgs ?? "");
	const runId = flags["run"];
	const analyzerId = flags["analyzer"];
	const since = flags["since"];
	const applyFlag = flags["apply"] !== undefined;

	const targets = [runId, analyzerId, since].filter((v) => v !== undefined).length;
	if (targets === 0) {
		output(ctx, "Usage: prospect gc --run <id> | --analyzer <id> | --since <timestamp> [--apply]", "warning");
		return;
	}
	if (targets > 1) {
		output(ctx, "Use exactly one of: --run, --analyzer, --since", "warning");
		return;
	}

	const db = new Database(getDbPath());
	migrate(db);
	try {
		let target: GcTarget;
		if (runId !== undefined) target = { kind: "run", runId };
		else if (analyzerId !== undefined) target = { kind: "analyzer", analyzerId };
		else target = { kind: "since", since: parseTimestamp(since!) };

		const catalog = computeDeletionSet(db, target);

		const describe = `${target.kind === "run" ? `run ${target.runId.slice(0, 8)}` : target.kind === "analyzer" ? `analyzer ${target.analyzerId}` : `everything after ${target.since}`}`;
		if (catalog.nodes.length === 0 && catalog.edgeIds.length === 0) {
			output(ctx, `gc ${describe}: nothing to remove.`);
			return;
		}

		if (catalog.nodes.length > 0 && !applyFlag) {
			const lines = [`Dry run — ${describe} would remove:`, ...renderCatalog(catalog), "", "  Re-run with --apply to actually perform (never touches decisions/remediations)."];
			output(ctx, lines.join("\n"), "warning");
			return;
		}

		if (!applyFlag) {
			const lines = [`Dry run — ${describe} would remove:`, ...renderCatalog(catalog), "", "  Re-run with --apply to actually perform (never touches decisions/remediations)."];
			output(ctx, lines.join("\n"), "warning");
			return;
		}

		const result = applyDeletionSet(db, catalog);
		output(
			ctx,
			[
				`gc ${describe} applied.`,
				`  removed ${result.removedNodes} node(s), ${result.removedEdges} edge(s), ${result.removedProposals} proposal(s)${result.removedRuns ? `, ${result.removedRuns} run(s)` : ""}.`,
				"  Human decisions and remediations were left untouched.",
				"  Run /prospect-verify to confirm the graph is still referentially intact.",
			].join("\n"),
		);
	} finally {
		db.close();
	}
}

export function registerGcCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-gc", {
		description:
			"Remove one run's or one analyzer's output (or everything after a timestamp), in one transaction: the nodes, the edges from them, the edges pointing at them, and the proposals materialised from them — never human decisions/remediations. Dry run by default; pass --apply to perform.",
		handler: prospectGc,
	});
}
