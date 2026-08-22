import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { getProposal, listProposals, getSessionLabels, getLatestDecision } from "../db/queries.js";
import { getNode, getNodeByOutputKey, getEdgesFrom, getAnchoredMessageIds, getSessionNodes, getSessionMessageRows, getLatestSummaryNode } from "../db/analysis-queries.js";
import { EDGE_KINDS, REF_KINDS } from "../analyze/edge-kinds.js";
import { buildTurnPairs, type TurnPair } from "../analyze/analyzers/turn-pair-core/build.js";
import { sessionLabel, formatDecisionLine } from "./proposals.js";
import { getDbPath } from "../config.js";
import type { Proposal } from "../types.js";
import type { AnalysisNodeRow, MessageRow } from "../analyze/types.js";

function out(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/** Resolve a proposal by exact id or unambiguous id-prefix. */
export async function resolveProposal(db: AsyncDatabase, ref: string): Promise<{ proposal?: Proposal; matches: Proposal[] }> {
	const exact = await getProposal(db, ref);
	if (exact) return { proposal: exact, matches: [exact] };
	const matches = (await listProposals(db)).filter((p) => p.id.startsWith(ref));
	return { proposal: matches.length === 1 ? matches[0] : undefined, matches };
}

function truncate(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Build the warning shown when an id prefix matches more than one proposal.
 * Same-run proposal ids are uuidv7 values that share a long timestamp prefix, so
 * an 8-char prefix is rarely unique. We show, per match, the shortest id prefix
 * that is distinct across the matches plus the title — a fragment the user can
 * copy straight back into `prospect show`.
 */
export function formatAmbiguousMatches(ref: string, matches: Array<{ id: string; title: string }>): string {
	const ordered = [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const full = ordered.reduce((m, x) => Math.max(m, x.id.length), 0);
	// Grow the prefix until every match's prefix is distinct (so it resolves uniquely).
	let len = Math.max(ref.length + 1, 1);
	while (len < full && new Set(ordered.map((m) => m.id.slice(0, len))).size < ordered.length) len++;
	const rows = ordered.map((m) => {
		const prefix = m.id.slice(0, len);
		return `  ${prefix}${len < m.id.length ? "…" : ""}  ${m.title}`;
	});
	return [`"${ref}" matches ${ordered.length} proposals — copy a longer id:`, ...rows].join("\n");
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

function short(s: string, n = 8): string {
	return s.length > n ? s.slice(0, n) : s;
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

/**
 * Per-turn deterministic + LLM signals for a session, keyed by anchoring user
 * message. Shared by the proposal walk (`prospect show <id>`) and the session
 * walk (`prospect show --session <id>`) so both annotate turns identically.
 */
export async function collectTurnSignals(
	db: AsyncDatabase,
	sessionId: string,
): Promise<{ coreByUser: Map<string, Record<string, unknown>>; llmByUser: Map<string, Record<string, unknown>> }> {
	const coreByUser = new Map<string, Record<string, unknown>>();
	const llmByUser = new Map<string, Record<string, unknown>>();
	for (const n of await getSessionNodes(db, sessionId)) {
		if (n.analyzer_id === "turn-pair-core") {
			const c = safeParse(n.content_json);
			if (typeof c["user_message_id"] === "string") coreByUser.set(c["user_message_id"] as string, c);
		} else if (n.analyzer_id === "turn-pair-llm") {
			const c = safeParse(n.content_json);
			if (typeof c["user_message_id"] === "string") llmByUser.set(c["user_message_id"] as string, c);
		}
	}
	return { coreByUser, llmByUser };
}

export async function prospectShow(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const toks = args.trim().split(/\s+/).filter((t) => t.length > 0);
	if (toks[0] === "--session") {
		const sessionId = toks[1] ?? "";
		if (!sessionId) {
			out(ctx, showUsage(), "warning");
			return;
		}
		const db = openAsyncDatabase(getDbPath());
		await migrate(db);
		try {
			try {
				out(ctx, (await readSessionSummary(db, sessionId)).text);
			} catch (err) {
				out(ctx, `prospect show --session: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		} finally {
			await db.close();
		}
		return;
	}
	if (toks[0]?.startsWith("--")) {
		out(ctx, `Unknown flag: ${toks[0]}\n${showUsage()}`, "warning");
		return;
	}
	const ref = toks[0] ?? "";
	if (!ref) {
		out(ctx, showUsage(), "warning");
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const { proposal, matches } = await resolveProposal(db, ref);
		if (!proposal) {
			if (matches.length === 0) out(ctx, `No proposal matches "${ref}".`, "warning");
			else out(ctx, formatAmbiguousMatches(ref, matches), "warning");
			return;
		}

		const labels = new Map((await getSessionLabels(db)).map((s) => [s.id, s]));
		const label = sessionLabel(labels.get(proposal.session_id), proposal.session_id);
		const conf = proposal.confidence == null ? "n/a" : `${Math.round(proposal.confidence * 100)}%`;
		const decision = await getLatestDecision(db, proposal.input_key);

		const head = [
			`Proposal ${proposal.id.slice(0, 8)}  [${conf}] ${proposal.severity}  (${proposal.status})`,
			`  target:   ${proposal.target_path ? `${proposal.target_type} :: ${proposal.target_path}` : proposal.target_type}`,
			`  title:    ${proposal.title}`,
			`  summary:  ${proposal.summary}`,
			proposal.detail ? `  detail:   ${proposal.detail}` : "",
			proposal.evidence ? `  evidence: ${proposal.evidence}` : "",
			`  session:  ${proposal.session_id.slice(0, 8)} · ${label}`,
			proposal.source_node_id ? `  source:   node ${proposal.source_node_id.slice(0, 8)} (${proposal.analyzer_id ?? "?"})` : "",
			decision ? `  ${formatDecisionLine(decision)}` : "",
		].filter(Boolean);
		out(ctx, head.join("\n"));

		const sourceId = proposal.source_node_id;
		if (!sourceId || !(await getNode(db, sourceId))) {
			out(ctx, "\n(No source node recorded — cannot reconstruct anchored turns.)", "warning");
			return;
		}

		// Walk provenance: summary --consumes--> turn nodes --anchors--> messages.
		const consumed = (await getEdgesFrom(db, sourceId)).filter(
			(e) => e.edge_kind === EDGE_KINDS.CONSUMES && e.to_ref_kind === REF_KINDS.ANALYSIS_NODE,
		);
		const anchorIds = new Set<string>();
		// `consumes` edges reference the turn node's content-addressed output_key; resolve
		// it back to the node to walk its `anchors` edges to messages.
		for (const edge of consumed) {
			const turnNode = await getNodeByOutputKey(db, edge.to_ref_id);
			if (!turnNode) continue;
			for (const mid of await getAnchoredMessageIds(db, turnNode.id)) anchorIds.add(mid);
		}

		if (anchorIds.size === 0) {
			out(ctx, "\n(Source node consumed no turn-anchored evidence.)", "warning");
			return;
		}

		// Per-turn deterministic + LLM signals, keyed by anchoring user message.
		const { coreByUser, llmByUser } = await collectTurnSignals(db, proposal.session_id);

		// The overview consumes EVERY turn; focus review on the turns that actually
		// carry friction (high-signal core metric, or an LLM classification).
		const signalIds = new Set(
			[...anchorIds].filter((id) => Boolean(coreByUser.get(id)?.["high_signal"]) || llmByUser.has(id)),
		);
		const renderIds = signalIds.size > 0 ? signalIds : anchorIds;

		const messages = await getSessionMessageRows(db, proposal.session_id);
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
		await db.close();
	}
}

/** The usage line for both modes of `prospect show`. */
export function showUsage(): string {
	return "Usage: prospect show <proposal-id>\n       prospect show --session <session-id>";
}

/**
 * The session-level evidence walk (issue #105): the existing session-overview
 * summary node, rendered for a reader, with its typed edges resolved — the same
 * walk-back `prospect show <proposal-id>` performs, generalised to the session
 * that produced the proposals. A reporting surface only: it reads the graph and
 * writes nothing, analyses nothing new, and calls no model.
 *
 * Evidence attached:
 * - `consumes` → the turn nodes behind the summary, each walked to its
 *   `anchors` messages and rendered verbatim (high-signal turns first, since
 *   the overview consumes every turn);
 * - `produces` → the proposals materialised from this summary;
 * - `contrasts_with` → the smooth sibling sessions used as negative examples.
 */
export async function readSessionSummary(
	db: AsyncDatabase,
	sessionId: string,
	opts: { maxTurns?: number } = {},
): Promise<{ text: string; node: AnalysisNodeRow }> {
	const trimmed = sessionId.trim();
	if (!trimmed) throw new Error(showUsage());
	const node = await getLatestSummaryNode(db, trimmed);
	if (!node) {
		throw new Error(`No session summary found for '${trimmed}' — run analyze first (the session-overview analyzer produces it).`);
	}

	let content: Record<string, unknown>;
	try {
		content = JSON.parse(node.content_json) as Record<string, unknown>;
	} catch {
		content = {};
	}

	const head = [
		`Session summary ${short(node.output_key, 12)}  (${node.analyzer_id})`,
		`  session:  ${node.session_id}`,
		`  created:  ${node.created_at}`,
		node.model_used ? `  model:    ${node.model_used}` : "",
	].filter(Boolean);
	const lines = [...head, ...formatSummaryContent(content)];

	// What this summary yielded: the proposals materialised from it.
	const producedIds = (await getEdgesFrom(db, node.id))
		.filter((e) => e.edge_kind === EDGE_KINDS.PRODUCES && e.to_ref_kind === REF_KINDS.PROPOSAL)
		.map((e) => e.to_ref_id);
	if (producedIds.length > 0) {
		lines.push("", `Proposals from this summary (${producedIds.length}) — see prospect show <id> for each one's own evidence:`);
		for (const pid of producedIds) {
			const p = await getProposal(db, pid);
			lines.push(`  ${pid.slice(0, 8)}  [${p?.severity ?? "?"}] ${p ? p.title : "(proposal no longer present)"}`);
		}
	}

	// Cross-session contrast provenance: the smooth sibling sessions this
	// synthesis was handed as negative examples.
	const contrastSessions = (await getEdgesFrom(db, node.id))
		.filter((e) => e.edge_kind === EDGE_KINDS.CONTRASTS_WITH && e.to_ref_kind === REF_KINDS.SESSION)
		.map((e) => e.to_ref_id);
	if (contrastSessions.length > 0) {
		lines.push("", `Cross-session contrast (${contrastSessions.length} smooth sibling session(s) used as negative examples):`);
		for (const sid of contrastSessions) lines.push(`  ${sid.slice(0, 12)}`);
	}

	// Evidence walk-back: summary --consumes--> turn nodes --anchors--> messages.
	const consumed = (await getEdgesFrom(db, node.id)).filter(
		(e) => e.edge_kind === EDGE_KINDS.CONSUMES && e.to_ref_kind === REF_KINDS.ANALYSIS_NODE,
	);
	const anchorIds = new Set<string>();
	// `consumes` edges reference the turn node's content-addressed output_key; resolve
	// it back to the node to walk its `anchors` edges to messages.
	for (const edge of consumed) {
		const turnNode = await getNodeByOutputKey(db, edge.to_ref_id);
		if (!turnNode) continue;
		for (const mid of await getAnchoredMessageIds(db, turnNode.id)) anchorIds.add(mid);
	}

	if (anchorIds.size === 0) {
		lines.push("", "(The summary consumed no turn-anchored evidence.)");
		return { text: lines.join("\n"), node };
	}

	const { coreByUser, llmByUser } = await collectTurnSignals(db, trimmed);
	// The overview consumes EVERY turn; focus review on the turns that actually
	// carry friction (high-signal core metric, or an LLM classification).
	const signalIds = new Set([...anchorIds].filter((id) => Boolean(coreByUser.get(id)?.["high_signal"]) || llmByUser.has(id)));
	const renderIds = signalIds.size > 0 ? signalIds : anchorIds;

	const messages = await getSessionMessageRows(db, trimmed);
	const byId = new Map(messages.map((m) => [m.id, m]));
	const pairs = buildTurnPairs(messages);

	const noun = signalIds.size > 0 ? "high-signal" : "consumed";
	lines.push(
		"",
		`Anchored turns — ${renderIds.size} ${noun} turn(s) of ${anchorIds.size} consumed, the evidence this summary was synthesised from:\n`,
	);
	lines.push(...renderAnchoredTurns(pairs, byId, renderIds, coreByUser, llmByUser, opts.maxTurns ?? 15));
	return { text: lines.join("\n"), node };
}

/**
 * Render the summary node's content — the synthesis itself — as readable
 * lines. Pure over its argument so the format is unit-testable without a DB.
 */
export function formatSummaryContent(content: Record<string, unknown>): string[] {
	const lines: string[] = [];
	const summary = typeof content["session_summary"] === "string" ? (content["session_summary"] as string).trim() : "";
	lines.push("  what happened:");
	lines.push(indent(truncate(summary || "(no summary text recorded)", 2000)));

	const friction = Array.isArray(content["friction_points"]) ? (content["friction_points"] as Array<Record<string, unknown>>) : [];
	lines.push("", `Friction (${friction.length}):`);
	if (friction.length === 0) lines.push("  (none enumerated)");
	for (const f of friction) {
		const description = typeof f["description"] === "string" ? f["description"] : "(undescribed)";
		const change = typeof f["what_to_change"] === "string" ? f["what_to_change"] : "";
		const evidence = typeof f["evidence"] === "string" ? f["evidence"] : "";
		const severity = typeof f["severity"] === "string" ? f["severity"] : "?";
		lines.push(`  • [${severity}] ${truncate(description.replace(/\s+/g, " "), 300)}`);
		if (change) lines.push(`    change: ${truncate(change.replace(/\s+/g, " "), 300)}`);
		if (evidence) lines.push(`    evidence: ${truncate(evidence.replace(/\s+/g, " "), 300)}`);
	}

	const positive = Array.isArray(content["key_positive_signals"]) ? (content["key_positive_signals"] as Array<Record<string, unknown>>) : [];
	lines.push("", `What went well (${positive.length}):`);
	if (positive.length === 0) lines.push("  (none recorded)");
	for (const s of positive) {
		const description = typeof s["description"] === "string" ? s["description"] : "(undescribed)";
		const signal = typeof s["signal"] === "string" ? s["signal"] : "";
		lines.push(`  • ${truncate(description.replace(/\s+/g, " "), 300)}${signal ? ` (${signal})` : ""}`);
	}

	const stats = content["stats"];
	if (stats && typeof stats === "object" && !Array.isArray(stats)) {
		const parts = Object.entries(stats as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === "number" ? v : JSON.stringify(v)}`);
		lines.push("", `Stats: ${parts.join(" ")}`);
	}
	return lines;
}

export function registerShowCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-show", {
		description:
			"Show a proposal with the verbatim anchored turns (user/assistant text + tool calls) it was synthesised from, " +
			"or --session <id> for the session-level summary with its evidence (consumed turns, produced proposals, contrast siblings).",
		handler: prospectShow,
	});
}
