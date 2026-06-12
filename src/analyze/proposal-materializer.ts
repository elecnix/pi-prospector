/**
 * Proposal materialisation.
 *
 * Analyzers that emit `summary`/`proposal` nodes embed an
 * `improvement_proposals` array in their content. This module extracts those
 * proposals into the fast-access `proposals` table, deduplicating by a stable
 * key and recording a `produces` edge from the source node to the proposal.
 */

import type Database from "better-sqlite3";
import { shortHash, uuidv7 } from "./input-hash.js";
import { insertEdge } from "../db/analysis-queries.js";
import { EDGE_KINDS, REF_KINDS } from "./edge-kinds.js";

export interface RawProposal {
	target_type: string;
	target_path?: string;
	title: string;
	summary: string;
	detail?: string;
	evidence?: string;
	confidence?: number;
	severity: string;
	/** Originating high-signal turn ids this proposal is replayed against (issue #6). */
	source_message_ids?: string[];
}

export interface MaterializeParams {
	sessionId: string;
	analyzerId: string;
	sourceNodeId: string;
	/** The content-addressed output_key of the source node; the proposal's identity derives from it. */
	sourceOutputKey: string;
	contentJson: Record<string, unknown>;
	now: string;
}

/**
 * A proposal's identity is derived from its *source* — the content-addressed
 * `output_key` of the node that produced it, plus its ordinal within that node's
 * proposal array — never from the model's free-text title/path/severity. So
 * re-materialising the same node is idempotent, while two distinct nodes (a
 * different session, or a revised version) keep their proposals separately.
 */
export function computeProposalInputKey(p: { sourceOutputKey: string; ordinal: number }): string {
	return shortHash(`proposal(${p.sourceOutputKey}|${p.ordinal})`);
}

/**
 * Extract and persist proposals from a node's content. Returns the number of
 * *new* proposals created (duplicates of still-open proposals are skipped).
 */
export function materializeProposalsFromNode(db: Database.Database, params: MaterializeParams): number {
	const raw = params.contentJson["improvement_proposals"];
	if (!Array.isArray(raw)) return 0;

	let created = 0;
	let ordinal = -1;
	for (const candidate of raw) {
		ordinal++;
		const proposal = normalizeProposal(candidate);
		if (!proposal) continue;

		const inputKey = computeProposalInputKey({ sourceOutputKey: params.sourceOutputKey, ordinal });
		const existing = db
			.prepare("SELECT id FROM proposals WHERE input_key = ? AND status = 'open' LIMIT 1")
			.get(inputKey) as { id: string } | undefined;
		if (existing) continue;

		const proposalId = uuidv7();
		db.prepare(`
			INSERT INTO proposals
				(id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path,
				 title, severity, summary, detail, evidence, confidence, status, input_key, source_message_ids)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
		`).run(
			proposalId,
			params.now,
			params.now,
			params.sessionId,
			params.sourceNodeId,
			params.analyzerId,
			proposal.target_type,
			proposal.target_path ?? null,
			proposal.title,
			proposal.severity,
			proposal.summary,
			proposal.detail ?? null,
			proposal.evidence ?? null,
			proposal.confidence ?? null,
			inputKey,
			proposal.source_message_ids && proposal.source_message_ids.length > 0
				? JSON.stringify(proposal.source_message_ids)
				: null,
		);

		insertEdge(db, {
			fromNodeId: params.sourceNodeId,
			toRefKind: REF_KINDS.PROPOSAL,
			toRefId: proposalId,
			edgeKind: EDGE_KINDS.PRODUCES,
			ordinal: created,
		});

		created++;
	}

	return created;
}

/** Coerce an untrusted LLM-produced object into a RawProposal, or null if invalid. */
function normalizeProposal(value: unknown): RawProposal | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const title = typeof v["title"] === "string" ? (v["title"] as string).trim() : "";
	const summary = typeof v["summary"] === "string" ? (v["summary"] as string).trim() : "";
	if (!title || !summary) return null;

	const targetType = typeof v["target_type"] === "string" && v["target_type"] ? (v["target_type"] as string) : "general";
	const severity = typeof v["severity"] === "string" && v["severity"] ? (v["severity"] as string) : "suggestion";
	const sourceMessageIds = Array.isArray(v["source_message_ids"])
		? (v["source_message_ids"] as unknown[]).filter((x): x is string => typeof x === "string")
		: undefined;

	return {
		target_type: targetType,
		target_path: typeof v["target_path"] === "string" ? (v["target_path"] as string) : undefined,
		title,
		summary,
		detail: typeof v["detail"] === "string" ? (v["detail"] as string) : undefined,
		evidence: typeof v["evidence"] === "string" ? (v["evidence"] as string) : undefined,
		confidence: typeof v["confidence"] === "number" ? (v["confidence"] as number) : undefined,
		severity,
		source_message_ids: sourceMessageIds,
	};
}

/**
 * Write a `validation` node's grounded result back onto the proposal it scored
 * (issue #6). The symmetric counterpart to `materializeProposalsFromNode`: the
 * framework calls this whenever it persists a `validation` node, so the fast
 * `proposals` table carries the replay-validated score for ranking and display,
 * while the node itself remains the content-addressed, verifiable record.
 *
 * The proposal is matched by its content-addressed `input_key` (carried in the
 * validation node's content), so the write-back is independent of row ids and
 * survives a wipe + recompute. Returns true if a proposal row was updated.
 */
export function applyValidationFromNode(
	db: Database.Database,
	params: { validationNodeId: string; contentJson: Record<string, unknown>; now: string },
): boolean {
	const proposalInputKey = params.contentJson["proposal_input_key"];
	if (typeof proposalInputKey !== "string" || proposalInputKey.length === 0) return false;

	const rawStatus = params.contentJson["validation_status"];
	const status = rawStatus === "supported" || rawStatus === "unsupported" ? rawStatus : "unvalidated";
	const rawScore = params.contentJson["validated_score"];
	const score = typeof rawScore === "number" ? rawScore : null;

	const res = db
		.prepare(
			"UPDATE proposals SET validated_score = ?, validation_status = ?, validation_node_id = ?, updated_at = ? " +
				"WHERE input_key = ? AND status = 'open'",
		)
		.run(score, status, params.validationNodeId, params.now, proposalInputKey);
	return res.changes > 0;
}
