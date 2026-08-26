/**
 * The viz data collector — one pure read of the graph, shaped for the page.
 *
 * This is output machinery in the DESIGN sense: it reads sessions/messages,
 * analysis_nodes + analysis_edges (the edge table is the single source of truth
 * for relationships), proposals, and the assertions-based decisions and
 * remediations — and it writes nothing. Re-running it over an unchanged DB
 * yields byte-identical data, which is what makes re-rendering idempotent.
 *
 * Provenance resolution note: `consumes` and `revises` edges target an upstream
 * node's *output key* (`to_ref_id`), not its row id, because consumers reference
 * their sources by content-addressed result. The collector resolves those back
 * to in-session nodes so the page can draw them as real connections; anything
 * that does not resolve to a session node stays an external reference.
 */

import { type AsyncDatabase } from "../db/async-db.js";
import {
	getAnalyzerConfigRows,
	getPromptRegistryRows,
	getSessionEdges,
	getSessionMessageRows,
	getSessionNodesIncludingRetracted,
} from "../db/analysis-queries.js";
import { getProposalAssertions, getAllRemediationAssertions } from "../db/assertions.js";
import { listProposals } from "../db/queries.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";
import {
	MESSAGE_TEXT_CAP,
	type VizData,
	type VizDecision,
	type VizEdge,
	type VizNode,
	type VizProposal,
	type VizRemediation,
} from "./types.js";

/** The session to render, addressed by id. */
export interface CollectOptions {
	sessionId: string;
}

function truncate(s: string | null): string | null {
	if (s === null) return null;
	return s.length > MESSAGE_TEXT_CAP ? s.slice(0, MESSAGE_TEXT_CAP) : s;
}

export async function collectVizData(db: AsyncDatabase, opts: CollectOptions): Promise<VizData> {
	const sessionId = opts.sessionId;

	const sessionRow = (await db.prepare(
		"SELECT id, name, source, project, cwd, started_at, message_count FROM sessions WHERE id = ?",
	).get(sessionId)) as
		| { id: string; name: string | null; source: string; project: string; cwd: string; started_at: string | null; message_count: number }
		| undefined;
	if (!sessionRow) throw new Error(`Unknown session '${sessionId}'. Run sync first.`);

	const rawMessages = await getSessionMessageRows(db, sessionId);
	const messages = rawMessages.map((m) => ({
		id: m.id,
		role: m.role,
		timestamp: m.timestamp ?? null,
		text: truncate(m.content_text),
		thinking: m.content_thinking === null ? null : m.content_thinking.length > MESSAGE_TEXT_CAP ? m.content_thinking.slice(0, MESSAGE_TEXT_CAP) : m.content_thinking,
		toolCalls: truncate(m.tool_calls),
		isError: m.stop_reason === "error" || m.error_message !== null,
	}));
	// Retracted nodes are collected on purpose: the page filters them, it never
	// pretends they were never there.
	const nodeRows = await getSessionNodesIncludingRetracted(db, sessionId);
	const edgeRows = await getSessionEdges(db, sessionId);

	const byOutputKey = new Map<string, string>();
	for (const n of nodeRows) if (n.output_key) byOutputKey.set(n.output_key, n.id);
	const nodeIds = new Set(nodeRows.map((n) => n.id));

	// Rewrite consumes/revises targets from output keys to node ids where the
	// target is a node of this session; leave foreign targets as-is so the page
	// can still label the connection honestly.
	const edges: VizEdge[] = edgeRows.map((e) => ({
		id: e.id,
		fromNodeId: e.from_node_id,
		edgeKind: e.edge_kind,
		toRefKind: e.to_ref_kind,
		toRefId: e.to_ref_kind === REF_KINDS.ANALYSIS_NODE ? (byOutputKey.get(e.to_ref_id) ?? e.to_ref_id) : e.to_ref_id,
		ordinal: e.ordinal,
	}));

	// ── consumption depth (for depth-collapse) ──
	const consumedBy = new Map<string, string[]>();
	for (const e of edges) {
		if (e.edgeKind === EDGE_KINDS.CONSUMES && nodeIds.has(e.toRefId)) {
			const list = consumedBy.get(e.fromNodeId) ?? [];
			list.push(e.toRefId);
			consumedBy.set(e.fromNodeId, list);
		}
	}
	const depthOf = new Map<string, number>();
	// Iterative fixpoint: acyclic by construction, but never trust construction.
	for (let guard = 0; guard <= nodeRows.length; guard++) {
		let changed = false;
		for (const n of nodeRows) {
			const inputs = consumedBy.get(n.id);
			if (!inputs || inputs.length === 0) {
				if (!depthOf.has(n.id)) { depthOf.set(n.id, 0); changed = true; }
				continue;
			}
			if (inputs.every((i) => depthOf.has(i))) {
				const d = 1 + Math.max(...inputs.map((i) => depthOf.get(i)!));
				if (depthOf.get(n.id) !== d) { depthOf.set(n.id, d); changed = true; }
			}
		}
		if (!changed) break;
	}

	// ── lineage groups (revises chains, oldest first) ──
	const parent = new Map<string, string>();
	for (const n of nodeRows) parent.set(n.id, n.id);
	function find(x: string): string {
		while (parent.get(x) !== x) x = parent.get(x)!;
		return x;
	}
	for (const e of edges) {
		if (e.edgeKind === EDGE_KINDS.REVISES && nodeIds.has(e.toRefId)) {
			const a = find(e.fromNodeId);
			const b = find(e.toRefId);
			if (a !== b) parent.set(a, b);
		}
	}
	const membersByRoot = new Map<string, string[]>();
	for (const n of nodeRows) {
		const root = find(n.id);
		const list = membersByRoot.get(root) ?? [];
		list.push(n.id);
		membersByRoot.set(root, list);
	}
	const lineageGroups = [...membersByRoot.entries()]
		.filter(([, ids]) => ids.length > 1)
		.map(([root, ids]) => {
			ids.sort((x, y) => {
				const nx = nodeRows.find((n) => n.id === x)!;
				const ny = nodeRows.find((n) => n.id === y)!;
				return nx.created_at < ny.created_at ? -1 : nx.created_at > ny.created_at ? 1 : x < y ? -1 : 1;
			});
			void root;
			return ids;
		});
	const groupIndexOf = new Map<string, number>();
	lineageGroups.forEach((ids, i) => ids.forEach((id) => groupIndexOf.set(id, i)));

	const nodes: VizNode[] = nodeRows.map((n) => {
		let content: unknown;
		try {
			content = JSON.parse(n.content_json);
		} catch (err) {
			throw new Error(`Node ${n.id} has malformed content_json: ${err instanceof Error ? err.message : String(err)}`);
		}
		return {
			id: n.id,
			analyzerId: n.analyzer_id,
			analyzerVersionId: n.analyzer_version_id,
			nodeKind: n.node_kind,
			content,
			createdAt: n.created_at,
			retractedAt: n.retracted_at ?? null,
			inputKey: n.input_key,
			outputKey: n.output_key,
			modelUsed: n.model_used ?? null,
			costUsd: n.cost_usd ?? null,
			tokensUsed: n.tokens_used ?? null,
			depth: depthOf.get(n.id) ?? 0,
			lineageGroup: groupIndexOf.has(n.id) ? groupIndexOf.get(n.id)! : null,
		};
	});

	// ── proposals + evidence trails ──
	const proposalRows = await listProposals(db, undefined, undefined, undefined, undefined, undefined, sessionId);

	// anchors-message adjacency, for click-through evidence paths.
	const anchoredMessagesByNode = new Map<string, string[]>();
	for (const e of edges) {
		if (e.edgeKind === EDGE_KINDS.ANCHORS && e.toRefKind === REF_KINDS.MESSAGE) {
			const list = anchoredMessagesByNode.get(e.fromNodeId) ?? [];
			list.push(e.toRefId);
			anchoredMessagesByNode.set(e.fromNodeId, list);
		}
	}

	const proposals: VizProposal[] = proposalRows.map((p) => {
		let sourceIds: string[] = [];
		try {
			sourceIds = p.source_message_ids ? (JSON.parse(p.source_message_ids) as string[]) : [];
		} catch {
			sourceIds = [];
		}
		// Walk back: source summary → everything it consumed → every message any
		// of those nodes anchors. Order follows the walk, evidence-first.
		const trailNodes: string[] = [];
		const seenNodes = new Set<string>();
		if (p.source_node_id && nodeIds.has(p.source_node_id)) {
			const queue = [p.source_node_id];
			while (queue.length > 0) {
				const id = queue.shift()!;
				if (seenNodes.has(id)) continue;
				seenNodes.add(id);
				trailNodes.push(id);
				for (const e of edges) {
					if (e.fromNodeId === id && e.edgeKind === EDGE_KINDS.CONSUMES && nodeIds.has(e.toRefId)) queue.push(e.toRefId);
				}
			}
		}
		const msgSet = new Set<string>(sourceIds);
		for (const id of trailNodes) {
			for (const m of anchoredMessagesByNode.get(id) ?? []) msgSet.add(m);
		}
		return {
			id: p.id,
			title: p.title,
			severity: p.severity,
			status: p.status,
			summary: p.summary,
			detail: p.detail ?? null,
			evidence: p.evidence ?? null,
			confidence: p.confidence ?? null,
			validatedScore: p.validated_score ?? null,
			validationStatus: p.validation_status,
			sourceNodeId: p.source_node_id ?? null,
			targetType: p.target_type,
			targetPath: p.target_path ?? null,
			inputKey: p.input_key,
			sourceMessageIds: sourceIds,
			evidenceNodes: trailNodes,
			evidenceMessages: [...msgSet],
		};
	});

	// ── decisions & remediations from the assertions relation ──
	const inputKeys = new Set(proposalRows.map((p) => p.input_key));
	const allProposalAssertions = await getProposalAssertions(db);
	const decisions: VizDecision[] = allProposalAssertions
		.filter((a) => inputKeys.has(a.subject_key))
		.map((a) => ({
			proposalInputKey: a.subject_key,
			verdict: a.verdict,
			disposition: a.disposition ?? null,
			actualChange: a.actual_change ?? null,
			reason: a.reason ?? null,
			assertedAt: a.asserted_at,
			remediationId: a.remediation_id ?? null,
		}));

	const remediationAssertions = await getAllRemediationAssertions(db);
	const remediationIdsHere = new Set(decisions.map((d) => d.remediationId).filter((r): r is string => r !== null));
	const remediations: VizRemediation[] = remediationAssertions
		.filter((r) => remediationIdsHere.has(r.subject_key))
		.map((r) => ({
			id: r.subject_key,
			description: r.reason ?? null,
			assertedAt: r.asserted_at,
			decisionInputKeys: decisions.filter((d) => d.remediationId === r.subject_key).map((d) => d.proposalInputKey),
		}));

	// ── assertions reached by `mutes` edges, prompts & configs by uses_* ──
	const assertionIds = new Set<string>();
	const promptHashes = new Set<string>();
	const configIds = new Set<string>();
	for (const e of edges) {
		if (e.edgeKind === EDGE_KINDS.MUTES) assertionIds.add(e.toRefId);
		else if (e.edgeKind === EDGE_KINDS.USES_PROMPT) promptHashes.add(e.toRefId);
		else if (e.edgeKind === EDGE_KINDS.USES_CONFIG) configIds.add(e.toRefId);
	}
	const assertions = [];
	for (const id of assertionIds) {
		const row = (await db.prepare(
			"SELECT id, subject_kind, subject_key, verdict, reason FROM assertions WHERE id = ?",
		).get(id)) as { id: string; subject_kind: string; subject_key: string; verdict: string; reason: string | null } | undefined;
		if (row) assertions.push({ id: row.id, subjectKind: row.subject_kind, subjectKey: row.subject_key, verdict: row.verdict, reason: row.reason });
	}
	const promptRows = await getPromptRegistryRows(db, [...promptHashes]);
	const configRows = await getAnalyzerConfigRows(db, [...configIds]);

	return {
		version: 1,
		session: {
			id: sessionRow.id,
			name: sessionRow.name,
			source: sessionRow.source,
			project: sessionRow.project,
			cwd: sessionRow.cwd,
			startedAt: sessionRow.started_at,
			messageCount: sessionRow.message_count,
		},
		messages,
		nodes,
		edges,
		proposals,
		decisions,
		remediations,
		assertions,
		prompts: promptRows.map((p) => ({ hash: p.hash, content: p.content })),
		configs: configRows.map((c) => ({ id: c.id, analyzerId: c.analyzer_id, configJson: c.config_json })),
		lineageGroups: lineageGroups.map((ids, i) => ({ index: i, nodeIds: ids })),
	};
}
