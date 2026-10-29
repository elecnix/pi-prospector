/**
 * `prospect nodes` / `prospect node` — read analyzer output from the surface,
 * with edge navigation (issue #154).
 *
 * The graph is append-only and typed; reading it should not require SQL. Every
 * analyzer's nodes (turn metrics, lexicon verdicts, trajectory signals, secret
 * hits…) are reachable here:
 *
 *   prospect nodes --analyzer frustration-lexicon
 *   prospect nodes --analyzer turn-pair-core --node-kind metric --filter high_signal=true
 *   prospect nodes --analyzer frustration-lexicon --counts category
 *   prospect nodes --analyzer frustration-lexicon --latest-per-key term
 *   prospect node <output-key>          — one node + its resolved outgoing edges
 *
 * Typed `--filter key=value` uses the analyzer's declared `outputSchema`
 * (see `prospect analyzers list --schema <id>`); when an analyzer declares no
 * schema — or is not registered locally — filters fall back to best-effort
 * comparison over `content_json`.
 *
 * One deliberate scope decision (issue #154): no analyzer-specific commands.
 * The lexicon reading case ("newest verdict per term") is covered generically
 * by `--latest-per-key <property>`.
 */

import type { ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import {
	countAnalysisNodes,
	getEdgesFrom,
	getMessage,
	getNode,
	getNodeByOutputKey,
	getNodesByOutputKeyPrefix,
	listAnalysisNodes,
	type NodeListFilter,
} from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";
import { parseTimestamp, resolveTimepoint } from "../timepoint.js";
import { findAnalyzerDef } from "./analyzers.js";
import { NodeKind } from "../analyze/types.js";
import { contentMatchesFilters, parseFilterSpec, stableStringify } from "../analyze/content-filter.js";
import { pricedHits } from "../analyze/hit-reading.js";
import { TURN_FRUSTRATION_DEF } from "../analyze/analyzers/turn-frustration/index.js";
import type { AnalysisEdgeRow, AnalysisNodeRow, AnalyzerDef, MessageRow } from "../analyze/types.js";

// ─────────────────────────── argument parsing ───────────────────────────

/** Parsed `prospect nodes` arguments. */
export interface NodesQuery {
	analyzerId?: string;
	all?: boolean;
	nodeKind?: string;
	/** Raw `key=value` filter specs, repeatable. */
	filters: string[];
	counts?: string;
	latestPerKey?: string;
	limit?: number;
	offset?: number;
	sessionId?: string;
	asOf?: string;
	asOfRun?: string;
	/** Include superseded generations (#260); the default reads the current generation only. */
	allVersions?: boolean;
}

const NODE_FLAGS = [
	"--analyzer <id>", "--all", "--node-kind <kind>", "--filter key=value (repeatable)",
	"--counts <property>", "--latest-per-key <property>", "--limit <n>", "--offset <n>",
	"--session <id>", "--as-of <ts|7d>", "--as-of-run <id>", "--all-versions",
];

/** The usage line for `prospect nodes`. */
export function nodesUsage(): string {
	return `Usage: prospect nodes (--analyzer <id> | --all) [flags]\n  ${NODE_FLAGS.join(" ")}`;
}

/**
 * Parse `prospect nodes` arguments. Unlike the shared timepoint parser this
 * accepts repeated `--filter` flags, so it tokenises directly rather than via
 * `parseFlags` (which keeps only the last occurrence of a flag). Throws an
 * Error with a user-facing message on malformed input.
 */
export function parseNodeArgs(args: string): NodesQuery {
	const toks = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
	const q: NodesQuery = { filters: [] };
	for (let i = 0; i < toks.length; i++) {
		let tok = toks[i]!;
		let inline: string | undefined;
		const eq = tok.indexOf("=");
		if (tok.startsWith("--") && eq > 2) {
			inline = tok.slice(eq + 1);
			tok = tok.slice(0, eq);
		}
		const val = (): string => {
			if (inline !== undefined) return inline;
			const next = toks[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`flag ${tok} needs a value`);
			i++;
			return next;
		};
		switch (tok) {
			case "--analyzer":
				q.analyzerId = val();
				break;
			case "--all":
				q.all = true;
				break;
			case "--node-kind":
				q.nodeKind = val();
				break;
			case "--filter":
				q.filters.push(val());
				break;
			case "--counts":
				q.counts = val();
				break;
			case "--latest-per-key":
				q.latestPerKey = val();
				break;
			case "--limit": {
				const n = Number(val());
				if (!Number.isInteger(n) || n < 0) throw new Error("--limit needs a non-negative integer");
				q.limit = n;
				break;
			}
			case "--offset": {
				const n = Number(val());
				if (!Number.isInteger(n) || n < 0) throw new Error("--offset needs a non-negative integer");
				q.offset = n;
				break;
			}
			case "--session":
				q.sessionId = val();
				break;
			case "--as-of":
				q.asOf = val();
				break;
			case "--as-of-run":
				q.asOfRun = val();
				break;
			case "--all-versions":
				q.allVersions = true;
				break;
			default:
				throw new Error(`unknown flag or stray argument: "${tok}"`);
		}
	}
	return q;
}

// ─────────────────────────── aggregation ───────────────────────────

function parseContent(row: AnalysisNodeRow): Record<string, unknown> {
	try {
		return JSON.parse(row.content_json) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Group counts over one top-level content property. Values absent from a
 * node's content are counted under `(no <prop>)` rather than skipped — a
 * silent drop would misstate the denominator.
 */
export function countsByProp(rows: AnalysisNodeRow[], prop: string): Array<{ value: string; count: number }> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const v = parseContent(row)[prop];
		const key = v === undefined ? `(no ${prop})` : typeof v === "string" ? v : stableStringify(v) ?? String(v);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Keep, per distinct value of one content property, only the newest node —
 * the generic form of "newest verdict per term". Nodes lacking the property
 * cannot be grouped and are reported separately, never silently dropped.
 */
export function latestPerKey(rows: AnalysisNodeRow[], prop: string): { kept: AnalysisNodeRow[]; dropped: number } {
	const newest = new Map<string, AnalysisNodeRow>();
	let dropped = 0;
	for (const row of rows) {
		const v = parseContent(row)[prop];
		if (v === undefined) {
			dropped++;
			continue;
		}
		const key = typeof v === "string" ? v : stableStringify(v) ?? String(v);
		const cur = newest.get(key);
		if (!cur || row.created_at > cur.created_at || (row.created_at === cur.created_at && row.output_key > cur.output_key)) {
			newest.set(key, row);
		}
	}
	return { kept: [...newest.values()], dropped };
}

// ─────────────────────────── formatting ───────────────────────────

function short(s: string, n = 8): string {
	return s.length > n ? s.slice(0, n) : s;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A compact `k=v k=v` digest of a node's content, scalars first. */
export function summarizeContent(contentJson: string, maxProps = 4): string {
	let content: Record<string, unknown>;
	try {
		content = JSON.parse(contentJson) as Record<string, unknown>;
	} catch {
		return "(unparseable content)";
	}
	const parts: string[] = [];
	for (const [k, v] of Object.entries(content)) {
		if (parts.length >= maxProps) break;
		if (v === null) parts.push(`${k}=null`);
		else if (typeof v === "string") parts.push(`${k}=${truncate(v.replace(/\s+/g, " "), 40)}`);
		else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
		else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
		else parts.push(`${k}=${truncate(JSON.stringify(v), 60)}`);
	}
	return parts.join(" ");
}

const NODE_KIND_VALUES: readonly string[] =
	(NodeKind as { anyOf?: Array<{ const?: string }> }).anyOf?.map((o) => o.const ?? "").filter(Boolean) ??
	["metric", "classification", "summary", "proposal", "validation", "restatement", "error"];

function assertValidNodeKind(kind: string): void {
	if (!NODE_KIND_VALUES.includes(kind)) {
		throw new Error(`unknown --node-kind '${kind}' (valid: ${NODE_KIND_VALUES.join(", ")})`);
	}
}

/** One listing line per node. */
export function formatNodeLine(row: AnalysisNodeRow): string {
	return `  ${short(row.output_key, 12)}  ${row.node_kind.padEnd(15)}  ${short(row.session_id)}  ${row.created_at}  ${summarizeContent(row.content_json)}`;
}

// ─────────────────────────── surface reads ───────────────────────────

/** Hard cap on rows pulled before in-memory filtering/paging — the read path is bounded, not unbounded. */
const MAX_SCAN = 10_000;

export interface NodesReadResult {
	text: string;
	rows: AnalysisNodeRow[];
	total: number;
}

/**
 * The shared core of `prospect nodes` for the slash command and the tool
 * action. Reads only — nothing is written, and no dependency is declared
 * (outputs are exempt from the dependency rule; see DESIGN.md).
 */
export async function readNodes(db: AsyncDatabase, q: NodesQuery): Promise<NodesReadResult> {
	if (!q.analyzerId && !q.all) throw new Error(nodesUsage());
	if (q.analyzerId && q.all) throw new Error("use either --analyzer <id> or --all, not both");
	if (q.nodeKind) assertValidNodeKind(q.nodeKind);

	const asOf = q.asOf || q.asOfRun ? (await resolveTimepoint(db, { "as-of": q.asOf ?? "", "as-of-run": q.asOfRun ?? "" }))?.at : undefined;
	const filter: NodeListFilter = {
		analyzerId: q.analyzerId,
		nodeKind: q.nodeKind,
		sessionId: q.sessionId,
		asOf,
		allVersions: q.allVersions,
		limit: MAX_SCAN,
	};
	const totalBeforeFilters = await countAnalysisNodes(db, filter);
	let rows = await listAnalysisNodes(db, filter);

	// A frustration hit that no reader counts must not appear in the listing or in
	// a count over one: the operator muted that term, or the corpus carries it in so
	// many turns that it cannot distinguish one from another. The hit nodes stay in
	// the graph as lineage; this is a read filter, not a retraction.
	//
	// The listing asks for the graph's lineage, so it keeps the error nodes, and it
	// keeps every generation when `--all-versions` asked for them. It still prices,
	// because a background word is not lineage anyone asked to see.
	//
	// An as-of read is left alone: it reconstructs the graph as it stood at a past
	// instant, and both the mute set and the corpus's document share belong to *now*.
	if (!asOf) {
		// The rows are filtered in place, so the listing keeps the order the query
		// returned (newest first).
		const isFrustration = (row: AnalysisNodeRow): boolean => row.analyzer_id === TURN_FRUSTRATION_DEF.id;
		const frustrationRows = rows.filter(isFrustration);
		const keptIds = new Set(
			(await pricedHits(db, frustrationRows, {
				keepGenerations: q.allVersions,
				keepErrorNodes: true,
			})).map((row) => row.id),
		);
		rows = rows.filter((row) => !isFrustration(row) || keptIds.has(row.id));
	}

	// Typed filters over the analyzer's declared outputSchema; best-effort when
	// the analyzer declares none or is not registered locally.
	const filters = q.filters.map((spec) => parseFilterSpec(spec));
	let def: AnalyzerDef | undefined;
	let schemaNote = "";
	if (q.analyzerId) {
		def = await findAnalyzerDef(q.analyzerId);
		if (!def) schemaNote = ` (analyzer '${q.analyzerId}' not registered locally — filters applied best-effort)`;
	}
	if (filters.length > 0) rows = rows.filter((r) => contentMatchesFilters(parseContent(r), filters, def));

	let notes: string[] = [];
	if (q.latestPerKey) {
		const { kept, dropped } = latestPerKey(rows, q.latestPerKey);
		rows = kept;
		if (dropped > 0) notes.push(`${dropped} node(s) lack '${q.latestPerKey}' and cannot be grouped — excluded.`);
	}

	const totalMatching = rows.length;
	const offset = q.offset ?? 0;
	const limit = q.limit ?? 100;
	const paged = rows.slice(offset, offset + limit);

	const headerParts = [
		q.analyzerId ? `analyzer=${q.analyzerId}` : "all analyzers",
		q.nodeKind ? `kind=${q.nodeKind}` : "",
		q.sessionId ? `session=${q.sessionId}` : "",
		filters.length > 0 ? `filters: ${q.filters.join(" ")}` : "",
		asOf ? `as of ${asOf}` : "",
		q.allVersions ? "all versions" : "",
	].filter(Boolean);
	const lines: string[] = [];
	lines.push(
		`Nodes — ${headerParts.join(" ")}${schemaNote}: ${paged.length} shown of ${totalMatching} matching (${totalBeforeFilters} ${q.allVersions ? "live" : "current"} before filters).`,
	);
	for (const row of paged) lines.push(formatNodeLine(row));
	if (totalMatching > offset + paged.length) {
		lines.push(`  … ${totalMatching - offset - paged.length} more (use --offset ${offset + paged.length})`);
	}
	if (q.counts) {
		lines.push("");
		lines.push(`Counts by '${q.counts}' over all ${totalMatching} matching node(s):`);
		for (const { value, count } of countsByProp(rows, q.counts)) lines.push(`  ${value}: ${count}`);
	}
	if (notes.length > 0) lines.push("", ...notes.map((n) => `note: ${n}`));
	return { text: lines.join("\n"), rows: paged, total: totalMatching };
}

// ─────────────────────────── single-node detail ───────────────────────────

function describeMessage(id: string, m: MessageRow | undefined): string {
	if (!m) return `${id} (unresolved)`;
	const text = m.content_text ? truncate(m.content_text.replace(/\s+/g, " "), 160) : "(no text)";
	return `${id} [${m.role}] ${text}`;
}

/** Resolve one edge to a human-readable line, walking node refs to their targets. */
async function describeEdge(db: AsyncDatabase, edge: AnalysisEdgeRow): Promise<string> {
	const pad = (s: string) => s.padEnd(13);
	if (edge.to_ref_kind === "analysis_node") {
		const target = (await getNodeByOutputKey(db, edge.to_ref_id)) ?? (await getNode(db, edge.to_ref_id));
		if (target) {
			return `${pad(edge.edge_kind)}→ node ${short(target.output_key, 12)} (${target.analyzer_id}, ${target.node_kind})  ${summarizeContent(target.content_json, 3)}`;
		}
		return `${pad(edge.edge_kind)}→ node ${edge.to_ref_id} (unresolved)`;
	}
	if (edge.to_ref_kind === "message") {
		return `${pad(edge.edge_kind)}→ message ${describeMessage(edge.to_ref_id, await getMessage(db, edge.to_ref_id))}`;
	}
	return `${pad(edge.edge_kind)}→ ${edge.to_ref_kind} ${edge.to_ref_id}`;
}

export interface NodeDetailResult {
	text: string;
	node: AnalysisNodeRow;
}

/**
 * The shared core of `prospect node <ref>`: one node's detail with its
 * outgoing edges resolved to their target nodes and messages — the walk
 * `prospect show` performs for a proposal, available for any node.
 */
export async function readNodeDetail(db: AsyncDatabase, ref: string): Promise<NodeDetailResult> {
	const trimmed = ref.trim();
	if (!trimmed) throw new Error("Usage: prospect node <output-key>");
	const node = await resolveNode(db, trimmed);
	const head = [
		`Node ${node.output_key}`,
		`  kind:       ${node.node_kind}`,
		`  analyzer:   ${node.analyzer_id}`,
		`  session:    ${node.session_id}`,
		`  created:    ${node.created_at}`,
		`  input_key:  ${short(node.input_key, 16)}`,
		node.model_used ? `  model:      ${node.model_used}` : "",
		node.cost_usd != null ? `  cost:       $${node.cost_usd}` : "",
		node.tokens_used != null ? `  tokens:     ${node.tokens_used}` : "",
		node.duration_ms != null ? `  duration:   ${node.duration_ms}ms` : "",
	].filter(Boolean);

	let content: unknown;
	try {
		content = JSON.parse(node.content_json) as unknown;
	} catch {
		content = node.content_json;
	}
	const lines = [...head, "  content:", indent(truncate(JSON.stringify(content, null, 2), 4000))];

	const edges = await getEdgesFrom(db, node.id);
	if (edges.length === 0) {
		lines.push("", "(no outgoing edges — this node consumed nothing and produced nothing yet)");
	} else {
		lines.push("", `Outgoing edges (${edges.length}):`);
		for (const edge of edges) lines.push(`  ${await describeEdge(db, edge)}`);
	}
	return { text: lines.join("\n"), node };
}

/** Resolve a node by exact output_key, then output-key prefix, then node id. */
async function resolveNode(db: AsyncDatabase, ref: string): Promise<AnalysisNodeRow> {
	const exact = await getNodeByOutputKey(db, ref);
	if (exact) return exact;
	const byPrefix = await getNodesByOutputKeyPrefix(db, ref);
	if (byPrefix.length === 1) return byPrefix[0]!;
	if (byPrefix.length > 1) {
		throw new Error(
			`'${ref}' matches ${byPrefix.length} nodes by output-key prefix — copy a longer prefix:\n` +
				byPrefix.slice(0, 10).map((n) => `  ${short(n.output_key, 16)}  ${n.analyzer_id} ${n.node_kind}`).join("\n"),
		);
	}
	const byId = await getNode(db, ref);
	if (byId) return byId;
	throw new Error(`No node matches '${ref}' (tried output-key, output-key prefix, node id).`);
}

function indent(s: string): string {
	return s
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
}

// ─────────────────────────── command surfaces ───────────────────────────

function out(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/** `/prospect-nodes` — list analyzer nodes from the surface. */
export async function prospectNodes(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		let q: NodesQuery;
		try {
			q = parseNodeArgs(rawArgs ?? "");
		} catch (err) {
			out(ctx, `${err instanceof Error ? err.message : String(err)}\n${nodesUsage()}`, "warning");
			return;
		}
		try {
			const result = await readNodes(db, q);
			out(ctx, result.text);
		} catch (err) {
			out(ctx, `prospect nodes: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	} finally {
		await db.close();
	}
}

/** `/prospect-node <output-key>` — one node's detail with resolved outgoing edges. */
export async function prospectNode(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		try {
			const result = await readNodeDetail(db, rawArgs ?? "");
			out(ctx, result.text);
		} catch (err) {
			out(ctx, `prospect node: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	} finally {
		await db.close();
	}
}
