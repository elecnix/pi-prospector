/**
 * Data access for the analysis graph: analyzer registry, nodes, edges, runs,
 * and lineage navigation.
 *
 * All SQL for the analysis graph lives here. Row → camelCase mapping for
 * framework consumers is done by the framework; these functions return raw
 * rows (snake_case) typed by the schemas in `../analyze/types.ts`.
 */

import type Database from "better-sqlite3";
import { prep } from "./prepared.js";
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
import { versionIdOf } from "../analyze/version.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";

// ───────────────────────── analyzer registry ─────────────────────────

export function upsertAnalyzerDef(db: Database.Database, def: AnalyzerDef): void {
	prep(db, `
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
	prep(db, `
		INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(analyzer_id, version_id) DO NOTHING
	`).run(
		version.analyzerId,
		versionIdOf(version),
		version.implementationKind,
		version.codeRef ?? null,
		new Date().toISOString(),
	);
}

export function registerPrompt(db: Database.Database, prompt: PromptVersion): void {
	prep(db, `
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
	const existing = prep(db, "SELECT id, analyzer_id, config_hash, config_json, label FROM analyzer_configs WHERE config_hash = ?")
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
	prep(db, `
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
	prep(db, `
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
	prep(db, `
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
	return prep(db, "SELECT * FROM analysis_runs WHERE id = ?").get(runId) as AnalysisRunRow | undefined;
}

// ───────────────────────── analyze invocations (run batches) ─────────────────────────

/**
 * Begin a whole-run completion record. Status starts as 'running'; if the process
 * is interrupted before {@link finalizeAnalyzeRun}, the row still records that a
 * run began and how many sessions it set out to analyse.
 */
export function createAnalyzeRun(
	db: Database.Database,
	params: { id: string; mode: string; sessionAttempted: number },
): void {
	prep(
		db,
		"INSERT INTO analyze_runs (id, mode, session_attempted, status, started_at) VALUES (?, ?, ?, 'running', ?)",
	).run(params.id, params.mode, params.sessionAttempted, new Date().toISOString());
}

/** Close out a whole-run completion record with the real tallies. */
export function finalizeAnalyzeRun(
	db: Database.Database,
	runId: string,
	fields: {
		status: "ok" | "partial";
		sessionCompleted: number;
		sessionFailed: number;
		nodesProduced: number;
		nodesRevised: number;
		proposalsCreated: number;
		costUsd: number;
		tokensUsed: number;
		errorCount: number;
		errorExamples: string[];
	},
): void {
	prep(
		db,
		`UPDATE analyze_runs SET
			status = ?, session_completed = ?, session_failed = ?,
			nodes_produced = ?, nodes_revised = ?, proposals_created = ?,
			cost_usd = ?, tokens_used = ?, error_count = ?, error_examples = ?, finished_at = ?
		WHERE id = ?`,
	).run(
		fields.status,
		fields.sessionCompleted,
		fields.sessionFailed,
		fields.nodesProduced,
		fields.nodesRevised,
		fields.proposalsCreated,
		fields.costUsd,
		fields.tokensUsed,
		fields.errorCount,
		JSON.stringify(fields.errorExamples),
		new Date().toISOString(),
		runId,
	);
}

/** The most recent whole-run records, newest first — e.g. for a status command. */
export function getLatestAnalyzeRuns(
	db: Database.Database,
	limit = 20,
): Array<Record<string, unknown>> {
	return prep(db, "SELECT * FROM analyze_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Array<
		Record<string, unknown>
	>;
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
		inputKey: string;
		outputKey: string;
		configFingerprint?: string;
		modelUsed?: string | null;
		costUsd?: number | null;
		tokensUsed?: number | null;
		durationMs?: number | null;
		createdAt: string;
	},
): void {
	prep(db, `
		INSERT INTO analysis_nodes
			(id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind,
			 content_json, source_set_hash, input_key, output_key, config_fingerprint, model_used, cost_usd, tokens_used, duration_ms, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		node.inputKey,
		node.outputKey,
		node.configFingerprint ?? "",
		node.modelUsed ?? null,
		node.costUsd ?? null,
		node.tokensUsed ?? null,
		node.durationMs ?? null,
		node.createdAt,
	);
}

export function getNode(db: Database.Database, id: string): AnalysisNodeRow | undefined {
	return prep(db, "SELECT * FROM analysis_nodes WHERE id = ?").get(id) as AnalysisNodeRow | undefined;
}

/**
 * Resolve a node by its content-addressed `output_key`. Node-targeting edges
 * (`consumes`, `revises`) reference the target's `output_key` rather than its
 * DB-local uuid, so the entire graph — nodes *and* edges — is content-addressed
 * and reproduces across a wipe/rebuild. `output_key` is effectively unique
 * (H(input_key | content) over a unique input_key), so this is a 1:1 lookup.
 */
export function getNodeByOutputKey(db: Database.Database, outputKey: string): AnalysisNodeRow | undefined {
	if (!outputKey) return undefined;
	return prep(db, "SELECT * FROM analysis_nodes WHERE output_key = ? LIMIT 1").get(outputKey) as AnalysisNodeRow | undefined;
}

/** Idempotency lookup: a node produced by an exact recipe over an exact source set. */
export function findNodeByInputKey(db: Database.Database, inputKey: string): AnalysisNodeRow | undefined {
	return prep(db, "SELECT * FROM analysis_nodes WHERE input_key = ?").get(inputKey) as AnalysisNodeRow | undefined;
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
	return prep(db, 
			"SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND source_set_hash = ? AND node_kind != 'error' ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get(analyzerId, sourceSetHash) as AnalysisNodeRow | undefined;
}

export function getSessionNodes(db: Database.Database, sessionId: string): AnalysisNodeRow[] {
	return prep(db, "SELECT * FROM analysis_nodes WHERE session_id = ? ORDER BY created_at ASC, rowid ASC").all(sessionId) as AnalysisNodeRow[];
}

/** Every analysis node, for integrity verification. */
export function getAllAnalysisNodes(db: Database.Database): AnalysisNodeRow[] {
	return prep(db, "SELECT * FROM analysis_nodes ORDER BY created_at ASC, rowid ASC").all() as AnalysisNodeRow[];
}

/** A session's messages in stream order — for reconstructing turns verbatim. */
export function getSessionMessageRows(db: Database.Database, sessionId: string): MessageRow[] {
	return prep(db,
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, cost_usd " +
				"FROM messages WHERE session_id = ? ORDER BY rowid ASC",
		)
		.all(sessionId) as MessageRow[];
}

export function getNodesByAnalyzer(db: Database.Database, analyzerId: string, sessionId: string): AnalysisNodeRow[] {
	return prep(db, "SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND session_id = ? ORDER BY created_at ASC, rowid ASC")
		.all(analyzerId, sessionId) as AnalysisNodeRow[];
}

/**
 * The newest node for every logical unit of an analyzer, across *all* sessions —
 * the corpus-scoped read.
 *
 * Almost all analysis is session-scoped, but some subjects are corpus-wide: a
 * lexicon term belongs to the corpus, not to whichever session first surfaced it.
 * Such an analyzer needs to see the whole body of its dependency's conclusions,
 * so this lifts the session scope while keeping the "latest version wins" rule
 * that `findLatestNodeBySourceSet` applies per unit: one row per
 * `source_set_hash`, newest first, errors excluded.
 */
export function getLatestNodesByAnalyzerAcrossSessions(db: Database.Database, analyzerId: string): AnalysisNodeRow[] {
	return prep(db, 
			`SELECT * FROM analysis_nodes n
			 WHERE n.analyzer_id = ?
			   AND n.node_kind != 'error'
			   AND n.rowid = (
			     SELECT m.rowid FROM analysis_nodes m
			     WHERE m.analyzer_id = n.analyzer_id
			       AND m.source_set_hash = n.source_set_hash
			       AND m.node_kind != 'error'
			     ORDER BY m.created_at DESC, m.rowid DESC
			     LIMIT 1
			   )
			 ORDER BY n.created_at ASC, n.rowid ASC`,
		)
		.all(analyzerId) as AnalysisNodeRow[];
}

// ───────────────────────── edges ─────────────────────────

export function insertEdge(
	db: Database.Database,
	edge: { fromNodeId: string; toRefKind: string; toRefId: string; edgeKind: string; ordinal: number },
): void {
	prep(db, `
		INSERT INTO analysis_edges (id, from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(uuidv7(), edge.fromNodeId, edge.toRefKind, edge.toRefId, edge.edgeKind, edge.ordinal);
}

export function getEdgesFrom(db: Database.Database, nodeId: string): AnalysisEdgeRow[] {
	return prep(db, "SELECT * FROM analysis_edges WHERE from_node_id = ? ORDER BY ordinal ASC").all(nodeId) as AnalysisEdgeRow[];
}

export function getEdgesTo(db: Database.Database, toRefId: string, edgeKind?: string): AnalysisEdgeRow[] {
	if (edgeKind) {
		return prep(db, "SELECT * FROM analysis_edges WHERE to_ref_id = ? AND edge_kind = ?")
			.all(toRefId, edgeKind) as AnalysisEdgeRow[];
	}
	return prep(db, "SELECT * FROM analysis_edges WHERE to_ref_id = ?").all(toRefId) as AnalysisEdgeRow[];
}

/** Message ids that a node anchors to (via `anchors` edges with message targets). */
export function getAnchoredMessageIds(db: Database.Database, nodeId: string): string[] {
	const rows = prep(db, "SELECT to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = ? AND to_ref_kind = ?")
		.all(nodeId, EDGE_KINDS.ANCHORS, REF_KINDS.MESSAGE) as Array<{ to_ref_id: string }>;
	return rows.map((r) => r.to_ref_id);
}

export function getMessage(db: Database.Database, id: string): MessageRow | undefined {
	return prep(db,
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, cost_usd FROM messages WHERE id = ?",
		)
		.get(id) as MessageRow | undefined;
}

/**
 * Sum the billed dollar cost of the assistant turns headed by the given user
 * messages (issue #71). A turn is the span from one user message up to (but
 * excluding) the next user message; assistant replies and tool results inside it
 * belong to that turn. Used to price a proposal from its high-signal source
 * turns. Returns null when none of the turns has a recorded cost — money is
 * never guessed, and a sum of 0 reads as "no amount" (see extractCostUsd).
 */
export function sumSourceTurnCost(
	db: Database.Database,
	sessionId: string,
	userMessageIds: readonly string[],
): number | null {
	if (userMessageIds.length === 0) return null;
	const rows = prep(db, "SELECT id, role, cost_usd FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as Array<{
		id: string;
		role: string;
		cost_usd: number | null;
	}>;
	const indexById = new Map<string, number>();
	for (let i = 0; i < rows.length; i++) indexById.set(rows[i]!.id, i);

	let sum = 0;
	let any = false;
	for (const uid of new Set(userMessageIds)) {
		const start = indexById.get(uid);
		if (start === undefined) continue;
		for (let i = start + 1; i < rows.length; i++) {
			const r = rows[i]!;
			if (r.role === "user") break; // next turn's boundary
			if (r.role === "assistant" && typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd)) {
				sum += r.cost_usd;
				any = true;
			}
		}
	}
	return any && sum > 0 ? sum : null;
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
	return prep(db, 
			"SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND source_set_hash = ? ORDER BY created_at ASC, rowid ASC",
		)
		.all(analyzerId, sourceSetHash) as AnalysisNodeRow[];
}

/** The node that `nodeId` revises (its immediate older-version predecessor), if any. */
export function getRevisedNode(db: Database.Database, nodeId: string): AnalysisNodeRow | undefined {
	const edge = prep(db, "SELECT to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = ? LIMIT 1")
		.get(nodeId, EDGE_KINDS.REVISES) as { to_ref_id: string } | undefined;
	if (!edge) return undefined;
	// `revises` edges reference the predecessor's content-addressed output_key.
	return getNodeByOutputKey(db, edge.to_ref_id);
}

/** Nodes that revise `nodeId` (its newer-version successors), if any. */
export function getRevisions(db: Database.Database, nodeId: string): AnalysisNodeRow[] {
	// `revises` edges point at the predecessor's output_key, so match on that.
	const node = getNode(db, nodeId);
	if (!node || !node.output_key) return [];
	const edges = prep(db, "SELECT from_node_id FROM analysis_edges WHERE to_ref_id = ? AND edge_kind = ?")
		.all(node.output_key, EDGE_KINDS.REVISES) as Array<{ from_node_id: string }>;
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
	const nodes = (prep(db, "SELECT COUNT(*) AS c FROM analysis_nodes").get() as { c: number }).c;
	const edges = (prep(db, "SELECT COUNT(*) AS c FROM analysis_edges").get() as { c: number }).c;
	const runs = (prep(db, "SELECT COUNT(*) AS c FROM analysis_runs").get() as { c: number }).c;
	const kindRows = prep(db, "SELECT node_kind, COUNT(*) AS c FROM analysis_nodes GROUP BY node_kind").all() as Array<{
		node_kind: string;
		c: number;
	}>;
	const nodesByKind: Record<string, number> = {};
	for (const r of kindRows) nodesByKind[r.node_kind] = r.c;
	return { nodes, edges, runs, nodesByKind };
}
