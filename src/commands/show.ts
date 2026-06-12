import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getProposal, listProposals, getSessionLabels } from "../db/queries.js";
import { getNode, getEdgesFrom, getAnchoredMessageIds, getSessionNodes, getSessionMessageRows } from "../db/analysis-queries.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";
import { buildTurnPairs, type TurnPair } from "../analyze/analyzers/turn-pair-core/build.js";
import { sessionLabel } from "./proposals.js";
import { getDbPath } from "../config.js";
import type { Proposal } from "../types.js";
import type { MessageRow } from "../analyze/types.js";

function out(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/** Resolve a proposal by exact id or unambiguous id-prefix. */
export function resolveProposal(db: Database.Database, ref: string): { proposal?: Proposal; matches: Proposal[] } {
	const exact = getProposal(db, ref);
	if (exact) return { proposal: exact, matches: [exact] };
	const matches = listProposals(db).filter((p) => p.id.startsWith(ref));
	return { proposal: matches.length === 1 ? matches[0] : undefined, matches };
}

function truncate(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** A compact one-line preview of a tool call's most salient argument. */
export function toolCallPreview(name: string, args: Record<string, unknown>): string {
	const pick = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
	const salient = pick("command") ?? pick("cmd") ?? pick("path") ?? pick("file_path") ?? pick("pattern") ?? pick("url") ?? pick("query");
	const arg = salient ? truncate(salient.replace(/\s+/g, " "), 160) : truncate(JSON.stringify(args), 120);
	return `${name}  ${arg}`;
}

interface ToolCallRaw {
	name?: unknown;
	arguments?: unknown;
}

/** Render the verbatim turns whose user messages are in `anchorIds`, in pair order. */
export function renderAnchoredTurns(
	pairs: TurnPair[],
	byId: Map<string, MessageRow>,
	anchorIds: Set<string>,
	coreByUser: Map<string, Record<string, unknown>>,
	llmByUser: Map<string, Record<string, unknown>>,
	maxTurns = Infinity,
): string[] {
	const lines: string[] = [];
	const all = pairs.filter((p) => anchorIds.has(p.userMessageId)).sort((a, b) => a.index - b.index);
	const selected = all.slice(0, maxTurns);
	for (const pair of selected) {
		const core = coreByUser.get(pair.userMessageId);
		const llm = llmByUser.get(pair.userMessageId);
		const header = [
			`#${pair.index}`,
			core ? `friction=${Number(core["friction_score"] ?? 0).toFixed(2)}` : "",
			core && core["correction_detected"] ? `correction=${core["correction_type"]}` : "",
			core ? `tool_fail=${core["tool_failure_count"]}/${core["tool_call_count"]}` : "",
			llm ? `sentiment=${llm["sentiment"]} type=${llm["friction_type"]} sev=${llm["severity"]}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(`── pair ${header} ──`);
		lines.push("USER:");
		lines.push(indent(truncate(pair.userText || "(empty)", 1400)));

		// Reconstruct assistant text + tool calls (with args) from the turn's raw rows.
		const assistantText: string[] = [];
		const toolLines: string[] = [];
		const errorLines: string[] = [];
		for (const mid of pair.messageIds) {
			const row = byId.get(mid);
			if (!row) continue;
			if (row.role === "assistant") {
				if (row.content_text) assistantText.push(row.content_text);
				for (const call of parseToolCalls(row.tool_calls)) {
					const name = typeof call.name === "string" ? call.name : "?";
					const argObj = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
					toolLines.push(`  ${toolCallPreview(name, argObj)}`);
				}
			} else if (row.role === "toolResult" && isErrorResult(row.tool_results)) {
				errorLines.push(`  ✗ ${truncate(row.content_text ?? "(no output)", 200)}`);
			}
		}
		if (assistantText.length > 0) {
			lines.push("ASSISTANT:");
			lines.push(indent(truncate(assistantText.join("\n"), 900)));
		}
		if (toolLines.length > 0) {
			lines.push(`TOOLS (${toolLines.length}):`);
			lines.push(...toolLines.slice(0, 25));
			if (toolLines.length > 25) lines.push(`  …${toolLines.length - 25} more`);
		}
		if (errorLines.length > 0) {
			lines.push("TOOL ERRORS:");
			lines.push(...errorLines.slice(0, 8));
		}
		lines.push("");
	}
	if (all.length > selected.length) lines.push(`…${all.length - selected.length} more turn(s) not shown.`);
	return lines;
}

function indent(s: string): string {
	return s
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
}

function parseToolCalls(json: string | null): ToolCallRaw[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? (arr as ToolCallRaw[]) : [];
	} catch {
		return [];
	}
}

function isErrorResult(json: string | null): boolean {
	if (!json) return false;
	try {
		const arr = JSON.parse(json) as Array<{ isError?: unknown }>;
		return Array.isArray(arr) && arr.some((r) => Boolean(r.isError));
	} catch {
		return false;
	}
}

function safeParse(json: string): Record<string, unknown> {
	try {
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export async function prospectShow(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const ref = args.trim().split(/\s+/)[0] ?? "";
	if (!ref) {
		out(ctx, "Usage: prospect show <proposal-id>", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const { proposal, matches } = resolveProposal(db, ref);
		if (!proposal) {
			if (matches.length === 0) out(ctx, `No proposal matches "${ref}".`, "warning");
			else out(ctx, `"${ref}" is ambiguous (${matches.length} matches): ${matches.map((m) => m.id.slice(0, 8)).join(", ")}`, "warning");
			return;
		}

		const labels = new Map(getSessionLabels(db).map((s) => [s.id, s]));
		const label = sessionLabel(labels.get(proposal.session_id), proposal.session_id);
		const conf = proposal.confidence == null ? "n/a" : `${Math.round(proposal.confidence * 100)}%`;

		const head = [
			`Proposal ${proposal.id.slice(0, 8)}  [${conf}] ${proposal.severity}  (${proposal.status})`,
			`  target:   ${proposal.target_path ? `${proposal.target_type} :: ${proposal.target_path}` : proposal.target_type}`,
			`  title:    ${proposal.title}`,
			`  summary:  ${proposal.summary}`,
			proposal.detail ? `  detail:   ${proposal.detail}` : "",
			proposal.evidence ? `  evidence: ${proposal.evidence}` : "",
			`  session:  ${proposal.session_id.slice(0, 8)} · ${label}`,
			proposal.source_node_id ? `  source:   node ${proposal.source_node_id.slice(0, 8)} (${proposal.analyzer_id ?? "?"})` : "",
		].filter(Boolean);
		out(ctx, head.join("\n"));

		const sourceId = proposal.source_node_id;
		if (!sourceId || !getNode(db, sourceId)) {
			out(ctx, "\n(No source node recorded — cannot reconstruct anchored turns.)", "warning");
			return;
		}

		// Walk provenance: summary --consumes--> turn nodes --anchors--> messages.
		const consumed = getEdgesFrom(db, sourceId).filter(
			(e) => e.edge_kind === EDGE_KINDS.CONSUMES && e.to_ref_kind === REF_KINDS.ANALYSIS_NODE,
		);
		const anchorIds = new Set<string>();
		for (const edge of consumed) for (const mid of getAnchoredMessageIds(db, edge.to_ref_id)) anchorIds.add(mid);

		if (anchorIds.size === 0) {
			out(ctx, "\n(Source node consumed no turn-anchored evidence.)", "warning");
			return;
		}

		// Per-turn deterministic + LLM signals, keyed by anchoring user message.
		const coreByUser = new Map<string, Record<string, unknown>>();
		const llmByUser = new Map<string, Record<string, unknown>>();
		for (const n of getSessionNodes(db, proposal.session_id)) {
			if (n.analyzer_id === "turn-pair-core") {
				const c = safeParse(n.content_json);
				if (typeof c["user_message_id"] === "string") coreByUser.set(c["user_message_id"] as string, c);
			} else if (n.analyzer_id === "turn-pair-llm") {
				const c = safeParse(n.content_json);
				if (typeof c["user_message_id"] === "string") llmByUser.set(c["user_message_id"] as string, c);
			}
		}

		// The overview consumes EVERY turn; focus review on the turns that actually
		// carry friction (high-signal core metric, or an LLM classification).
		const signalIds = new Set(
			[...anchorIds].filter((id) => Boolean(coreByUser.get(id)?.["high_signal"]) || llmByUser.has(id)),
		);
		const renderIds = signalIds.size > 0 ? signalIds : anchorIds;

		const messages = getSessionMessageRows(db, proposal.session_id);
		const byId = new Map(messages.map((m) => [m.id, m]));
		const pairs = buildTurnPairs(messages);

		const noun = signalIds.size > 0 ? "high-signal" : "consumed";
		out(
			ctx,
			`\nAnchored turns — ${renderIds.size} ${noun} turn(s) of ${anchorIds.size} consumed, the evidence this proposal was synthesised from:\n`,
		);
		const body = renderAnchoredTurns(pairs, byId, renderIds, coreByUser, llmByUser, 15);
		out(ctx, body.join("\n"));
	} finally {
		db.close();
	}
}

export function registerShowCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-show", {
		description: "Show a proposal with the verbatim anchored turns (user/assistant text + tool calls) it was synthesised from.",
		handler: prospectShow,
	});
}
