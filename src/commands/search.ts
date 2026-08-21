/**
 * `prospect search` — content and pattern search over proposals and the
 * session corpus (issue #194).
 *
 * A read surface over the two FTS5 indexes (`messages_fts` over the session
 * corpus, `proposals_fts` over the proposal store — see
 * `src/db/search-queries.ts`). It answers "where does this text appear in my
 * corpus at all": every hit names its record kind, id, session, and a
 * snippet with the matched terms highlighted, ranked by bm25 across both
 * kinds, and links into the existing read surface — `prospect show` for
 * proposals and sessions, `prospect node` for analyzer output.
 *
 * Reporting surface only: reads the indexes, writes nothing, calls no model.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type, type Static } from "typebox";
import { migrate } from "../db/schema.js";
import { searchCorpus, type SearchKind, type SearchOptions, type SearchResult } from "../db/search-queries.js";
import { getDbPath } from "../config.js";

// ─────────────────────────── report shapes ───────────────────────────

export const MessageHit = Type.Object({
	kind: Type.Literal("message"),
	message_id: Type.String(),
	session_id: Type.String(),
	role: Type.String(),
	source: Type.String(),
	rank: Type.Number(),
	snippet: Type.String(),
	field: Type.Union([Type.Literal("content_text"), Type.Literal("content_thinking")]),
});
export type MessageHit = Static<typeof MessageHit>;

export const ProposalHit = Type.Object({
	kind: Type.Literal("proposal"),
	proposal_id: Type.String(),
	session_id: Type.String(),
	title: Type.String(),
	severity: Type.String(),
	status: Type.String(),
	analyzer_id: Type.Union([Type.String(), Type.Null()]),
	rank: Type.Number(),
	snippet: Type.String(),
	field: Type.Union([Type.Literal("title"), Type.Literal("summary"), Type.Literal("detail"), Type.Literal("evidence")]),
});
export type ProposalHit = Static<typeof ProposalHit>;

export const SearchHitSchema = Type.Union([MessageHit, ProposalHit]);
export type SearchHitShape = Static<typeof SearchHitSchema>;

export const SearchReport = Type.Object({
	query: Type.String(),
	hits: Type.Array(SearchHitSchema),
	message_matches: Type.Number(),
	proposal_matches: Type.Number(),
	omitted_by_limit: Type.Number(),
});
export type SearchReport = Static<typeof SearchReport>;

// ─────────────────────────── argument parsing ───────────────────────────

/** Parsed `prospect search` arguments. */
export interface SearchQuery {
	/** The FTS5 MATCH query, verbatim. */
	query: string;
	kind: SearchKind;
	limit?: number;
	source?: string;
}

const SEARCH_FLAGS = [
	"--kind all|messages|proposals",
	"--limit <n>",
	"--source pi|claude",
];

/** The usage line for `prospect search`. */
export function searchUsage(): string {
	return "Usage: prospect search <query> [--kind <all|messages|proposals>] [--limit <n>] [--source <pi|claude>]";
}

const KINDS: readonly string[] = ["all", "messages", "proposals"];
const SOURCES: readonly string[] = ["pi", "claude"];

/**
 * Parse `prospect search` arguments. Flags are stripped; every remaining
 * token is part of the FTS5 MATCH query, joined with spaces (so
 * `"context economy"* stays one argument). Throws an Error with a
 * user-facing message on malformed input.
 */
export function parseSearchArgs(args: string): SearchQuery {
	const toks = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
	const q: SearchQuery = { query: "", kind: "all" };
	const rest: string[] = [];
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i]!;
		const val = (): string => {
			const next = toks[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`flag ${tok} needs a value`);
			i++;
			return next;
		};
		switch (tok) {
			case "--kind": {
				const s = val();
				if (!KINDS.includes(s)) throw new Error(`unknown --kind '${s}' (valid: ${KINDS.join(", ")})`);
				q.kind = s as SearchKind;
				break;
			}
			case "--limit": {
				const n = Number(val());
				if (!Number.isInteger(n) || n <= 0) throw new Error("--limit needs a positive integer");
				q.limit = n;
				break;
			}
			case "--source": {
				const s = val();
				if (!SOURCES.includes(s)) throw new Error(`unknown --source '${s}' (valid: ${SOURCES.join(", ")})`);
				q.source = s;
				break;
			}
			default:
				rest.push(tok);
		}
	}
	q.query = rest.join(" ");
	if (q.query.length === 0) throw new Error(`a search query is required\n${searchUsage()}`);
	return q;
}

/** The supported query syntax, for help text. */
export function searchSyntaxHelp(): string {
	return (
		"Query syntax (FTS5 MATCH, passed through verbatim): plain terms (implicit AND), " +
		'"quoted phrases", prefix terms with * (e.g. lexicon*), boolean OR / NOT / AND, ' +
		"NEAR(a b, n), and column filters — messages index content_text and content_thinking; " +
		"proposals index title, summary, detail, evidence (e.g. title:secret)."
	);
}

// ─────────────────────────── rendering ───────────────────────────

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Render one message hit: id, session, role, source, highlighted snippet. */
export function formatMessageHit(h: MessageHit): string[] {
	return [
		`  • [message] ${h.message_id} · ${h.role} · ${h.source} · session ${h.session_id} · ${h.field}`,
		`      ${truncate(h.snippet.replace(/\s+/g, " "), 240)}`,
		`      → prospect show --session ${h.session_id}`,
	];
}

/** Render one proposal hit: id, title, severity/status, highlighted snippet. */
export function formatProposalHit(h: ProposalHit): string[] {
	return [
		`  • [proposal] ${h.proposal_id} · ${h.severity}/${h.status}${h.analyzer_id ? ` · ${h.analyzer_id}` : ""} · session ${h.session_id} · ${h.field}`,
		`      ${truncate(h.snippet.replace(/\s+/g, " "), 240)}`,
		`      → prospect show ${h.proposal_id}`,
	];
}

/** Render the full report as readable text. Pure over its arguments. */
export function renderSearch(report: SearchResult, opts: SearchOptions): string {
	const filters = [opts.kind && opts.kind !== "all" ? `kind ${opts.kind}` : undefined, opts.source ? `source ${opts.source}` : undefined]
		.filter(Boolean)
		.join(" ");
	const lines: string[] = [];
	if (report.hits.length === 0) {
		lines.push(`No matches for "${report.query}"${filters ? ` (${filters})` : ""}.`);
		lines.push(searchSyntaxHelp());
	} else {
		lines.push(
			`Search "${report.query}"${filters ? ` (${filters})` : ""} — ${report.hits.length} hit(s) ` +
				`(${report.message_matches} message(s), ${report.proposal_matches} proposal(s) matched), ranked by bm25:`,
		);
		for (const hit of report.hits) {
			if (hit.kind === "message") lines.push(...formatMessageHit(hit));
			else lines.push(...formatProposalHit(hit));
		}
		lines.push(
			``,
			`Walk further: prospect show <proposal-id> · prospect show --session <id> · prospect node <output-key> (prefix ok).`,
		);
	}
	if (report.omitted_by_limit > 0) lines.push(`… ${report.omitted_by_limit} more hit(s) omitted by --limit ${opts.limit}.`);
	return lines.join("\n");
}

/**
 * The shared core of `prospect search` for the slash command and the tool
 * action. Runs the FTS5 query and renders the report.
 */
export function readSearch(db: Database.Database, q: SearchQuery): { text: string; report: SearchReport } {
	const opts: SearchOptions = { kind: q.kind, limit: q.limit, source: q.source };
	const result = searchCorpus(db, q.query, opts);
	const report: SearchReport = {
		query: result.query,
		hits: result.hits,
		message_matches: result.message_matches,
		proposal_matches: result.proposal_matches,
		omitted_by_limit: result.omitted_by_limit,
	};
	return { text: renderSearch(result, opts), report };
}

// ─────────────────────────── command surfaces ───────────────────────────

function out(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/** `/prospect-search` — content and pattern search over the corpus. */
export async function prospectSearch(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		try {
			const q = parseSearchArgs(rawArgs ?? "");
			const { text } = readSearch(db, q);
			out(ctx, text);
		} catch (err) {
			out(ctx, `prospect search: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	} finally {
		db.close();
	}
}

export function registerSearchCommands(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-search", {
		description:
			"Content and pattern search over proposals and the session corpus (SQLite FTS5). " +
			"Every hit names its record kind, id, session, and a highlighted snippet, ranked by bm25, " +
			"with links into prospect show / prospect node. " +
			"Syntax: plain terms (implicit AND), \"quoted phrases\", prefix terms (lexicon*), OR / NOT / AND, " +
			"NEAR(a b, n), column:term (messages: content_text, content_thinking; proposals: title, summary, detail, evidence). " +
			"Flags: --kind <all|messages|proposals>, --limit <n>, --source <pi|claude>.",
		handler: prospectSearch,
	});
}
