/**
 * Data access for the analysis graph: analyzer registry, nodes, edges, runs,
 * and lineage navigation.
 *
 * All SQL for the analysis graph lives here. Row → camelCase mapping for
 * framework consumers is done by the framework; these functions return raw
 * rows (snake_case) typed by the schemas in `../analyze/types.ts`.
 */

import type Database from "better-sqlite3";
import type {
	AnalysisEdgeRow,
	AnalysisNodeRow,
	AnalysisRunRow,
	AnalyzerConfig,
	AnalyzerDef,
	AnalyzerVersion,
	MessageRow,
	PromptVersion,
} from "../analyze/types.js";
import { computeConfigHash, uuidv7 } from "../analyze/input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";

// ───────────────────────── analyzer registry ─────────────────────────

export function upsertAnalyzerDef(db: Database.Database, def: AnalyzerDef): void {
	db.prepare(`
		INSERT INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			label = excluded.label,
			description = excluded.description,
			anchor_span = excluded.anchor_span,
			dependencies = excluded.dependencies
	`).run(
		def.id,
		def.label,
		def.description,
		def.anchorSpan,
		JSON.stringify(def.dependencies),
		new Date().toISOString(),
	);
}

export function upsertAnalyzerVersion(db: Database.Database, version: AnalyzerVersion): void {
	db.prepare(`
		INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(analyzer_id, version_id) DO NOTHING
	`).run(
		version.analyzerId,
		version.versionId,
		version.implementationKind,
		version.codeRef ?? null,
		new Date().toISOString(),
	);
}

export function registerPrompt(db: Database.Database, prompt: PromptVersion): void {
	db.prepare(`
		INSERT INTO prompt_registry (hash, content, role, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(hash) DO NOTHING
	`).run(prompt.hash, prompt.content, prompt.role ?? null, new Date().toISOString());
}

/**
 * Resolve (and persist if new) an analyzer config. Configs are content-addressed
 * by a hash of their canonical JSON; identical configs share one row and id.
 */
export function resolveConfig(
	db: Database.Database,
	params: { analyzerId: string; configJson: Record<string, unknown>; label?: string },
): AnalyzerConfig {
	const configHash = computeConfigHash(params.configJson);
	const existing = db
		.prepare("SELECT id, analyzer_id, config_hash, config_json, label FROM analyzer_configs WHERE config_hash = ?")
		.get(configHash) as
		| { id: string; analyzer_id: string; config_hash: string; config_json: string; label: string | null }
		| undefined;

	if (existing) {
		return {
			id: existing.id,
			analyzerId: existing.analyzer_id,
			configHash: existing.config_hash,
			configJson: JSON.parse(existing.config_json) as Record<string, unknown>,
			label: existing.label ?? undefined,
		};
	}

	const id = uuidv7();
	db.prepare(`
		INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(id, params.analyzerId, configHash, JSON.stringify(params.configJson), params.label ?? null, new Date().toISOString());

	return {
		id,
		analyzerId: params.analyzerId,
		configHash,
		configJson: params.configJson,
		label: params.label,
	};
}

// ───────────────────────── runs ─────────────────────────

export function createRun(
	db: Database.Database,
	params: {
		id: string;
		analyzerId: string;
		analyzerVersionId: string;
		configId: string;
		sessionId: string;
		mode: string;
		promptBundleHash: string;
		modelSpec?: string;
	},
): void {
	db.prepare(`
		INSERT INTO analysis_runs
			(id, analyzer_id, analyzer_version_id, config_id, session_id, mode, status, prompt_bundle_hash, model_spec, started_at)
		VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)
	`).run(
		params.id,
		params.analyzerId,
		params.analyzerVersionId,
		params.configId,
		params.sessionId,
		params.mode,
		params.promptBundleHash,
		params.modelSpec ?? null,
		new Date().toISOString(),
	);
}

export function finishRun(
	db: Database.Database,
	runId: string,
	fields: {
		status: string;
		nodesProduced: number;
		nodesSkipped: number;
		costUsd: number;
		tokensUsed: number;
		errorMessage?: string | null;
	},
): void {
	db.prepare(`
		UPDATE analysis_runs SET
			status = ?, finished_at = ?, nodes_produced = ?, nodes_skipped = ?,
			cost_usd = ?, tokens_used = ?, error_message = ?
		WHERE id = ?
	`).run(
		fields.status,
		new Date().toISOString(),
		fields.nodesProduced,
		fields.nodesSkipped,
		fields.costUsd,
		fields.tokensUsed,
		fields.errorMessage ?? null,
		runId,
	);
}

export function getRun(db: Database.Database, runId: string): AnalysisRunRow | undefined {
	return db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(runId) as AnalysisRunRow | undefined;
}

// ───────────────────────── nodes ─────────────────────────

export function insertNode(
	db: Database.Database,
	node: {
		id: string;
		sessionId: string;
		analyzerId: string;
		analyzerVersionId: string;
		configId: string;
		runId: string | null;
		nodeKind: string;
		contentJson: string;
		sourceSetHash: string;
		inputHash: string;
		modelUsed?: string | null;
		costUsd?: number | null;
		tokensUsed?: number | null;
		durationMs?: number | null;
		createdAt: string;
	},
): void {
	db.prepare(`
		INSERT INTO analysis_nodes
			(id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind,
			 content_json, source_set_hash, input_hash, model_used, cost_usd, tokens_used, duration_ms, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		node.id,
		node.sessionId,
		node.analyzerId,
		node.analyzerVersionId,
		node.configId,
		node.runId,
		node.nodeKind,
		node.contentJson,
		node.sourceSetHash,
		node.inputHash,
		node.modelUsed ?? null,
		node.costUsd ?? null,
		node.tokensUsed ?? null,
		node.durationMs ?? null,
		node.createdAt,
	);
}

export function getNode(db: Database.Database, id: string): AnalysisNodeRow | undefined {
	return db.prepare("SELECT * FROM analysis_nodes WHERE id = ?").get(id) as AnalysisNodeRow | undefined;
}

/** Idempotency lookup: a node produced by an exact recipe over an exact source set. */
export function findNodeByInputHash(db: Database.Database, inputHash: string): AnalysisNodeRow | undefined {
	return db.prepare("SELECT * FROM analysis_nodes WHERE input_hash = ?").get(inputHash) as AnalysisNodeRow | undefined;
}

/**
 * The newest node for a logical unit = (analyzer, source set), regardless of
 * version/config. Used to detect `stale` units (a node exists, but from an
 * older recipe) and to wire the `revises` lineage edge.
 */
export function findLatestNodeBySourceSet(
	db: Database.Database,
	analyzerId: string,
	sourceSetHash: string,
): AnalysisNodeRow | undefined {
	return db
		.prepare(
			"SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND source_set_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get(analyzerId, sourceSetHash) as AnalysisNodeRow | undefined;
}

export function getSessionNodes(db: Database.Database, sessionId: string): AnalysisNodeRow[] {
	return db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC").all(sessionId) as AnalysisNodeRow[];
}

export function getNodesByAnalyzer(db: Database.Database, analyzerId: string, sessionId: string): AnalysisNodeRow[] {
	return db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC")
		.all(analyzerId, sessionId) as AnalysisNodeRow[];
}

// ───────────────────────── edges ─────────────────────────

export function insertEdge(
	db: Database.Database,
	edge: { fromNodeId: string; toRefKind: string; toRefId: string; edgeKind: string; ordinal: number },
): void {
	db.prepare(`
		INSERT INTO analysis_edges (id, from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(uuidv7(), edge.fromNodeId, edge.toRefKind, edge.toRefId, edge.edgeKind, edge.ordinal);
}

export function getEdgesFrom(db: Database.Database, nodeId: string): AnalysisEdgeRow[] {
	return db.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? ORDER BY ordinal ASC").all(nodeId) as AnalysisEdgeRow[];
}

export function getEdgesTo(db: Database.Database, toRefId: string, edgeKind?: string): AnalysisEdgeRow[] {
	if (edgeKind) {
		return db
			.prepare("SELECT * FROM analysis_edges WHERE to_ref_id = ? AND edge_kind = ?")
			.all(toRefId, edgeKind) as AnalysisEdgeRow[];
	}
	return db.prepare("SELECT * FROM analysis_edges WHERE to_ref_id = ?").all(toRefId) as AnalysisEdgeRow[];
}

/** Message ids that a node anchors to (via `anchors` edges with message targets). */
export function getAnchoredMessageIds(db: Database.Database, nodeId: string): string[] {
	const rows = db
		.prepare("SELECT to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = ? AND to_ref_kind = ?")
		.all(nodeId, EDGE_KINDS.ANCHORS, REF_KINDS.MESSAGE) as Array<{ to_ref_id: string }>;
	return rows.map((r) => r.to_ref_id);
}

export function getMessage(db: Database.Database, id: string): MessageRow | undefined {
	return db
		.prepare(
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results FROM messages WHERE id = ?",
		)
		.get(id) as MessageRow | undefined;
}

// ───────────────────────── lineage navigation ─────────────────────────

/**
 * All version-alternatives for a logical unit, oldest → newest. These are the
 * nodes that sit "at the same level" of the graph; their `created_at` and
 * `analyzer_version_id` distinguish the alternatives.
 */
export function getNodeVersions(
	db: Database.Database,
	analyzerId: string,
	sourceSetHash: string,
): AnalysisNodeRow[] {
	return db
		.prepare(
			"SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND source_set_hash = ? ORDER BY created_at ASC, rowid ASC",
		)
		.all(analyzerId, sourceSetHash) as AnalysisNodeRow[];
}

/** The node that `nodeId` revises (its immediate older-version predecessor), if any. */
export function getRevisedNode(db: Database.Database, nodeId: string): AnalysisNodeRow | undefined {
	const edge = db
		.prepare("SELECT to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = ? LIMIT 1")
		.get(nodeId, EDGE_KINDS.REVISES) as { to_ref_id: string } | undefined;
	if (!edge) return undefined;
	return getNode(db, edge.to_ref_id);
}

/** Nodes that revise `nodeId` (its newer-version successors), if any. */
export function getRevisions(db: Database.Database, nodeId: string): AnalysisNodeRow[] {
	const edges = db
		.prepare("SELECT from_node_id FROM analysis_edges WHERE to_ref_id = ? AND edge_kind = ?")
		.all(nodeId, EDGE_KINDS.REVISES) as Array<{ from_node_id: string }>;
	const out: AnalysisNodeRow[] = [];
	for (const e of edges) {
		const n = getNode(db, e.from_node_id);
		if (n) out.push(n);
	}
	return out;
}

// ───────────────────────── analysis stats ─────────────────────────

export interface AnalysisStats {
	nodes: number;
	edges: number;
	runs: number;
	nodesByKind: Record<string, number>;
}

export function getAnalysisStats(db: Database.Database): AnalysisStats {
	const nodes = (db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes").get() as { c: number }).c;
	const edges = (db.prepare("SELECT COUNT(*) AS c FROM analysis_edges").get() as { c: number }).c;
	const runs = (db.prepare("SELECT COUNT(*) AS c FROM analysis_runs").get() as { c: number }).c;
	const kindRows = db.prepare("SELECT node_kind, COUNT(*) AS c FROM analysis_nodes GROUP BY node_kind").all() as Array<{
		node_kind: string;
		c: number;
	}>;
	const nodesByKind: Record<string, number> = {};
	for (const r of kindRows) nodesByKind[r.node_kind] = r.c;
	return { nodes, edges, runs, nodesByKind };
}
