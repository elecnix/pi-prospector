/**
 * `prospect gc` and retraction — append-only enforced rather than conventional.
 *
 * gc is a supported inverse for a run or an analyzer, and it **retracts** rather
 * than deletes: it marks the target nodes with `retracted_at` (and a
 * `retracted_by_run` provenance), which hides them from every live read and from
 * scanning — so their unit classifies `missing` and is recomputed — while the
 * node itself (and its history) stays in the graph. This makes gc reversible
 * (`unretract`) and keeps as-of reads correct: a node is visible at T if it was
 * created by then and retracted after T.
 *
 * What a retraction removes besides the tombstone: the **proposals materialised
 * from the retracted nodes** and the `produces` edges to those proposals, so
 * nothing in the review store points at analysis the graph no longer stands
 * behind. Everything else stays — because the nodes still physically exist,
 * every reference still resolves, and `verify` stays clean. Human decisions and
 * remediations are never touched.
 */

import { type AsyncDatabase } from "./async-db.js";
import { uuidv7 } from "../analyze/input-hash.js";

export type GcTarget =
	| { kind: "run"; runId: string }
	| { kind: "analyzer"; analyzerId: string }
	| { kind: "since"; since: string };

export interface GcCatalog {
	nodes: Array<{ id: string; analyzerId: string; nodeKind: string }>;
	nodesByKind: Record<string, number>;
	nodesByAnalyzer: Record<string, number>;
	proposalIds: Array<{ id: string; inputKey: string }>;
}

/** Batched IN-clause helper so large deletion sets avoid SQLite variable limits. */
function chunk<T>(arr: readonly T[], size = 400): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

async function selectNodes(db: AsyncDatabase, target: GcTarget): Promise<Array<{ id: string; analyzer_id: string; node_kind: string }>> {
	switch (target.kind) {
		case "run":
			return (await db.prepare("SELECT id, analyzer_id, node_kind FROM analysis_nodes WHERE run_id = ?").all(target.runId)) as Array<{ id: string; analyzer_id: string; node_kind: string }>;
		case "analyzer":
			return (await db.prepare("SELECT id, analyzer_id, node_kind FROM analysis_nodes WHERE analyzer_id = ?").all(target.analyzerId)) as Array<{ id: string; analyzer_id: string; node_kind: string }>;
		case "since":
			return (await db.prepare("SELECT id, analyzer_id, node_kind FROM analysis_nodes WHERE created_at > ?").all(target.since)) as Array<{ id: string; analyzer_id: string; node_kind: string }>;
	}
}

/** Compute the nodes a gc target names, and the proposals materialised from them. Pure read. */
export async function computeDeletionSet(db: AsyncDatabase, target: GcTarget): Promise<GcCatalog> {
	const nodeRows = await selectNodes(db, target);
	const nodes = nodeRows.map((r) => ({ id: r.id, analyzerId: r.analyzer_id, nodeKind: r.node_kind }));
	const nodeIds = nodes.map((n) => n.id);

	const nodesByKind: Record<string, number> = {};
	const nodesByAnalyzer: Record<string, number> = {};
	for (const r of nodeRows) {
		nodesByKind[r.node_kind] = (nodesByKind[r.node_kind] ?? 0) + 1;
		nodesByAnalyzer[r.analyzer_id] = (nodesByAnalyzer[r.analyzer_id] ?? 0) + 1;
	}

	const proposalIds: Array<{ id: string; inputKey: string }> = [];
	for (const c of chunk(nodeIds)) {
		const placeholders = c.map(() => "?").join(",");
		const rows = (await db.prepare(`SELECT id, input_key FROM proposals WHERE source_node_id IN (${placeholders})`).all(...c)) as Array<{ id: string; input_key: string }>;
		for (const r of rows) proposalIds.push({ id: r.id, inputKey: r.input_key });
	}

	return { nodes, nodesByKind, nodesByAnalyzer, proposalIds };
}

export interface GcResult {
	/** The gc operation id — the value written to retracted_by_run (for unretract). */
	gcRunId: string;
	retractedNodes: number;
	removedProposals: number;
	untouchedHumanInput: boolean;
}

/**
 * Retract the target nodes (set the tombstone), and remove the proposals
 * materialised from them plus the produces edges to those proposals. Nodes and
 * other edges stay, so the graph remains referentially intact and reversible.
 */
export async function retractNodes(db: AsyncDatabase, catalog: GcCatalog, gcRunId: string, now: string): Promise<GcResult> {
	const tx = db.transaction(async () => {
		const nodeIds = catalog.nodes.map((n) => n.id);
		for (const c of chunk(nodeIds)) {
			const ph = c.map(() => "?").join(",");
			await db.prepare(`UPDATE analysis_nodes SET retracted_at = ?, retracted_by_run = ? WHERE id IN (${ph})`).run(now, gcRunId, ...c);
		}
		const proposalIds = catalog.proposalIds.map((p) => p.id);
		for (const c of chunk(proposalIds)) {
			const ph = c.map(() => "?").join(",");
			await db.prepare(`DELETE FROM proposals WHERE id IN (${ph})`).run(...c);
		}
		// Drop produces edges from the retracted nodes to the removed proposals.
		for (const c of chunk(nodeIds)) {
			const ph = c.map(() => "?").join(",");
			await db.prepare(`DELETE FROM analysis_edges WHERE from_node_id IN (${ph}) AND to_ref_kind = 'proposal'`).run(...c);
		}
	});
	await tx();
	return {
		gcRunId,
		retractedNodes: catalog.nodes.length,
		removedProposals: catalog.proposalIds.length,
		untouchedHumanInput: true,
	};
}

/** Retracted nodes (with their provenance), oldest retraction first. */
export async function listRetracted(db: AsyncDatabase): Promise<Array<{ id: string; analyzer_id: string; node_kind: string; created_at: string; retracted_at: string; retracted_by_run: string }>> {
	return (await db
		.prepare("SELECT id, analyzer_id, node_kind, created_at, retracted_at, retracted_by_run FROM analysis_nodes WHERE retracted_at IS NOT NULL ORDER BY retracted_at ASC, rowid ASC")
		.all()) as Array<{ id: string; analyzer_id: string; node_kind: string; created_at: string; retracted_at: string; retracted_by_run: string }>;
}

/** Reverse a retraction: clear the tombstone for every node retracted by `gcRunId`. Returns count. */
export async function unretract(db: AsyncDatabase, gcRunId: string): Promise<number> {
	const res = await db.prepare("UPDATE analysis_nodes SET retracted_at = NULL, retracted_by_run = NULL WHERE retracted_by_run = ?").run(gcRunId);
	return res.changes;
}

/**
 * Space-reclaim escape hatch: physically DELETE retracted nodes retracted before
 * `ts`, and the edges pointing at/by them, plus their detached proposals. This is
 * the deliberate, separate act that reclaims the storage retraction deliberately
 * does not. Never touches decisions/remediations.
 */
export async function purgeRetractedBefore(db: AsyncDatabase, ts: string): Promise<{ nodes: number; edges: number; proposals: number }> {
	let edges = 0;
	let proposals = 0;
	const tx = db.transaction(async () => {
		const eligible = "retracted_at IS NOT NULL AND retracted_at < ?";
		edges += (await db.prepare(`DELETE FROM analysis_edges WHERE from_node_id IN (SELECT id FROM analysis_nodes WHERE ${eligible})`).run(ts)).changes;
		edges += (await db.prepare(`DELETE FROM analysis_edges WHERE to_ref_kind = 'analysis_node' AND to_ref_id IN (SELECT output_key FROM analysis_nodes WHERE ${eligible})`).run(ts)).changes;
		proposals += (await db.prepare(`DELETE FROM proposals WHERE source_node_id IN (SELECT id FROM analysis_nodes WHERE ${eligible})`).run(ts)).changes;
		const nodeDel = await db.prepare(`DELETE FROM analysis_nodes WHERE ${eligible}`).run(ts);
		return nodeDel.changes;
	});
	const nodes = await tx();
	return { nodes, edges, proposals };
}

/** A new gc operation id (written to retracted_by_run so it can be unretracted). */
export function newGcRunId(): string {
	return uuidv7();
}
