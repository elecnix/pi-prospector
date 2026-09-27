import type { ExtensionCommandContext, ToolResult } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { buildAdapters } from "./sync.js";
import { getStats, listProposals, acceptProposal, rejectProposal, acceptProposalsBulk, rejectProposalsBulk, acceptProposalsWithRemediation, getLatestDecision, getSessionLabels } from "../db/queries.js";
import type { DecisionInput } from "../db/queries.js";
import { rankProposals, conciseEntry, sessionGroupHeader } from "./proposals.js";
import { collectSupportMap, nestProposals, renderGroupedProposals, serialiseGrouped } from "./grouping.js";
import { muteTerm, unmuteTerm, formatAssertion } from "./mutes.js";
import { prospectAnalyze } from "./analyze.js";
import { getLatestAnalyzeRuns } from "../db/analysis-queries.js";
import { readNodes, readNodeDetail, type NodesQuery } from "./nodes.js";
import { readSessionSummary } from "./show.js";
import { readLeaks, type LeaksQuery } from "./leaks.js";
import { readSearch, searchSyntaxHelp, type SearchQuery } from "./search.js";
import { listAssertions } from "../db/assertions.js";
import type { Proposal } from "../types.js";
import type { AnalysisNodeRow } from "../analyze/types.js";
import { parseHarnessSource } from "../harness.js";
import { getDbPath } from "../config.js";

function text(body: string, details: unknown): ToolResult {
	return { content: [{ type: "text", text: body }], details };
}

/** A compact JSON-safe summary of one node row for tool `details`. */
function serialiseNodeSummary(n: AnalysisNodeRow): Record<string, unknown> {
	let content: unknown;
	try {
		content = JSON.parse(n.content_json) as unknown;
	} catch {
		content = n.content_json;
	}
	return {
		output_key: n.output_key,
		input_key: n.input_key,
		analyzer_id: n.analyzer_id,
		node_kind: n.node_kind,
		session_id: n.session_id,
		created_at: n.created_at,
		content,
	};
}

/** Build the optional decision payload from tool params (all fields optional). */
function decisionInputFrom(params: Record<string, unknown>): DecisionInput {
	return {
		disposition: (params.disposition as DecisionInput["disposition"]) ?? null,
		rationale: (params.rationale as string | undefined) ?? null,
		actual_change: (params.actual_change as string | undefined) ?? null,
	};
}

export async function executeProspectTool(
	_toolCallId: string,
	params: Record<string, unknown>,
	_signal: AbortSignal,
	_onUpdate: unknown,
	ctx: ExtensionCommandContext,
): Promise<ToolResult> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		switch (params.action) {
			case "sync": {
				const result = await runSync(db, buildAdapters(), {
					project: params.project as string | undefined,
					source: parseHarnessSource(params.source as string | undefined),
				});
				return text(JSON.stringify(result), result);
			}
			case "analyze": {
				// Thin exposure of /prospect-analyze (#193): translate params into the
				// same flag string the slash command parses, then report the run record
				// so the caller gets the tallies without re-parsing human output.
				const parts: string[] = [];
				const revise = params.revise as string[] | undefined;
				if (revise && revise.length > 0) parts.push(`--revise ${revise.join(",")}`);
				if (params.all === true) parts.push("--all");
				if (typeof params.limit === "number") parts.push(`--limit ${params.limit}`);
				if (typeof params.recent === "number") parts.push(`--recent ${params.recent}`);
				if (params.session_id) parts.push(`--session ${params.session_id}`);
				if (params.source) parts.push(`--source ${params.source}`);
				if (params.analyzer) parts.push(`--analyzer ${params.analyzer}`);
				if (params.model) parts.push(`--model ${params.model}`);
				await prospectAnalyze(parts.join(" "), ctx);
				const runs = await getLatestAnalyzeRuns(db, 1);
				const run = runs[0];
				return run
					? text(`Analyze complete. Run record:\n${JSON.stringify(run, null, 2)}`, run)
					: text("Analyze complete (no run record found).", {});
			}
			case "stats": {
				const stats = await getStats(db);
				return text(JSON.stringify(stats, null, 2), stats);
			}
			case "list_proposals": {
				const limit = params.limit !== undefined ? (params.limit as number) : 100;
				const offset = params.offset as number | undefined;
				const status = params.status as string | undefined;
				const severity = params.severity as string | undefined;
				const source = parseHarnessSource(params.source as string | undefined);
				const sessionId = params.session_id as string | undefined;
				const proposals = (await listProposals(db, status, severity, limit, offset, source, sessionId)).sort(rankProposals);
				const filterDesc = [status, severity, sessionId ? `session ${sessionId}` : undefined, source ? `source ${source}` : undefined]
					.filter(Boolean)
					.join(" ");
				if (proposals.length === 0) {
					return text(filterDesc ? `No ${filterDesc} proposals found.` : "No proposals found.", []);
				}
				// Group by session and reuse the slash-command conciseEntry formatter,
				// so the tool and `/prospect-proposals` render identical entries (#21).
				const labels = new Map((await getSessionLabels(db)).map((s) => [s.id, s]));
				const groups = new Map<string, Proposal[]>();
				for (const p of proposals) {
					const bucket = groups.get(p.session_id);
					if (bucket) bucket.push(p);
					else groups.set(p.session_id, [p]);
				}
				// Issue #107: display-time grouping — a general proposal nests the
				// lower-level proposals it generalises (consumes/produces walk-back),
				// both in the human-readable text and as a `supports` structure on
				// these machine-readable details. Nothing is dropped: ungrouped rows
				// keep their flat shape; grouped ones embed their supports.
				const tree: Array<Record<string, unknown>> = [];
				const blocks: string[] = [];
				for (const [sessionId, group] of groups) {
					const header = sessionGroupHeader(labels.get(sessionId), sessionId, group.length);
					const format = async (p: Proposal) => conciseEntry(p, await getLatestDecision(db, p.input_key));
					const nested = nestProposals(group, await collectSupportMap(db, group));
					tree.push(...nested.map(serialiseGrouped));
					const rendered = await renderGroupedProposals(nested, format);
					blocks.push(`${header}\n${rendered.join("\n\n")}`);
				}
				const headline = `Proposals (${proposals.length}${filterDesc ? `, ${filterDesc}` : ""}) in ${groups.size} session(s), ranked by validated score then confidence:`;
				return text(`${headline}\n\n${blocks.join("\n\n")}`, tree);
			}
			case "accept": {
				const decision = decisionInputFrom(params);
				// Bulk path: proposal_ids array
				if (params.proposal_ids && Array.isArray(params.proposal_ids) && (params.proposal_ids as string[]).length > 0) {
					const ids = params.proposal_ids as string[];
					const res = await acceptProposalsBulk(db, ids, decision);
					const lines = [`Accepted ${res.accepted.length} proposal(s): ${res.accepted.join(", ")}`];
					if (res.skipped.length > 0) lines.push(`Skipped (not found or not open): ${res.skipped.join(", ")}`);
					return text(lines.join("\n"), res);
				}
				// Single path
				if (!params.proposal_id) return text("proposal_id or proposal_ids required", {});
				const ok = await acceptProposal(db, params.proposal_id as string, decision);
				return text(ok ? `Applied ${params.proposal_id}` : `Proposal "${params.proposal_id}" not found or not open. Use the full ID from the list_proposals output (e.g., prospect show <id>). Check that the proposal is still "open".`, { ok });
			}
			case "remediate": {
				const ids = params.proposal_ids as string[] | undefined;
				if (!ids || ids.length === 0) return text("proposal_ids required", {});
				if (!params.description) return text("description required", {});
				const res = await acceptProposalsWithRemediation(
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
					const res = await rejectProposalsBulk(db, ids, decision);
					const lines = [`Rejected ${res.rejected.length} proposal(s): ${res.rejected.join(", ")}`];
					if (res.skipped.length > 0) lines.push(`Skipped (not found or not open): ${res.skipped.join(", ")}`);
					return text(lines.join("\n"), res);
				}
				// Single path
				if (!params.proposal_id) return text("proposal_id or proposal_ids required", {});
				const ok = await rejectProposal(db, params.proposal_id as string, decision);
				return text(ok ? `Rejected ${params.proposal_id}` : `Proposal "${params.proposal_id}" not found or not open. Use the full ID from the list_proposals output (e.g., prospect show <id>). Check that the proposal is still "open".`, { ok });
			}
			case "mute": {
				if (!params.term) return text("term required for mute", {});
				const term = params.term as string;
				const { assertionId } = await muteTerm(db, {
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
				const n = await unmuteTerm(db, term);
				return text(
					n > 0 ? `Unmuted '${term.toLowerCase()}'.` : `'${term.toLowerCase()}' was not muted.`,
					{ superseded: n, term: term.toLowerCase() },
				);
			}
			case "mutes": {
				const rows = await listAssertions(db, "term");
				if (rows.length === 0) return text("No term assertions recorded.", []);
				const active = rows.filter((r) => r.superseded_at === null).length;
				return text(`Term assertions (${rows.length} total, ${active} active):\n${rows.map(formatAssertion).join("\n")}`, rows);
			}
			case "nodes": {
			const q: NodesQuery = {
				analyzerId: params.analyzer as string | undefined,
				all: params.all as boolean | undefined,
				nodeKind: params.node_kind as string | undefined,
				filters: Array.isArray(params.filter) ? (params.filter as string[]) : [],
				counts: params.counts as string | undefined,
				latestPerKey: params.latest_per_key as string | undefined,
				allVersions: params.all_versions as boolean | undefined,
				limit: params.limit as number | undefined,
				offset: params.offset as number | undefined,
				sessionId: params.session_id as string | undefined,
			};
			try {
				const result = await readNodes(db, q);
				return text(result.text, { total: result.total, nodes: result.rows.map(serialiseNodeSummary) });
			} catch (err) {
				return text(`prospect nodes: ${err instanceof Error ? err.message : String(err)}`, {});
			}
		}
		case "node": {
			if (!params.output_key) return text("output_key required (use action nodes to find one)", {});
			try {
				const result = await readNodeDetail(db, params.output_key as string);
				return text(result.text, { node: serialiseNodeSummary(result.node) });
			} catch (err) {
				return text(`prospect node: ${err instanceof Error ? err.message : String(err)}`, {});
			}
		}
		case "leaks": {
			const q: LeaksQuery = {
				minSeverity: params.severity as string | undefined,
				limit: params.limit as number | undefined,
				source: params.source as string | undefined,
			};
			try {
				const { text: body, report } = await readLeaks(db, q);
				return text(body, report);
			} catch (err) {
				return text(`prospect leaks: ${err instanceof Error ? err.message : String(err)}`, {});
			}
		}
		case "search": {
		if (!params.query) return text(`query required. ${searchSyntaxHelp()}`, {});
		const q: SearchQuery = {
			query: params.query as string,
			kind: (params.kind as SearchQuery["kind"]) ?? "all",
			limit: params.limit as number | undefined,
			source: parseHarnessSource(params.source as string | undefined),
		};
		try {
			const { text: body, report } = await readSearch(db, q);
			return text(body, report);
		} catch (err) {
			return text(`prospect search: ${err instanceof Error ? err.message : String(err)}`, {});
		}
	}
	case "session_summary": {
		const sessionId = params.session_id as string | undefined;
		if (!sessionId) return text("session_id required (use list_proposals or nodes to find one)", {});
		try {
			const result = await readSessionSummary(db, sessionId);
			return text(result.text, { node: serialiseNodeSummary(result.node) });
		} catch (err) {
			return text(`prospect show --session: ${err instanceof Error ? err.message : String(err)}`, {});
		}
	}
	case "help": {
				return text(`=== prospect tool ===

Workflow:
  1. sync   — index new sessions from disk; scope with { project } and/or { source } to skip every other project on disk (the fresh-install escape hatch)
  2. analyze — run the analyzer framework over sessions; a frugal plain fill by default, { revise: ["config"] } recomputes stale nodes,
      { all: true } back-fills every session, { analyzer } restricts to one analyzer, { recent }/ { limit }/ { session_id }/ { source } scope the run
  3. stats  — see proposal counts, token ratios, analysis depth
  4. list_proposals [status] [severity] [limit] [offset] — ranked by confidence
      (add { session_id } to scope to one session; --as-of <ts|7d> / --as-of-run <id> for a point-in-time view)
  5. accept/reject — decide proposals singly or in bulk (proposal_ids array)
  6. remediate — accept many proposals under one shared remediation record

Analysis-graph & point-in-time commands (slash commands):
  - prospect tool actions: nodes (--analyzer <id> | all=true, node_kind, filter[], counts, latest_per_key, all_versions, limit, offset) and node (output_key) — read analyzer output from the surface
  - /prospect-nodes --analyzer <id> [--node-kind <k>] [--filter k=v]... [--counts <prop>] [--latest-per-key <prop>] [--all-versions] [--limit n] [--offset n]
  - /prospect-node <output-key> — one node + resolved outgoing edges (consumes/anchors/produces/revises)
  - /prospect-show <proposal-id> — a proposal + the verbatim turns it was synthesised from
  - /prospect-show --session <id> — the session summary + its evidence (consumed turns, produced proposals, contrast siblings)
  - prospect tool action leaks / /prospect-leaks [--severity <critical|high|medium>] [--limit n] [--source pi|claude] — which sessions contain detected secrets, per finding: rule, redacted preview, fingerprint, message anchor
  - prospect tool action search / /prospect-search <query> [--kind all|messages|proposals] [--limit n] [--source pi|claude] — FTS5 content search over proposals and the session corpus: record kind, id, session, highlighted snippet, bm25 ranking; query syntax: plain terms (implicit AND), "quoted phrases", prefix term*, OR / NOT / AND, NEAR(a b, n), column:term (messages: content_text, content_thinking; proposals: title, summary, detail, evidence)
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
		await db.close();
	}
}
