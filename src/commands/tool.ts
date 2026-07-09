import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type } from "typebox";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getStats, listProposals, acceptProposal, rejectProposal, getLatestDecision, getSessionLabels } from "../db/queries.js";
import type { DecisionInput } from "../db/queries.js";
import { rankProposals, conciseEntry, sessionLabel } from "./proposals.js";
import type { Proposal } from "../types.js";
import { getDbPath, getSessionsDir } from "../config.js";

function text(body: string, details: unknown): ToolResult {
	return { content: [{ type: "text", text: body }], details };
}

/** Build the optional decision payload from tool params (all fields optional). */
function decisionInputFrom(params: Record<string, unknown>): DecisionInput {
	return {
		disposition: (params.disposition as DecisionInput["disposition"]) ?? null,
		rationale: (params.rationale as string | undefined) ?? null,
		actual_change: (params.actual_change as string | undefined) ?? null,
	};
}

export function registerProspectTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "prospect",
		label: "Prospect",
		description:
			"Index sessions, check stats, list/accept/reject proposals. Actions: sync, stats, list_proposals, accept, reject. " +
			"When accepting/rejecting, pass the human's reasoning via rationale, and disposition to record whether the " +
			"recommended action is planned, already done, or done_differently (the idea triggered a different action).",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("sync"),
				Type.Literal("stats"),
				Type.Literal("list_proposals"),
				Type.Literal("accept"),
				Type.Literal("reject"),
			]),
			status: Type.Optional(
				Type.Union([
					Type.Literal("open"),
					Type.Literal("applied"),
					Type.Literal("rejected"),
					Type.Literal("duplicate"),
				]),
			),
			severity: Type.Optional(Type.String({ description: "Filter by severity: friction, correction, waste, suggestion, reinforcement" })),
			proposal_id: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ description: "Maximum number of proposals to return (defaults to 100 if omitted)." })),
			offset: Type.Optional(Type.Number({ description: "Number of proposals to skip before starting to return results." })),
			rationale: Type.Optional(Type.String({ description: "Human reasoning behind the decision (stored as durable memory)." })),
			disposition: Type.Optional(
				Type.Union([Type.Literal("planned"), Type.Literal("done"), Type.Literal("done_differently")], {
					description: "planned = will do it; done = did the recommended action; done_differently = the idea triggered a different action.",
				}),
			),
			actual_change: Type.Optional(Type.String({ description: "Commit sha / path / note of what was actually done." })),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			_ctx: ExtensionCommandContext,
		): Promise<ToolResult> {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				switch (params.action) {
					case "sync": {
						const result = runSync(db, getSessionsDir());
						return text(JSON.stringify(result), result);
					}
					case "stats": {
						const stats = getStats(db);
						return text(JSON.stringify(stats, null, 2), stats);
					}
					case "list_proposals": {
						const limit = params.limit !== undefined ? (params.limit as number) : 100;
						const offset = params.offset as number | undefined;
						const status = params.status as string | undefined;
						const severity = params.severity as string | undefined;
						const proposals = listProposals(db, status, severity, limit, offset).sort(rankProposals);
						const filterDesc = [status, severity].filter(Boolean).join(" ");
						if (proposals.length === 0) {
							return text(filterDesc ? `No ${filterDesc} proposals found.` : "No proposals found.", []);
						}
						// Group by session and reuse the slash-command conciseEntry formatter,
						// so the tool and `/prospect-proposals` render identical entries (#21).
						const labels = new Map(getSessionLabels(db).map((s) => [s.id, s]));
						const groups = new Map<string, Proposal[]>();
						for (const p of proposals) {
							const bucket = groups.get(p.session_id);
							if (bucket) bucket.push(p);
							else groups.set(p.session_id, [p]);
						}
						const blocks: string[] = [];
						for (const [sessionId, group] of groups) {
							const label = sessionLabel(labels.get(sessionId), sessionId);
							const header = `═══ ${sessionId.slice(0, 8)} · ${label} · ${group.length} proposal(s) ═══`;
							blocks.push(`${header}\n${group.map((p) => conciseEntry(p, getLatestDecision(db, p.input_key))).join("\n\n")}`);
						}
						const headline = `Proposals (${proposals.length}${filterDesc ? `, ${filterDesc}` : ""}) in ${groups.size} session(s), ranked by validated score then confidence:`;
						return text(`${headline}\n\n${blocks.join("\n\n")}`, proposals);
					}
					case "accept": {
						if (!params.proposal_id) return text("proposal_id required", {});
						const ok = acceptProposal(db, params.proposal_id as string, decisionInputFrom(params));
						return text(ok ? `Applied ${params.proposal_id}` : `Proposal "${params.proposal_id}" not found or not open. Use the full ID from the list_proposals output (e.g., prospect show <id>). Check that the proposal is still "open".`, { ok });
					}
					case "reject": {
						if (!params.proposal_id) return text("proposal_id required", {});
						const ok = rejectProposal(db, params.proposal_id as string, decisionInputFrom(params));
						return text(ok ? `Rejected ${params.proposal_id}` : `Proposal "${params.proposal_id}" not found or not open. Use the full ID from the list_proposals output (e.g., prospect show <id>). Check that the proposal is still "open".`, { ok });
					}
					default:
						return text(`Unknown action: ${String(params.action)}`, {});
				}
			} finally {
				db.close();
			}
		},
	});
}
