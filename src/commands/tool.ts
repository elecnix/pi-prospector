import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type } from "typebox";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getStats, listProposals, acceptProposal, rejectProposal, acceptProposalsBulk, rejectProposalsBulk, acceptProposalsWithRemediation, getLatestDecision, getSessionLabels } from "../db/queries.js";
import type { DecisionInput } from "../db/queries.js";
import { rankProposals, conciseEntry, sessionGroupHeader } from "./proposals.js";
import { muteTerm, unmuteTerm, formatAssertion } from "./mutes.js";
import { listAssertions } from "../db/assertions.js";
import type { Proposal } from "../types.js";
import { parseHarnessSource } from "../harness.js";
import { getDbPath, getSessionsDir, getClaudeSessionsDir } from "../config.js";

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
			"Index sessions, check stats, list/accept/reject proposals, and mute/unmute lexicon terms. Actions: sync, stats, list_proposals, accept, reject, remediate, mute, unmute, mutes, help. " +
			"list_proposals accepts source (pi|claude) to filter by coding harness. " +
			"When accepting/rejecting, pass the human's reasoning via rationale, and disposition to record whether the " +
			"recommended action is planned, already done, or done_differently (the idea triggered a different action). " +
			"Use proposal_ids (string array) on accept/reject for bulk operations with a shared rationale. " +
			"Use remediate when ONE action addresses MANY proposals: pass proposal_ids and a description, and all of them " +
			"are accepted linked to a single shared remediation record instead of N duplicated rationales. " +
			"For muting: the reviewing agent performs the mute after operator feedback — pass the muted term and an optional reason; " +
			"the term stops matching new turns and its prior hit nodes become stale/config, cleanly recomputed by analyze --revise config.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("sync"),
				Type.Literal("stats"),
				Type.Literal("list_proposals"),
				Type.Literal("accept"),
				Type.Literal("reject"),
				Type.Literal("remediate"),
				Type.Literal("mute"),
				Type.Literal("unmute"),
				Type.Literal("mutes"),
				Type.Literal("help"),
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
			source: Type.Optional(Type.String({ description: "Filter by coding harness: pi or claude." })),
			proposal_id: Type.Optional(Type.String()),
			proposal_ids: Type.Optional(Type.Array(Type.String(), { description: "Proposal ids to accept/reject together (accept/reject/remediate actions)." })),
			description: Type.Optional(Type.String({ description: "The one remediation action that addresses all proposal_ids (remediate action)." })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of proposals to return (defaults to 100 if omitted)." })),
			offset: Type.Optional(Type.Number({ description: "Number of proposals to skip before starting to return results." })),
			rationale: Type.Optional(Type.String({ description: "Human reasoning behind the decision (stored as durable memory)." })),
			disposition: Type.Optional(
				Type.Union([Type.Literal("planned"), Type.Literal("done"), Type.Literal("done_differently")], {
					description: "planned = will do it; done = did the recommended action; done_differently = the idea triggered a different action.",
				}),
			),
			actual_change: Type.Optional(Type.String({ description: "Commit sha / path / note of what was actually done." })),
			term: Type.Optional(Type.String({ description: "The lexicon term to mute or unmute (mute/unmute actions)." })),
			reason: Type.Optional(Type.String({ description: "Operator's free-text reason for muting a term (mute action)." })),
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
						const result = runSync(db, getSessionsDir(), getClaudeSessionsDir());
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
						const source = parseHarnessSource(params.source as string | undefined);
						const proposals = listProposals(db, status, severity, limit, offset, source).sort(rankProposals);
						const filterDesc = [status, severity, source ? `source ${source}` : undefined].filter(Boolean).join(" ");
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
							const header = sessionGroupHeader(labels.get(sessionId), sessionId, group.length);
							blocks.push(`${header}\n${group.map((p) => conciseEntry(p, getLatestDecision(db, p.input_key))).join("\n\n")}`);
						}
						const headline = `Proposals (${proposals.length}${filterDesc ? `, ${filterDesc}` : ""}) in ${groups.size} session(s), ranked by validated score then confidence:`;
						return text(`${headline}\n\n${blocks.join("\n\n")}`, proposals);
					}
					case "accept": {
						const decision = decisionInputFrom(params);
						// Bulk path: proposal_ids array
						if (params.proposal_ids && Array.isArray(params.proposal_ids) && (params.proposal_ids as string[]).length > 0) {
							const ids = params.proposal_ids as string[];
							const res = acceptProposalsBulk(db, ids, decision);
							const lines = [`Accepted ${res.accepted.length} proposal(s): ${res.accepted.join(", ")}`];
							if (res.skipped.length > 0) lines.push(`Skipped (not found or not open): ${res.skipped.join(", ")}`);
							return text(lines.join("\n"), res);
						}
						// Single path
						if (!params.proposal_id) return text("proposal_id or proposal_ids required", {});
						const ok = acceptProposal(db, params.proposal_id as string, decision);
						return text(ok ? `Applied ${params.proposal_id}` : `Proposal "${params.proposal_id}" not found or not open. Use the full ID from the list_proposals output (e.g., prospect show <id>). Check that the proposal is still "open".`, { ok });
					}
					case "remediate": {
						const ids = params.proposal_ids as string[] | undefined;
						if (!ids || ids.length === 0) return text("proposal_ids required", {});
						if (!params.description) return text("description required", {});
						const res = acceptProposalsWithRemediation(
							db,
							ids,
							{ description: params.description as string, actual_change: (params.actual_change as string | undefined) ?? null },
							decisionInputFrom(params),
						);
						if (!res.remediationId) {
							return text(
								`No open proposal among: ${ids.join(", ")}. Use the full IDs from the list_proposals output and check they are still "open".`,
								res,
							);
						}
						const lines = [`Remediation ${res.remediationId} applied to ${res.accepted.length} proposal(s): ${res.accepted.join(", ")}`];
						if (res.skipped.length > 0) lines.push(`Skipped (not found or not open): ${res.skipped.join(", ")}`);
						return text(lines.join("\n"), res);
					}
					case "reject": {
						const decision = decisionInputFrom(params);
						// Bulk path: proposal_ids array
						if (params.proposal_ids && Array.isArray(params.proposal_ids) && (params.proposal_ids as string[]).length > 0) {
							const ids = params.proposal_ids as string[];
							const res = rejectProposalsBulk(db, ids, decision);
							const lines = [`Rejected ${res.rejected.length} proposal(s): ${res.rejected.join(", ")}`];
							if (res.skipped.length > 0) lines.push(`Skipped (not found or not open): ${res.skipped.join(", ")}`);
							return text(lines.join("\n"), res);
						}
						// Single path
						if (!params.proposal_id) return text("proposal_id or proposal_ids required", {});
						const ok = rejectProposal(db, params.proposal_id as string, decision);
						return text(ok ? `Rejected ${params.proposal_id}` : `Proposal "${params.proposal_id}" not found or not open. Use the full ID from the list_proposals output (e.g., prospect show <id>). Check that the proposal is still "open".`, { ok });
					}
					case "mute": {
						if (!params.term) return text("term required for mute", {});
						const term = params.term as string;
						const { assertionId } = muteTerm(db, {
							term,
							reason: (params.reason as string | undefined) ?? null,
							by: "agent",
						});
						return text(
							`Muted '${term.toLowerCase()}'. It will stop matching new turns; its existing hit nodes stay as stale/config lineage. ` +
								`Run analyze with revise=config to recompute nodes that consulted it. Assertion ${assertionId}.`,
							{ assertionId, term: term.toLowerCase() },
						);
					}
					case "unmute": {
						if (!params.term) return text("term required for unmute", {});
						const term = params.term as string;
						const n = unmuteTerm(db, term);
						return text(
							n > 0 ? `Unmuted '${term.toLowerCase()}'.` : `'${term.toLowerCase()}' was not muted.`,
							{ superseded: n, term: term.toLowerCase() },
						);
					}
					case "mutes": {
						const rows = listAssertions(db, "term");
						if (rows.length === 0) return text("No term assertions recorded.", []);
						const active = rows.filter((r) => r.superseded_at === null).length;
						return text(`Term assertions (${rows.length} total, ${active} active):\n${rows.map(formatAssertion).join("\n")}`, rows);
					}
					case "help": {
						return text(`=== prospect tool ===

Workflow:
  1. sync   — index new sessions from disk
  2. stats  — see proposal counts, token ratios, analysis depth
  3. list_proposals [status] [severity] [limit] [offset] — ranked by confidence
      (add --as-of <ts|7d> / --as-of-run <id> for a point-in-time view)
  4. accept/reject — decide proposals singly or in bulk (proposal_ids array)
  5. remediate — accept many proposals under one shared remediation record

Analysis-graph & point-in-time commands (slash commands):
  - /prospect-stats --as-of <ts|7d> | --as-of-run <id> — stats as of a past point
  - /prospect-proposals --as-of <ts> — proposals with status reconstructed from decisions
  - /prospect-runs — list recent runs (ids for diff --runs / --as-of-run)
  - /prospect-diff --unit <analyzer> <sset> | --runs <A> <B> | --as-of <T1> <T2> [--full]
  - /prospect-gc --run <id> | --analyzer <id> | --since <ts> [--apply] — retract output (dry run by default)
  - /prospect-retract --list | --undo <gcId> | --purge --retracted-before <ts>
  - /prospect-verify — now also validates every edge's referential integrity

Bulk operations:
  - accept/reject accept proposal_ids (string array) for bulk decisions
    with a shared rationale. Skipped ids (not found or not open) are reported.
  - remediate is for ONE action addressing MANY proposals — one remediation
    row, one description, N decision rows.

Custom analyzers:
  Place a TypeScript module in ~/.pi/agent/prospector/analyzers/<id>/
  with index.ts (register function), config.ts, and a prompt.ts.
  The register function takes an AnalyzerFramework and returns void.
  Use pi --prospect "analyzers" to list registered analyzers.
  Use pi --prospect "analyze --analyzer <id>" to run a specific one.
  See DESIGN.md for the full architecture.`, {});
					}
					default: {
						return text(`Unknown action: ${String(params.action)}`, {});
					}
				}
			} finally {
				db.close();
			}
		},
	});
}
