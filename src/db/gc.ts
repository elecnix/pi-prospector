/**
 * `prospect gc` — a supported inverse for a run or an analyzer.
 *
 * There was no safe way to undo a run or remove an analyzer's output; it took raw
 * SQL, and doing it by hand was easy to get wrong in a way nothing detected (the
 * concrete incident: deleting nodes and their outgoing edges while leaving
 * thousands of dangling `consumes` edges pointing at the removed nodes — and
 * `verify` still reported a clean graph). The correct deletion set is not "the
 * nodes": it is
 *
 *   1. the nodes themselves,
 *   2. edges *from* those nodes,
 *   3. edges *pointing at* those nodes by `output_key` (from other analyzers),
 *   4. proposals materialised from them (which carry the `produces`/`anchors`
 *      trails to the removed nodes),
 *   5. and never `proposal_decisions` / `remediations`, which are external human
 *      input and the one thing that cannot be recomputed.
 *
 * (See also the retraction work, #52, which makes gc set a tombstone instead of
 * deleting so it becomes reversible; until then this is the conventional,
 * supported destructive path.)
 *
 * One transaction, all five categories handled together. `--dry-run` reports the
 * full deletion set without changing anything.
 */

import type Database from "better-sqlite3";

export type GcTarget =
	| { kind: "run"; runId: string }
	| { kind: "analyzer"; analyzerId: string }
	| { kind: "since"; since: string };

export interface GcCatalog {
	nodes: Array<{ id: string; analyzerId: string; nodeKind: string }>;
	nodesByKind: Record<string, number>;
	nodesByAnalyzer: Record<string, number>;
	edgeIds: string[];
	proposalIds: Array<{ id: string; inputKey: string }>;
	runIdsToDelete: string[];
}

/** Batched IN-clause helper so large deletion sets avoid SQLite variable limits. */
function chunk<T>(arr: readonly T[], size = 400): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function selectNodes(db: Database.Database, target: GcTarget): Array<{ id: string; analyzer_id: string; node_kind: string; output_key: string }> {
	switch (target.kind) {
		case "run":
			return db.prepare("SELECT id, analyzer_id, node_kind, output_key FROM analysis_nodes WHERE run_id = ?").all(target.runId) as Array<{ id: string; analyzer_id: string; node_kind: string; output_key: string }>;
		case "analyzer":
			return db.prepare("SELECT id, analyzer_id, node_kind, output_key FROM analysis_nodes WHERE analyzer_id = ?").all(target.analyzerId) as Array<{ id: string; analyzer_id: string; node_kind: string; output_key: string }>;
		case "since":
			return db.prepare("SELECT id, analyzer_id, node_kind, output_key FROM analysis_nodes WHERE created_at > ?").all(target.since) as Array<{ id: string; analyzer_id: string; node_kind: string; output_key: string }>;
	}
}

/** Compute the full deletion set for a gc target. Pure read; changes nothing. */
export function computeDeletionSet(db: Database.Database, target: GcTarget): GcCatalog {
	const nodeRows = selectNodes(db, target);

	const nodes = nodeRows.map((r) => ({ id: r.id, analyzerId: r.analyzer_id, nodeKind: r.node_kind }));
	const nodeIds = nodeRows.map((r) => r.id);
	const outputKeys = nodeRows.map((r) => r.output_key).filter(Boolean);

	const nodesByKind: Record<string, number> = {};
	const nodesByAnalyzer: Record<string, number> = {};
	for (const r of nodeRows) {
		nodesByKind[r.node_kind] = (nodesByKind[r.node_kind] ?? 0) + 1;
		nodesByAnalyzer[r.analyzer_id] = (nodesByAnalyzer[r.analyzer_id] ?? 0) + 1;
	}

	// Edges: (a) from removed nodes, (b) pointing at removed output_keys (the
	// dangling-trail category that caused the manual-cleanup incident), (c)
	// produces edges pointing at proposals materialised from removed nodes.
	const edgeIds = new Set<string>();
	const stmtFrom = db.prepare("SELECT id FROM analysis_edges WHERE from_node_id = ?");
	for (const id of nodeIds) for (const e of stmtFrom.all(id) as Array<{ id: string }>) edgeIds.add(e.id);

	const stmtTo = db.prepare("SELECT id FROM analysis_edges WHERE to_ref_kind = ? AND to_ref_id = ?");
	for (const ok of outputKeys) for (const e of stmtTo.all("analysis_node", ok) as Array<{ id: string }>) edgeIds.add(e.id);

	// Proposals materialised from removed nodes.
	const proposalIds: Array<{ id: string; inputKey: string }> = [];
	for (const c of chunk(nodeIds)) {
		const placeholders = c.map(() => "?").join(",");
		const rows = db.prepare(`SELECT id, input_key FROM proposals WHERE source_node_id IN (${placeholders})`).all(...c) as Array<{ id: string; input_key: string }>;
		for (const r of rows) proposalIds.push({ id: r.id, inputKey: r.input_key });
	}
	// Drop produces edges that point at the removed proposals (from any surviving
	// node), so no proposal trail to a deleted proposal remains.
	for (const p of proposalIds) {
		for (const e of stmtTo.all("proposal", p.id) as Array<{ id: string }>) edgeIds.add(e.id);
	}

	const runIdsToDelete = target.kind === "run" ? [target.runId] : [];

	return {
		nodes,
		nodesByKind,
		nodesByAnalyzer,
		edgeIds: [...edgeIds],
		proposalIds,
		runIdsToDelete,
	};
}

export interface GcResult {
	removedNodes: number;
	removedEdges: number;
	removedProposals: number;
	removedRuns: number;
	/** Always empty — decisions/remediations are never touched. */
	untouchedHumanInput: boolean;
}

/** Apply a deletion set in one transaction. Never touches decisions/remediations. */
export function applyDeletionSet(db: Database.Database, catalog: GcCatalog): GcResult {
	const tx = db.transaction(() => {
		const nodeIds = catalog.nodes.map((n) => n.id);
		// Order matters for FKs: proposals reference source nodes, and edges reference
		// their from node — so remove proposals and edges before the nodes they point
		// at, or the DELETE hits a FOREIGN KEY constraint.
		for (const c of chunk(catalog.proposalIds.map((p) => p.id))) {
			const ph = c.map(() => "?").join(",");
			db.prepare(`DELETE FROM proposals WHERE id IN (${ph})`).run(...c);
		}
		for (const c of chunk(nodeIds)) {
			const ph = c.map(() => "?").join(",");
			db.prepare(`DELETE FROM analysis_edges WHERE from_node_id IN (${ph})`).run(...c);
			db.prepare(`DELETE FROM analysis_nodes WHERE id IN (${ph})`).run(...c);
		}
		for (const c of chunk(catalog.edgeIds)) {
			const ph = c.map(() => "?").join(",");
			db.prepare(`DELETE FROM analysis_edges WHERE id IN (${ph})`).run(...c);
		}
		for (const c of chunk(catalog.runIdsToDelete)) {
			const ph = c.map(() => "?").join(",");
			db.prepare(`DELETE FROM analysis_runs WHERE id IN (${ph})`).run(...c);
		}
	});
	tx();
	return {
		removedNodes: catalog.nodes.length,
		removedEdges: catalog.edgeIds.length,
		removedProposals: catalog.proposalIds.length,
		removedRuns: catalog.runIdsToDelete.length,
		untouchedHumanInput: true,
	};
}
