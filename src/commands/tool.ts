import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type } from "typebox";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getStats, listProposals, acceptProposal, rejectProposal } from "../db/queries.js";
import { getDbPath, getSessionsDir } from "../config.js";

export function registerProspectTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "prospect",
		label: "Prospect",
		description: "Index sessions, check stats, list/accept/reject proposals. Actions: sync, stats, list_proposals, accept, reject.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("sync"),
				Type.Literal("stats"),
				Type.Literal("list_proposals"),
				Type.Literal("accept"),
				Type.Literal("reject"),
			]),
			status: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("accepted"), Type.Literal("rejected")])),
			proposal_id: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, _ctx: unknown) {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				switch (params.action) {
					case "sync": {
						const result = runSync(db, getSessionsDir());
						return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
					}
					case "stats": {
						const stats = getStats(db);
						return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }], details: stats };
					}
					case "list_proposals": {
						const proposals = listProposals(db, params.status as string | undefined);
						if (proposals.length === 0) return { content: [{ type: "text" as const, text: "No proposals found." }], details: [] };
						const text = proposals.map((p) => `[${p.status}] ${p.id.slice(0, 8)} | ${p.severity} | ${p.target}\n  ${p.summary}`).join("\n\n");
						return { content: [{ type: "text" as const, text }], details: proposals };
					}
					case "accept": {
						if (!params.proposal_id) return { content: [{ type: "text" as const, text: "proposal_id required" }], details: {} };
						const ok = acceptProposal(db, params.proposal_id as string);
						return { content: [{ type: "text" as const, text: ok ? `Accepted ${params.proposal_id}` : "Not found or not new" }], details: { ok } };
					}
					case "reject": {
						if (!params.proposal_id) return { content: [{ type: "text" as const, text: "proposal_id required" }], details: {} };
						const ok = rejectProposal(db, params.proposal_id as string);
						return { content: [{ type: "text" as const, text: ok ? `Rejected ${params.proposal_id}` : "Not found or not new" }], details: { ok } };
					}
				}
			} finally {
				db.close();
			}
		},
	});
}