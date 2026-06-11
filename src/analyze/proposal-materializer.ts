/**
 * Proposal materialisation.
 *
 * Analyzers that emit `summary`/`proposal` nodes embed an
 * `improvement_proposals` array in their content. This module extracts those
 * proposals into the fast-access `proposals` table, deduplicating by a stable
 * key and recording a `produces` edge from the source node to the proposal.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { uuidv7 } from "./input-hash.js";
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
}

export interface MaterializeParams {
	sessionId: string;
	analyzerId: string;
	sourceNodeId: string;
	contentJson: Record<string, unknown>;
	now: string;
}

/** SHA-256 dedup key over the stable identity of a proposal. */
export function computeDedupKey(p: { target_type: string; target_path?: string; severity: string; title: string }): string {
	const normalizedTitle = p.title.trim().toLowerCase().replace(/\s+/g, " ");
	const basis = `${p.target_type}|${p.target_path ?? ""}|${p.severity}|${normalizedTitle}`;
	return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/**
 * Extract and persist proposals from a node's content. Returns the number of
 * *new* proposals created (duplicates of still-open proposals are skipped).
 */
export function materializeProposalsFromNode(db: Database.Database, params: MaterializeParams): number {
	const raw = params.contentJson["improvement_proposals"];
	if (!Array.isArray(raw)) return 0;

	let created = 0;
	for (const candidate of raw) {
		const proposal = normalizeProposal(candidate);
		if (!proposal) continue;

		const dedupKey = computeDedupKey(proposal);
		const existing = db
			.prepare("SELECT id FROM proposals WHERE dedup_key = ? AND status = 'open' LIMIT 1")
			.get(dedupKey) as { id: string } | undefined;
		if (existing) continue;

		const proposalId = uuidv7();
		db.prepare(`
			INSERT INTO proposals
				(id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path,
				 title, severity, summary, detail, evidence, confidence, status, dedup_key)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
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
			dedupKey,
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

	return {
		target_type: targetType,
		target_path: typeof v["target_path"] === "string" ? (v["target_path"] as string) : undefined,
		title,
		summary,
		detail: typeof v["detail"] === "string" ? (v["detail"] as string) : undefined,
		evidence: typeof v["evidence"] === "string" ? (v["evidence"] as string) : undefined,
		confidence: typeof v["confidence"] === "number" ? (v["confidence"] as number) : undefined,
		severity,
	};
}
