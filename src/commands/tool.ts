import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type } from "typebox";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getStats, listProposals, acceptProposal, rejectProposal } from "../db/queries.js";
import type { DecisionInput } from "../db/queries.js";
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
			proposal_id: Type.Optional(Type.String()),
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
						const proposals = listProposals(db, params.status as string | undefined);
						if (proposals.length === 0) return text("No proposals found.", []);
						const body = proposals
							.map((p) => `[${p.status}] ${p.id.slice(0, 8)} | ${p.severity} | ${p.target_type}\n  ${p.title}`)
							.join("\n\n");
						return text(body, proposals);
					}
					case "accept": {
						if (!params.proposal_id) return text("proposal_id required", {});
						const ok = acceptProposal(db, params.proposal_id as string, decisionInputFrom(params));
						return text(ok ? `Applied ${params.proposal_id}` : "Not found or not open", { ok });
					}
					case "reject": {
						if (!params.proposal_id) return text("proposal_id required", {});
						const ok = rejectProposal(db, params.proposal_id as string, decisionInputFrom(params));
						return text(ok ? `Rejected ${params.proposal_id}` : "Not found or not open", { ok });
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
