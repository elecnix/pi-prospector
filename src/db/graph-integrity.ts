/**
 * Referential integrity for the analysis graph.
 *
 * `prospect verify` historically recomputed every node's `output_key` from its
 * stored `(input_key, content)` and stopped there — it never read `analysis_edges`,
 * so a graph whose **evidence trails were broken** verified as clean. A dangling
 * `consumes` edge (pointing at an `output_key` that no longer exists) breaks the
 * invariant that a proposal can always be traced back, via edges, to the
 * conversation evidence that justifies it — yet nothing flagged it.
 *
 * This module fixes that asymmetry. It validates every edge's referential
 * integrity using the vocabulary in `edge-kinds.ts`: for each edge it confirms
 * the target — and the source node — actually exists. The important asymmetry
 * that motivated #49 is preserved: a node whose *consumers* disappear is harmless
 * (append-only lineage does that routinely), while a node whose *targets*
 * disappear is a broken trail. Only the latter is a defect, and it is exactly
 * what the `to_ref_id` resolution below detects.
 *
 * All SQL that reads graph shape lives here (per AGENTS.md, SQL stays in db/).
 */

import { type AsyncDatabase } from "./async-db.js";
import { REF_KINDS } from "../analyze/edge-kinds.js";

/**
 * An edge whose target (or source) does not resolve — a broken evidence trail.
 * `expectedIn` names the table/column the missing reference should have matched,
 * so the report points at what to recompute rather than at raw SQL.
 */
export interface DanglingEdge {
	edgeId: string;
	fromNodeId: string;
	/** The analyzer that owns the edge's source node; "?" when the source node is missing. */
	fromAnalyzerId: string;
	edgeKind: string;
	toRefKind: string;
	toRefId: string;
	expectedIn: string;
}

export interface GraphIntegrityResult {
	/** Total number of edges checked. */
	checked: number;
	/** Edges whose source node does not exist (orphan edges). */
	orphanSource: DanglingEdge[];
	/** Edges whose target does not resolve. */
	dangling: DanglingEdge[];
	/** Both broken classes, for convenience. */
	all: DanglingEdge[];
}

async function idSet(db: AsyncDatabase, table: string, column: string): Promise<Set<string>> {
	const rows = (await db.prepare(`SELECT ${column} AS id FROM ${table}`).all()) as Array<{ id: string | null }>;
	const out = new Set<string>();
	for (const r of rows) if (r.id != null) out.add(r.id);
	return out;
}

/**
 * Validate every edge's referential integrity: source node exists and the
 * target resolves per its `to_ref_kind`. Pure read; never throws on bad data.
 *
 *  | to_ref_kind       | target must exist as                |
 *  |-------------------|-------------------------------------|
 *  | `analysis_node`   | `analysis_nodes.output_key`         |
 *  | `session`         | `sessions.id`                       |
 *  | `message`         | `messages.id`                       |
 *  | `prompt_version`  | `prompt_registry.hash`              |
 *  | `config_version`  | `analyzer_configs.id`               |
 *  | `proposal`        | `proposals.id`                      |
 */
export async function checkGraphIntegrity(db: AsyncDatabase): Promise<GraphIntegrityResult> {
	const nodeRows = (await db.prepare("SELECT id, analyzer_id, output_key FROM analysis_nodes").all()) as Array<{
		id: string;
		analyzer_id: string;
		output_key: string;
	}>;
	const nodeIds = new Set<string>();
	const outputKeys = new Set<string>();
	const analyzerByNode = new Map<string, string>();
	for (const n of nodeRows) {
		nodeIds.add(n.id);
		if (n.output_key) outputKeys.add(n.output_key);
		analyzerByNode.set(n.id, n.analyzer_id);
	}

	const sessionIds = await idSet(db, "sessions", "id");
	const messageIds = await idSet(db, "messages", "id");
	const configIds = await idSet(db, "analyzer_configs", "id");
	const promptHashes = await idSet(db, "prompt_registry", "hash");
	const proposalIds = await idSet(db, "proposals", "id");

	const edges = (await db.prepare("SELECT id, from_node_id, to_ref_kind, to_ref_id, edge_kind FROM analysis_edges").all()) as Array<{
		id: string;
		from_node_id: string;
		to_ref_kind: string;
		to_ref_id: string;
		edge_kind: string;
	}>;

	const orphanSource: DanglingEdge[] = [];
	const dangling: DanglingEdge[] = [];

	for (const e of edges) {
		if (!nodeIds.has(e.from_node_id)) {
			orphanSource.push({
				edgeId: e.id,
				fromNodeId: e.from_node_id,
				fromAnalyzerId: "?",
				edgeKind: e.edge_kind,
				toRefKind: e.to_ref_kind,
				toRefId: e.to_ref_id,
				expectedIn: "analysis_nodes.id",
			});
			continue;
		}

		let ok: boolean;
		let expectedIn: string;
		switch (e.to_ref_kind) {
			case REF_KINDS.SESSION:
				ok = sessionIds.has(e.to_ref_id);
				expectedIn = "sessions.id";
				break;
			case REF_KINDS.MESSAGE:
				ok = messageIds.has(e.to_ref_id);
				expectedIn = "messages.id";
				break;
			case REF_KINDS.ANALYSIS_NODE:
				ok = outputKeys.has(e.to_ref_id);
				expectedIn = "analysis_nodes.output_key";
				break;
			case REF_KINDS.PROMPT_VERSION:
				ok = promptHashes.has(e.to_ref_id);
				expectedIn = "prompt_registry.hash";
				break;
			case REF_KINDS.CONFIG_VERSION:
				ok = configIds.has(e.to_ref_id);
				expectedIn = "analyzer_configs.id";
				break;
			case REF_KINDS.PROPOSAL:
				ok = proposalIds.has(e.to_ref_id);
				expectedIn = "proposals.id";
				break;
			default:
				ok = false;
				expectedIn = "<unknown to_ref_kind>";
				break;
		}

		if (!ok) {
			dangling.push({
				edgeId: e.id,
				fromNodeId: e.from_node_id,
				fromAnalyzerId: analyzerByNode.get(e.from_node_id) ?? "?",
				edgeKind: e.edge_kind,
				toRefKind: e.to_ref_kind,
				toRefId: e.to_ref_id,
				expectedIn,
			});
		}
	}

	return { checked: edges.length, orphanSource, dangling, all: [...orphanSource, ...dangling] };
}
