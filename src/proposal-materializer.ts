/**
 * Proposal Materializer
 * Creates proposals from analysis nodes for storage in the proposals table
 */

import Database from "better-sqlite3";
import type { AnalysisNodeRow, ProposalSeverity } from "./types.js";

const now = new Date().toISOString();

/**
 * Materialize proposals from analysis results into the database
 */
export function materializeProposals(
	db: Database.Database,
	proposals: Array<{
		sessionId: string;
		target: string;
		severity: ProposalSeverity;
		summary: string;
		detail: string;
		evidence: string;
		dedupHash: string;
	}>,
): number {
	let count = 0;
	const stmt = db.prepare(`INSERT INTO proposals 
		(id, created_at, session_id, target, severity, summary, detail, evidence, status, dedup_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	
	for (const p of proposals) {
		const id = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		
		stmt.run(
			id,
			now,
			p.sessionId,
			p.target,
			p.severity,
			p.summary,
			p.detail,
			p.evidence,
			"new",
			p.dedupHash
		);
		count++;
	}
	
	return count;
}

/**
 * Generate proposals from high-friction analysis nodes
 */
export function generateFromNodes(
	db: Database.Database,
	sessionId: string,
	threshold: number = 0.4
): Array<{
	sessionId: string;
	target: string;
	severity: ProposalSeverity;
	summary: string;
	detail: string;
	evidence: string;
	dedupHash: string;
}> {
	const nodes = db.prepare(`
		SELECT * FROM analysis_nodes 
		WHERE session_id = ? AND (
			json_extract(content_json, '$.correction_detected') = 1 OR 
			json_extract(content_json, '$.friction_score') > ?
		)
	`).all(sessionId, threshold) as AnalysisNodeRow[];
	
	const proposals: Array<{
		sessionId: string;
		target: string;
		severity: ProposalSeverity;
		summary: string;
		detail: string;
		evidence: string;
		dedupHash: string;
	}> = [];
	
	for (const node of nodes) {
		const content = JSON.parse(node.content_json);
		
		// Generate a proposal for corrections
		if (content.correction_detected) {
			for (const pattern of (content.correction_patterns || [])) {
				proposals.push({
					sessionId: node.session_id,
					target: `skills/${content.tool_names?.[0] || "general"}.md`,
					severity: "correction" as ProposalSeverity,
					summary: `Reduce ${pattern} corrections`,
					detail: `User made a ${pattern} correction. Consider improving tool output.`,
					evidence: JSON.stringify({ friction_score: content.friction_score, tool_names: content.tool_names }),
					dedupHash: `${node.session_id}:correction:${pattern}`,
				});
			}
		}
		
		// Generate a proposal for high friction
		if ((content.friction_score || 0) > threshold) {
			proposals.push({
				sessionId: node.session_id,
				target: "general",
				severity: "friction" as ProposalSeverity,
				summary: `High friction turn pair (${content.friction_score})`,
				detail: `User message: ${content.user_msg_length || 0} chars. Tool calls: ${content.tool_call_count}`,
				evidence: JSON.stringify({ friction_score: content.friction_score, tool_calls: content.tool_call_count }),
				dedupHash: `${node.session_id}:friction:${content.friction_score}`,
			});
		}
	}
	
	return proposals;
}

export async function materializeSession(
	db: Database.Database,
	sessionId: string,
	threshold: number = 0.4
): Promise<number> {
	const proposals = generateFromNodes(db, sessionId, threshold);
	return materializeProposals(db, proposals);
}