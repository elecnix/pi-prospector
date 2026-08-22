/**
 * Data access for the analysis graph: analyzer registry, nodes, edges, runs,
 * and lineage navigation.
 *
 * All SQL for the analysis graph lives here. Row → camelCase mapping for
 * framework consumers is done by the framework; these functions return raw
 * rows (snake_case) typed by the schemas in `../analyze/types.ts`.
 */

import { type AsyncDatabase } from "./async-db.js";
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

export async function upsertAnalyzerDef(db: AsyncDatabase, def: AnalyzerDef): Promise<void> {
	await prep(db, `
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

export async function upsertAnalyzerVersion(db: AsyncDatabase, version: AnalyzerVersion): Promise<void> {
	await prep(db, `
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

export async function registerPrompt(db: AsyncDatabase, prompt: PromptVersion): Promise<void> {
	await prep(db, `
		INSERT INTO prompt_registry (hash, content, role, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(hash) DO NOTHING
	`).run(prompt.hash, prompt.content, prompt.role ?? null, new Date().toISOString());
}

/**
 * Resolve (and persist if new) an analyzer config. Configs are content-addressed
 * by a hash of their canonical JSON; identical configs share one row and id.
 */
export async function resolveConfig(
	db: AsyncDatabase,
	params: { analyzerId: string; configJson: Record<string, unknown>; label?: string },
): Promise<AnalyzerConfig> {
	const configHash = computeConfigHash(params.configJson);
	const existing = (await prep(db, "SELECT id, analyzer_id, config_hash, config_json, label FROM analyzer_configs WHERE config_hash = ?")
		.get(configHash)) as
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
	const result = await prep(db, `
		INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(config_hash) DO NOTHING
	`).run(id, params.analyzerId, configHash, JSON.stringify(params.configJson), params.label ?? null, new Date().toISOString());

	if ((result as unknown as { changes: number }).changes === 0) {
		// A concurrent run inserted the same content-addressed config first. Identity
		// is the hash, so reuse the winner rather than collide on the unique key.
		const winner = (await prep(db, "SELECT id, analyzer_id, config_hash, config_json, label FROM analyzer_configs WHERE config_hash = ?")
			.get(configHash)) as
			| { id: string; analyzer_id: string; config_hash: string; config_json: string; label: string | null }
			| undefined;
		if (winner) {
			return {
				id: winner.id,
				analyzerId: winner.analyzer_id,
				configHash: winner.config_hash,
				configJson: JSON.parse(winner.config_json) as Record<string, unknown>,
				label: winner.label ?? undefined,
			};
		}
	}

	return {
		id,
		analyzerId: params.analyzerId,
		configHash,
		configJson: params.configJson,
		label: params.label,
	};
}

// ───────────────────────── runs ─────────────────────────

export async function createRun(
	db: AsyncDatabase,
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
): Promise<void> {
	await prep(db, `
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

export async function finishRun(
	db: AsyncDatabase,
	runId: string,
	fields: {
		status: string;
		nodesProduced: number;
		nodesSkipped: number;
		costUsd: number;
		tokensUsed: number;
		errorMessage?: string | null;
	},
): Promise<void> {
	await prep(db, `
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

export async function getRun(db: AsyncDatabase, runId: string): Promise<AnalysisRunRow | undefined> {
	return (await prep(db, "SELECT * FROM analysis_runs WHERE id = ?").get(runId)) as AnalysisRunRow | undefined;
}

// ───────────────────────── analyze invocations (run batches) ─────────────────────────

/**
 * Begin a whole-run completion record. Status starts as 'running'; if the process
 * is interrupted before {@link finalizeAnalyzeRun}, the row still records that a
 * run began and how many sessions it set out to analyse.
 */
export async function createAnalyzeRun(
	db: AsyncDatabase,
	params: { id: string; mode: string; sessionAttempted: number },
): Promise<void> {
	await prep(
		db,
		"INSERT INTO analyze_runs (id, mode, session_attempted, status, started_at) VALUES (?, ?, ?, 'running', ?)",
	).run(params.id, params.mode, params.sessionAttempted, new Date().toISOString());
}

/** Close out a whole-run completion record with the real tallies. */
export async function finalizeAnalyzeRun(
	db: AsyncDatabase,
	runId: string,
	fields: {
		status: "ok" | "partial";
		sessionCompleted: number;
		sessionFailed: number;
		retried: number;
		nodesProduced: number;
		nodesRevised: number;
		proposalsCreated: number;
		costUsd: number;
		tokensUsed: number;
		errorCount: number;
		errorExamples: string[];
	},
): Promise<void> {
	await prep(
		db,
		`UPDATE analyze_runs SET
			status = ?, session_completed = ?, session_failed = ?, retried = ?,
			nodes_produced = ?, nodes_revised = ?, proposals_created = ?,
			cost_usd = ?, tokens_used = ?, error_count = ?, error_examples = ?, finished_at = ?
		WHERE id = ?`,
	).run(
		fields.status,
		fields.sessionCompleted,
		fields.sessionFailed,
		fields.retried,
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
export async function getLatestAnalyzeRuns(
	db: AsyncDatabase,
	limit = 20,
): Promise<Array<Record<string, unknown>>> {
	return (await prep(db, "SELECT * FROM analyze_runs ORDER BY started_at DESC LIMIT ?").all(limit)) as Array<
		Record<string, unknown>
	>;
}

// ───────────────────────── nodes ─────────────────────────

export async function insertNode(
	db: AsyncDatabase,
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
		inputTokens?: number | null;
		cachedInputTokens?: number | null;
		outputTokens?: number | null;
		durationMs?: number | null;
		createdAt: string;
	},
): Promise<void> {
	await prep(db, `
		INSERT INTO analysis_nodes
			(id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind,
			 content_json, source_set_hash, input_key, output_key, config_fingerprint, model_used, cost_usd, tokens_used,
			 input_tokens, cached_input_tokens, output_tokens, duration_ms, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		node.inputTokens ?? null,
		node.cachedInputTokens ?? null,
		node.outputTokens ?? null,
		node.durationMs ?? null,
		node.createdAt,
	);
}

export async function getNode(db: AsyncDatabase, id: string): Promise<AnalysisNodeRow | undefined> {
	return (await prep(db, "SELECT * FROM analysis_nodes WHERE id = ?").get(id)) as AnalysisNodeRow | undefined;
}

/**
 * Resolve a node by its content-addressed `output_key`. Node-targeting edges
 * (`consumes`, `revises`) reference the target's `output_key` rather than its
 * DB-local uuid, so the entire graph — nodes *and* edges — is content-addressed
 * and reproduces across a wipe/rebuild. `output_key` is effectively unique
 * (H(input_key | content) over a unique input_key), so this is a 1:1 lookup.
 */
export async function getNodeByOutputKey(db: AsyncDatabase, outputKey: string): Promise<AnalysisNodeRow | undefined> {
	if (!outputKey) return undefined;
	return (await prep(db, "SELECT * FROM analysis_nodes WHERE output_key = ? LIMIT 1").get(outputKey)) as AnalysisNodeRow | undefined;
}

/** Idempotency lookup: a node produced by an exact recipe over an exact source set. Live only (a retracted node is absent). */
export async function findNodeByInputKey(db: AsyncDatabase, inputKey: string): Promise<AnalysisNodeRow | undefined> {
	return (await prep(db, "SELECT * FROM live_nodes WHERE input_key = ?").get(inputKey)) as AnalysisNodeRow | undefined;
}

/**
 * The newest node for a logical unit = (analyzer, source set), regardless of
 * version/config. Used to detect `stale` units (a node exists, but from an
 * older recipe) and to wire the `revises` lineage edge. Live only — a retracted
 * node is treated as absent so its unit classifies `missing` and is recomputed.
 */
export async function findLatestNodeBySourceSet(
	db: AsyncDatabase,
	analyzerId: string,
	sourceSetHash: string,
): Promise<AnalysisNodeRow | undefined> {
	return (await prep(db,
			"SELECT * FROM live_nodes WHERE analyzer_id = ? AND source_set_hash = ? AND node_kind != 'error' ORDER BY created_at DESC, id DESC LIMIT 1",
		)
		.get(analyzerId, sourceSetHash)) as AnalysisNodeRow | undefined;
}

export async function getSessionNodes(db: AsyncDatabase, sessionId: string, asOf?: string): Promise<AnalysisNodeRow[]> {
	if (asOf) {
		return (await prep(db, "SELECT * FROM analysis_nodes WHERE session_id = ? AND created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?) ORDER BY created_at ASC, id ASC")
			.all(sessionId, asOf, asOf)) as AnalysisNodeRow[];
	}
	return (await prep(db, "SELECT * FROM live_nodes WHERE session_id = ? ORDER BY created_at ASC, id ASC").all(sessionId)) as AnalysisNodeRow[];
}

export interface NodeListFilter {
	analyzerId?: string;
	/** Match any of these analyzer ids (used together with, not instead of, `analyzerId`). */
	analyzerIds?: string[];
	/** Restrict to sessions whose harness source matches (`pi` | `claude`). */
	source?: string;
	nodeKind?: string;
	sessionId?: string;
	/** When set, read the graph as it stood at this instant (see src/timepoint.ts). */
	asOf?: string;
	limit?: number;
	offset?: number;
}

/**
 * The surface read for `prospect nodes`: live nodes matching an analyzer /
 * node-kind / session filter, newest first, paged. This is a *read* of what
 * analysis already found — it writes nothing and declares no dependencies
 * (outputs are exempt from the dependency rule, see DESIGN.md).
 */
export async function listAnalysisNodes(db: AsyncDatabase, filter: NodeListFilter = {}): Promise<AnalysisNodeRow[]> {
	const asOf = filter.asOf;
	const table = asOf ? "analysis_nodes" : "live_nodes";
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (filter.analyzerId) {
		where.push("analyzer_id = ?");
		params.push(filter.analyzerId);
	}
	if (filter.analyzerIds && filter.analyzerIds.length > 0) {
		where.push(`analyzer_id IN (${filter.analyzerIds.map(() => "?").join(", ")})`);
		params.push(...filter.analyzerIds);
	}
	if (filter.source) {
		where.push("session_id IN (SELECT id FROM sessions WHERE source = ?)");
		params.push(filter.source);
	}
	if (filter.nodeKind) {
		where.push("node_kind = ?");
		params.push(filter.nodeKind);
	}
	if (filter.sessionId) {
		where.push("session_id = ?");
		params.push(filter.sessionId);
	}
	if (asOf) {
		where.push("created_at <= ?");
		where.push("(retracted_at IS NULL OR retracted_at > ?)");
		params.push(asOf, asOf);
	}
	const sql =
		`SELECT * FROM ${table}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ` +
		"ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
	params.push(filter.limit ?? 200, filter.offset ?? 0);
	return (await prep(db, sql).all(...params)) as AnalysisNodeRow[];
}

/** How many live nodes match a {@link NodeListFilter}, ignoring limit/offset — the denominator for paging. */
export async function countAnalysisNodes(db: AsyncDatabase, filter: NodeListFilter = {}): Promise<number> {
	const asOf = filter.asOf;
	const table = asOf ? "analysis_nodes" : "live_nodes";
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (filter.analyzerId) {
		where.push("analyzer_id = ?");
		params.push(filter.analyzerId);
	}
	if (filter.analyzerIds && filter.analyzerIds.length > 0) {
		where.push(`analyzer_id IN (${filter.analyzerIds.map(() => "?").join(", ")})`);
		params.push(...filter.analyzerIds);
	}
	if (filter.source) {
		where.push("session_id IN (SELECT id FROM sessions WHERE source = ?)");
		params.push(filter.source);
	}
	if (filter.nodeKind) {
		where.push("node_kind = ?");
		params.push(filter.nodeKind);
	}
	if (filter.sessionId) {
		where.push("session_id = ?");
		params.push(filter.sessionId);
	}
	if (asOf) {
		where.push("created_at <= ?");
		where.push("(retracted_at IS NULL OR retracted_at > ?)");
		params.push(asOf, asOf);
	}
	const sql = `SELECT COUNT(*) AS c FROM ${table}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}`;
	return ((await prep(db, sql).get(...params)) as { c: number }).c;
}

/**
 * Resolve nodes by an *output_key prefix* — the surface twin of id-prefix
 * resolution in `prospect show`. Output keys are content-addressed hashes, so a
 * short prefix is usually unambiguous; when it is not, every match is returned
 * and the caller asks for a longer prefix.
 */
export async function getNodesByOutputKeyPrefix(db: AsyncDatabase, prefix: string): Promise<AnalysisNodeRow[]> {
	if (!prefix) return [];
	// Escape LIKE metacharacters so a hash prefix is matched literally.
	const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
	return (await prep(db, "SELECT * FROM live_nodes WHERE output_key LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC")
		.all(`${escaped}%`)) as AnalysisNodeRow[];
}

/**
 * Every analysis node, for integrity verification. Retracted nodes are still
 * nodes and their content must still hash correctly, so pass `includeRetracted`
 * to see all of them; live/current reads leave it false (the live view).
 */
export async function getAllAnalysisNodes(db: AsyncDatabase, asOf?: string, includeRetracted = false): Promise<AnalysisNodeRow[]> {
	if (includeRetracted && !asOf) {
		return (await prep(db, "SELECT * FROM analysis_nodes ORDER BY created_at ASC, id ASC").all()) as AnalysisNodeRow[];
	}
	if (asOf) {
		return (await prep(db, "SELECT * FROM analysis_nodes WHERE created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?) ORDER BY created_at ASC, id ASC")
			.all(asOf, asOf)) as AnalysisNodeRow[];
	}
	return (await prep(db, "SELECT * FROM live_nodes ORDER BY created_at ASC, id ASC").all()) as AnalysisNodeRow[];
}

/** A session's messages in stream order — for reconstructing turns verbatim. */
export async function getSessionMessageRows(db: AsyncDatabase, sessionId: string): Promise<MessageRow[]> {
	return (await prep(db,
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message " +
				"FROM messages WHERE session_id = ? ORDER BY rowid ASC",
		)
		.all(sessionId)) as MessageRow[];
}

export async function getNodesByAnalyzer(db: AsyncDatabase, analyzerId: string, sessionId: string, asOf?: string): Promise<AnalysisNodeRow[]> {
	if (asOf) {
		return (await prep(db, "SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND session_id = ? AND created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?) ORDER BY created_at ASC, id ASC")
			.all(analyzerId, sessionId, asOf, asOf)) as AnalysisNodeRow[];
	}
	return (await prep(db, "SELECT * FROM live_nodes WHERE analyzer_id = ? AND session_id = ? ORDER BY created_at ASC, id ASC")
		.all(analyzerId, sessionId)) as AnalysisNodeRow[];
}

/**
 * The newest live summary node for a session — the session-level synthesis a
 * summarizing analyzer (session-overview) produced for it. This is the read
 * behind `prospect show --session` (issue #105): a reporting surface over an
 * existing node, never a recomputation. Errors are never summaries; a session
 * whose overview has not completed has none.
 */
export async function getLatestSummaryNode(db: AsyncDatabase, sessionId: string, analyzerId?: string): Promise<AnalysisNodeRow | undefined> {
	const where = ["session_id = ?", "node_kind = 'summary'"];
	const params: Array<string | number> = [sessionId];
	if (analyzerId) {
		where.push("analyzer_id = ?");
		params.push(analyzerId);
	}
	return (await prep(db, `SELECT * FROM live_nodes WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 1`)
		.get(...params)) as AnalysisNodeRow | undefined;
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
export async function getLatestNodesByAnalyzerAcrossSessions(db: AsyncDatabase, analyzerId: string, asOf?: string): Promise<AnalysisNodeRow[]> {
	if (asOf) {
		return (await prep(db, 
				`SELECT * FROM analysis_nodes n
			 WHERE n.analyzer_id = ?
			   AND n.node_kind != 'error'
			   AND n.created_at <= ?
			   AND (n.retracted_at IS NULL OR n.retracted_at > ?)
			   AND n.id = (
			     SELECT m.id FROM analysis_nodes m
			     WHERE m.analyzer_id = n.analyzer_id
			       AND m.source_set_hash = n.source_set_hash
			       AND m.node_kind != 'error'
			       AND m.created_at <= ?
			       AND (m.retracted_at IS NULL OR m.retracted_at > ?)
			     ORDER BY m.created_at DESC, m.id DESC
			     LIMIT 1
			   )
			 ORDER BY n.created_at ASC, n.id ASC`,
			)
			.all(analyzerId, asOf, asOf, asOf, asOf)) as AnalysisNodeRow[];
	}
	return (await prep(db, 
			`SELECT * FROM live_nodes n
			 WHERE n.analyzer_id = ?
			   AND n.node_kind != 'error'
			   AND n.id = (
			     SELECT m.id FROM live_nodes m
			     WHERE m.analyzer_id = n.analyzer_id
			       AND m.source_set_hash = n.source_set_hash
			       AND m.node_kind != 'error'
			     ORDER BY m.created_at DESC, m.id DESC
			     LIMIT 1
			   )
			 ORDER BY n.created_at ASC, n.id ASC`,
		)
		.all(analyzerId)) as AnalysisNodeRow[];
}

// ───────────────────────── edges ─────────────────────────

export async function insertEdge(
	db: AsyncDatabase,
	edge: { fromNodeId: string; toRefKind: string; toRefId: string; edgeKind: string; ordinal: number },
): Promise<void> {
	await prep(db, `
		INSERT INTO analysis_edges (id, from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(uuidv7(), edge.fromNodeId, edge.toRefKind, edge.toRefId, edge.edgeKind, edge.ordinal);
}

export async function getEdgesFrom(db: AsyncDatabase, nodeId: string): Promise<AnalysisEdgeRow[]> {
	return (await prep(db, "SELECT * FROM analysis_edges WHERE from_node_id = ? ORDER BY ordinal ASC").all(nodeId)) as AnalysisEdgeRow[];
}

export async function getEdgesTo(db: AsyncDatabase, toRefId: string, edgeKind?: string): Promise<AnalysisEdgeRow[]> {
	if (edgeKind) {
		return (await prep(db, "SELECT * FROM analysis_edges WHERE to_ref_id = ? AND edge_kind = ?")
			.all(toRefId, edgeKind)) as AnalysisEdgeRow[];
	}
	return (await prep(db, "SELECT * FROM analysis_edges WHERE to_ref_id = ?").all(toRefId)) as AnalysisEdgeRow[];
}

/** Message ids that a node anchors to (via `anchors` edges with message targets). */
export async function getAnchoredMessageIds(db: AsyncDatabase, nodeId: string): Promise<string[]> {
	const rows = (await prep(db, "SELECT to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = ? AND to_ref_kind = ?")
		.all(nodeId, EDGE_KINDS.ANCHORS, REF_KINDS.MESSAGE)) as Array<{ to_ref_id: string }>;
	return rows.map((r) => r.to_ref_id);
}

export async function getMessage(db: AsyncDatabase, id: string): Promise<MessageRow | undefined> {
	return (await prep(db,
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message FROM messages WHERE id = ?",
		)
		.get(id)) as MessageRow | undefined;
}

/**
 * Sum the billed dollar cost of the assistant turns headed by the given user
 * messages (issue #71). A turn is the span from one user message up to (but
 * excluding) the next user message; assistant replies and tool results inside it
 * belong to that turn. Used to price a proposal from its high-signal source
 * turns. Returns null when none of the turns has a recorded cost — money is
 * never guessed, and a sum of 0 reads as "no amount" (see extractCostUsd).
 */
export async function sumSourceTurnCost(
	db: AsyncDatabase,
	sessionId: string,
	userMessageIds: readonly string[],
): Promise<number | null> {
	if (userMessageIds.length === 0) return null;
	const rows = (await prep(db, "SELECT id, role, cost_usd FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId)) as Array<{
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
export async function getNodeVersions(
	db: AsyncDatabase,
	analyzerId: string,
	sourceSetHash: string,
	asOf?: string,
): Promise<AnalysisNodeRow[]> {
	if (asOf) {
		return (await prep(
				db,
				"SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND source_set_hash = ? AND created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?) ORDER BY created_at ASC, id ASC",
			)
			.all(analyzerId, sourceSetHash, asOf, asOf)) as AnalysisNodeRow[];
	}
	return (await prep(db, "SELECT * FROM live_nodes WHERE analyzer_id = ? AND source_set_hash = ? ORDER BY created_at ASC, id ASC")
		.all(analyzerId, sourceSetHash)) as AnalysisNodeRow[];
}

/** The node that `nodeId` revises (its immediate older-version predecessor), if any. */
export async function getRevisedNode(db: AsyncDatabase, nodeId: string): Promise<AnalysisNodeRow | undefined> {
	const edge = (await prep(db, "SELECT to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = ? LIMIT 1")
		.get(nodeId, EDGE_KINDS.REVISES)) as { to_ref_id: string } | undefined;
	if (!edge) return undefined;
	// `revises` edges reference the predecessor's content-addressed output_key.
	return getNodeByOutputKey(db, edge.to_ref_id);
}

/** Nodes that revise `nodeId` (its newer-version successors), if any. */
export async function getRevisions(db: AsyncDatabase, nodeId: string): Promise<AnalysisNodeRow[]> {
	// `revises` edges point at the predecessor's output_key, so match on that.
	const node = await getNode(db, nodeId);
	if (!node || !node.output_key) return [];
	const edges = (await prep(db, "SELECT from_node_id FROM analysis_edges WHERE to_ref_id = ? AND edge_kind = ?")
		.all(node.output_key, EDGE_KINDS.REVISES)) as Array<{ from_node_id: string }>;
	const out: AnalysisNodeRow[] = [];
	for (const e of edges) {
		const n = await getNode(db, e.from_node_id);
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
	/** Non-retracted node count per analyzer_id (#155). */
	nodesByAnalyzer: Record<string, number>;
}

export async function getAnalysisStats(db: AsyncDatabase, asOf?: string): Promise<AnalysisStats> {
	const nodes = asOf
		? ((await prep(db, "SELECT COUNT(*) AS c FROM analysis_nodes WHERE created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?)").get(asOf, asOf)) as { c: number }).c
		: ((await prep(db, "SELECT COUNT(*) AS c FROM live_nodes").get()) as { c: number }).c;
	// Edges have no timestamp of their own; they are bounded by their source node,
	// so an as-of edge count counts edges whose source node exists at T.
	const edges = asOf
		? ((await prep(
					db,
					"SELECT COUNT(*) AS c FROM analysis_edges e JOIN live_nodes n ON n.id = e.from_node_id WHERE n.created_at <= ? AND (n.retracted_at IS NULL OR n.retracted_at > ?)",
				)
				.get(asOf, asOf)) as { c: number }).c
		: ((await prep(db, "SELECT COUNT(*) AS c FROM analysis_edges e JOIN live_nodes n ON n.id = e.from_node_id").get()) as { c: number }).c;
	const runs = ((await prep(db, "SELECT COUNT(*) AS c FROM analysis_runs").get()) as { c: number }).c;
	const kindRows = asOf
		? ((await prep(db, "SELECT node_kind, COUNT(*) AS c FROM analysis_nodes WHERE created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?) GROUP BY node_kind").all(asOf, asOf)) as Array<{
				node_kind: string;
				c: number;
			}>)
		: ((await prep(db, "SELECT node_kind, COUNT(*) AS c FROM live_nodes GROUP BY node_kind").all()) as Array<{
				node_kind: string;
				c: number;
			}>);
	const nodesByKind: Record<string, number> = {};
	for (const r of kindRows) nodesByKind[r.node_kind] = r.c;
	// Same aggregation over analyzer_id — served by idx_nodes_analyzer.
	const analyzerRows = asOf
		? ((await prep(db, "SELECT analyzer_id, COUNT(*) AS c FROM analysis_nodes WHERE created_at <= ? AND (retracted_at IS NULL OR retracted_at > ?) GROUP BY analyzer_id").all(asOf, asOf)) as Array<{
				analyzer_id: string;
				c: number;
			}>)
		: ((await prep(db, "SELECT analyzer_id, COUNT(*) AS c FROM live_nodes GROUP BY analyzer_id").all()) as Array<{
				analyzer_id: string;
				c: number;
			}>);
	const nodesByAnalyzer: Record<string, number> = {};
	for (const r of analyzerRows) nodesByAnalyzer[r.analyzer_id] = r.c;
	return { nodes, edges, runs, nodesByKind, nodesByAnalyzer };
}

/** A compact, current read of the runs table for discoverability (`prospect runs`). */
export interface RunLite {
	id: string;
	analyzer_id: string;
	analyzer_version_id: string;
	session_id: string;
	mode: string;
	status: string;
	model_spec: string | null;
	started_at: string;
	finished_at: string | null;
	nodes_produced: number;
	nodes_skipped: number;
	cost_usd: number;
	tokens_used: number;
}

export async function listRuns(db: AsyncDatabase, limit = 30): Promise<RunLite[]> {
	return (await db
		.prepare(
			"SELECT id, analyzer_id, analyzer_version_id, session_id, mode, status, model_spec, started_at, finished_at, nodes_produced, nodes_skipped, cost_usd, tokens_used FROM analysis_runs ORDER BY started_at DESC, rowid DESC LIMIT ?",
		)
		.all(limit)) as RunLite[];
}
