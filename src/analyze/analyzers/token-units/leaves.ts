/**
 * The read-time join behind both outputs: priced request segments × the classes
 * a model named for them.
 *
 * This is the one place the two analyzers meet. `token-units` knows what every
 * request cost and nothing about what it was; `request-classes` knows what each
 * request was and nothing about cost. Neither depends on the other — joining
 * them is a rendering concern, so it lives here rather than as a dependency edge
 * that would order real analysis work around a report.
 *
 * The product is a flat list of **leaves**. A leaf is the smallest thing that
 * carries MITE: one request segment, in one class. Every view — treemap, class
 * table, model table, CSV — is a fold of that one list, so no two views of the
 * same report can disagree.
 */

import type Database from "better-sqlite3";
import type { AnalysisNodeRow } from "../../types.js";
import { latestBySession } from "../../outputs.js";
import { harnessLabel } from "../../../harness.js";
import { emptyTotals, mergeTotals, scaleTotals, type TokenTotals, type TokenUnitsProperties } from "./fold.js";
import type { RequestClassesProperties } from "../request-classes/index.js";

/** The name given to spend that carries no class. */
export const UNCLASSIFIED = "unclassified";

export interface Leaf {
	sessionId: string;
	/** "Pi" | "Claude", or "unknown" when the session's source is absent/orphaned. */
	source: string;
	project: string;
	sessionLabel: string;
	className: string;
	model: string;
	/** Local hour the request started, 0–23, or null when unrecorded. */
	hour: number | null;
	/** Local calendar day the request started on. */
	day: string | null;
	totals: TokenTotals;
	/** First line of the request, when previews are enabled. */
	preview: string;
}

export interface BuildLeavesOptions {
	db: Database.Database;
	tokenNodes: readonly AnalysisNodeRow[];
	classNodes: readonly AnalysisNodeRow[];
	/** Keep only requests that started on this local day. Omit for everything. */
	day?: string;
	/** Include the opening line of each request. */
	previews?: boolean;
}

export interface BuildLeavesResult {
	leaves: Leaf[];
	totals: TokenTotals;
	sessionsWithSpend: number;
	classifiedSessions: number;
	unclassifiedMite: number;
	truncatedRequests: number;
	coverage: { assistantRows: number; callsWithoutUsage: number; rowsWithoutKey: number };
	/** Days present in the data, ascending — for a report that names its range. */
	days: string[];
}

interface SessionRow {
	id: string;
	source: string;
	project: string;
	cwd: string;
}

/**
 * The local calendar day an ISO instant falls on. Local, because the reader's
 * question is "what did I spend today" and their today is not UTC's. Derived
 * from the instant each time rather than a fixed offset, so a day crossing a
 * daylight-saving boundary still lands correctly.
 */
export function localDayOf(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localHourOf(iso: string | null): number | null {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d.getHours();
}

/** A project name a person recognises, from the working directory. */
export function projectLabel(cwd: string, fallback: string): string {
	if (!cwd) return fallback || "unknown";
	const parts = cwd.split("/").filter(Boolean);
	const srcIdx = parts.lastIndexOf("Source");
	if (srcIdx >= 0 && parts.length > srcIdx + 1) {
		const repo = parts[srcIdx + 1]!;
		const worktree = parts[srcIdx + 2];
		return worktree && worktree !== "main" ? `${repo}/${worktree}` : repo;
	}
	return parts[parts.length - 1] ?? fallback ?? "unknown";
}

/**
 * Fold a model spec down to the model. Three specs for one model
 * (`ollama/glm-5.2`, `openrouter/x/glm-5.2`, `glm-5.2`) are the same model doing
 * the same work, and splitting them buries it.
 */
export function modelLabel(spec: string): string {
	if (!spec || spec === "unrecorded") return "unrecorded";
	const parts = spec.split("/");
	return parts[parts.length - 1] ?? spec;
}

/**
 * Normalise a class name for grouping: case, whitespace and trailing
 * punctuation only. Near-synonyms from different sessions ("CI status
 * notifications" and "CI notifications") deliberately stay separate. Merging
 * them would take a second model pass, and inventing that consolidation is
 * exactly the steering the extraction is built to avoid.
 */
export function normaliseClass(name: string): string {
	return name.trim().replace(/\s+/g, " ").replace(/[.:;]+$/, "").toLowerCase();
}

function parseNode<T>(row: AnalysisNodeRow): T | null {
	try {
		return JSON.parse(row.content_json) as T;
	} catch {
		return null;
	}
}

/**
 * Build the leaf list.
 *
 * A request is attributed to the local day it **started** on and is not split at
 * midnight. Splitting exactly would mean keeping every call's timestamp in the
 * node, and the error this convention admits is bounded by the one or two
 * requests that straddle a boundary. The reports state the convention.
 */
export function buildLeaves(opts: BuildLeavesOptions): BuildLeavesResult {
	const { db } = opts;
	// Both analyzers key a unit on how far the session had got, so a session
	// analysed twice has two live nodes and summing them would count it twice.
	const tokenNodes = latestBySession(opts.tokenNodes);
	const classNodes = latestBySession(opts.classNodes);

	const sessions = new Map<string, SessionRow>();
	for (const row of db.prepare("SELECT id, source, project, cwd FROM sessions").all() as SessionRow[]) {
		sessions.set(row.id, row);
	}

	// session id → (user message id → the classes that request was put in)
	const classesBySession = new Map<string, Map<string, string[]>>();
	let truncatedRequests = 0;
	for (const node of classNodes) {
		const props = parseNode<RequestClassesProperties>(node);
		if (!props) continue; // a malformed node means "no classification", never "no spend"
		truncatedRequests += props.truncated ?? 0;
		const byMessage = new Map<string, string[]>();
		for (const cls of props.classes ?? []) {
			for (const n of cls.requests) {
				const messageId = props.request_message_ids[n - 1];
				if (!messageId) continue;
				const list = byMessage.get(messageId) ?? [];
				list.push(cls.name);
				byMessage.set(messageId, list);
			}
		}
		classesBySession.set(node.session_id, byMessage);
	}

	const previewOf = opts.previews
		? db.prepare("SELECT content_text FROM messages WHERE id = ?")
		: null;

	const leaves: Leaf[] = [];
	const totals = emptyTotals();
	const coverage = { assistantRows: 0, callsWithoutUsage: 0, rowsWithoutKey: 0 };
	const daysSeen = new Set<string>();
	let sessionsWithSpend = 0;
	let classifiedSessions = 0;
	let unclassifiedMite = 0;

	for (const node of tokenNodes) {
		const priced = parseNode<TokenUnitsProperties>(node);
		if (!priced) continue;

		const session = sessions.get(node.session_id);
		const project = projectLabel(session?.cwd ?? "", session?.project ?? "");
		// Go through the shared harness label: a session with no recorded source
		// reads as "unknown", never silently as Pi.
		const source = harnessLabel(session?.source);
		const sessionLabel = `${node.session_id.slice(0, 8)} · ${project}`;
		const byMessage = classesBySession.get(node.session_id);

		let sessionHadSpend = false;
		for (const seg of priced.segments ?? []) {
			if (seg.totals.calls === 0) continue;
			const day = localDayOf(seg.started_at);
			if (opts.day && day !== opts.day) continue;

			sessionHadSpend = true;
			if (day) daysSeen.add(day);
			mergeTotals(totals, seg.totals);

			const named = seg.user_message_id ? (byMessage?.get(seg.user_message_id) ?? []) : [];
			const effective = named.length > 0 ? named : [UNCLASSIFIED];
			if (named.length === 0) unclassifiedMite += seg.totals.mite;

			// A request in several classes splits its spend evenly among them, so
			// the class totals still add up to the whole.
			const shared = scaleTotals(seg.totals, 1 / effective.length);

			let preview = "";
			if (previewOf && seg.user_message_id) {
				const row = previewOf.get(seg.user_message_id) as { content_text: string | null } | undefined;
				preview = (row?.content_text ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
			}

			for (const name of effective) {
				leaves.push({
					sessionId: node.session_id,
					source,
					project,
					sessionLabel,
					className: normaliseClass(name),
					model: modelLabel(seg.models[0] ?? "unrecorded"),
					hour: localHourOf(seg.started_at),
					day,
					totals: shared,
					preview,
				});
			}
		}

		if (sessionHadSpend) {
			sessionsWithSpend++;
			if (byMessage) classifiedSessions++;
			coverage.assistantRows += priced.coverage?.assistant_rows ?? 0;
			coverage.callsWithoutUsage += priced.coverage?.calls_without_usage ?? 0;
			coverage.rowsWithoutKey += priced.coverage?.rows_without_key ?? 0;
		}
	}

	return {
		leaves,
		totals,
		sessionsWithSpend,
		classifiedSessions,
		unclassifiedMite,
		truncatedRequests,
		coverage,
		days: [...daysSeen].sort(),
	};
}

export interface ClassCost {
	className: string;
	totals: TokenTotals;
	/** Share of the report's MITE, 0–1. */
	share: number;
}

/** Roll leaves up per class, largest first — the class-cost list, as data. */
export function classCosts(leaves: readonly Leaf[], total: number): ClassCost[] {
	const byClass = new Map<string, TokenTotals>();
	for (const leaf of leaves) {
		const acc = byClass.get(leaf.className) ?? emptyTotals();
		mergeTotals(acc, leaf.totals);
		byClass.set(leaf.className, acc);
	}
	return [...byClass.entries()]
		.map(([className, totals]) => ({ className, totals, share: total > 0 ? totals.mite / total : 0 }))
		.sort((a, b) => b.totals.mite - a.totals.mite);
}
