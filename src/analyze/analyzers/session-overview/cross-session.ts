/**
 * Cross-session success/failure contrast (issue #10, optional item).
 *
 * When a session lives in a repo/`cwd` that ALSO contains smooth (low-friction)
 * sibling sessions, the reduce step is handed a compact "what smooth sessions in
 * this repo did" digest as negative examples. This widens ExpeL-style contrast
 * from within-session to cross-session.
 *
 * Content-addressing (the crux)
 * ─────────────────────────────
 * A `session-overview` node is per-session; its identity is a pure function of
 * its declared source set. Pulling data from OTHER sessions therefore MUST fold
 * those siblings into this node's source set, or reproducibility breaks.
 *
 * This module derives the contrast **deterministically from sibling RAW
 * messages** — never from sibling analysis nodes. Raw messages are present for
 * every session after ingest (`/prospect-sync`) and before any analysis, so the
 * derivation does not depend on analysis order or on whether a sibling has been
 * analysed yet (which would be non-deterministic under the concurrent per-session
 * run, and circular — a session-overview node cannot depend on sibling
 * session-overview nodes). Sibling selection reuses the deterministic
 * turn-pair-core scoring, so "smooth" is reproducible. Each selected sibling is
 * added to the source set as a `session`-kind `SourceRef` whose id embeds a hash
 * of the exact contrast digest, so the node's `input_key`/`output_key` commit to
 * the precise sibling content and reproduce across an independent DB rebuild.
 *
 * Memory discipline (#232)
 * ────────────────────────
 * Sibling assessment runs over EVERY session sharing a `cwd`. A large repo can
 * have thousands of sessions, and loading each sibling's FULL message rows
 * (content_text + content_thinking + tool_calls + tool_results) via
 * `getTurnPairs` materialised the entire repository's conversation history into
 * the V8 heap — once per target session, multiplied by session concurrency. The
 * assessment only needs what `scorePair` reads (userText, priorUserText,
 * tool-failure flags, tool-result byte counts, and whether the assistant
 * replied), so it runs from a narrow SQL projection that omits `content_thinking`
 * (the largest column) and never routes through `getTurnPairs`. The per-`cwd`
 * smoothness scan is also shared across target sessions in the same run, so 10
 * concurrent sessions in one repo assess the sibling set once, not 10×.
 */

import { type AsyncDatabase } from "../../../db/async-db.js";
import type { SourceRef } from "../../types.js";
import type { TurnPair } from "../turn-pair-core/build.js";
import { shortHash } from "../../input-hash.js";
import { scorePair } from "../turn-pair-core/index.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG } from "../turn-pair-core/config.js";
import type { CrossSessionContrastConfig } from "./config.js";

/** A smooth sibling session distilled into a compact, deterministic contrast digest. */
export interface SiblingContrast {
	sessionId: string;
	pairCount: number;
	/** Compact human-readable digest fed to the reduce prompt. */
	digestText: string;
	/** Hash of `digestText`; embedded in the source-set ref so identity commits to the content. */
	contentHash: string;
}

export interface CrossSessionContrast {
	siblings: SiblingContrast[];
	/** Source refs to fold into the session-overview unit's source set. */
	sourceRefs: SourceRef[];
}

const EMPTY: CrossSessionContrast = { siblings: [], sourceRefs: [] };

/** Max user-request snippets included per sibling digest (bounded → stable identity). */
const MAX_REQUEST_SNIPPETS = 2;
const REQUEST_SNIPPET_MAX = 120;

/**
 * A narrow message projection for sibling assessment: only the columns `scorePair`
 * reads. `content_thinking` — the largest column and the one that made contrast
 * selection materialise a whole repo's history into the heap (#232) — is absent.
 */
export interface NarrowMessage {
	id: string;
	role: string;
	content_text: string | null;
	tool_calls: string | null;
	tool_results: string | null;
}

/** Smoothness assessment of a sibling from its turn pairs. */
export interface SiblingSmoothness {
	pairCount: number;
	smooth: boolean;
	frictionCount: number;
	correctionCount: number;
	requests: string[];
}

/** The current session's `cwd` (repo grouping key), or "" if unknown. */
export async function getSessionCwd(db: AsyncDatabase, sessionId: string): Promise<string> {
	const row = (await db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(sessionId)) as { cwd?: string } | undefined;
	return row?.cwd ?? "";
}

/** Sibling session ids sharing a (non-empty) `cwd`, excluding self, in a deterministic order. */
export async function getSiblingSessionIds(db: AsyncDatabase, sessionId: string, cwd: string): Promise<string[]> {
	if (!cwd) return [];
	return (
		(await db
			.prepare("SELECT id FROM sessions WHERE cwd = ? AND id <> ? ORDER BY id ASC")
			.all(cwd, sessionId)) as Array<{ id: string }>
	).map((r) => r.id);
}

// ────────────────────── narrow turn-pair construction ──────────────────────

/** Turn-starting roles, mirroring the full builder (see turn-pair-core/build.ts). */
const TURN_START_ROLES = new Set<string>(["user", "bashExecution", "branch_summary", "custom_message"]);

/** Parsed tool-result flags — the only fields `scorePair` reads from tool results. */
interface NarrowToolResult {
	isError: boolean;
	textLength: number;
}

function parseToolResults(json: string | null): NarrowToolResult[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as Array<{ isError?: unknown; textLength?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.map((r) => ({
			isError: Boolean(r.isError),
			textLength: typeof r.textLength === "number" ? r.textLength : 0,
		}));
	} catch {
		return [];
	}
}

/**
 * A minimal turn-pair carrying only what `scorePair` reads. `assistantText` is a
 * single-char sentinel (non-empty when the assistant said anything) rather than
 * the full accumulated text, and `thinkingText` is always "" because `scorePair`
 * never reads it. This keeps each pair O(1) in memory regardless of message size.
 */
interface NarrowPair {
	userText: string;
	priorUserText: string | null;
	/** Non-empty iff the assistant produced any text in this turn. */
	hasAssistantText: boolean;
	toolCallCount: number;
	toolResults: NarrowToolResult[];
}

function buildNarrowPairs(messages: readonly NarrowMessage[]): NarrowPair[] {
	const pairs: NarrowPair[] = [];
	let priorUserText: string | null = null;
	let current: { pair: NarrowPair } | null = null;

	const flush = (): void => {
		if (current) {
			pairs.push(current.pair);
			priorUserText = current.pair.userText;
			current = null;
		}
	};

	for (const m of messages) {
		if (TURN_START_ROLES.has(m.role)) {
			flush();
			current = {
				pair: {
					userText: m.content_text ?? "",
					priorUserText,
					hasAssistantText: false,
					toolCallCount: 0,
					toolResults: [],
				},
			};
			continue;
		}
		if (!current) continue;

		if (m.role === "assistant") {
			if (m.content_text && m.content_text.trim().length > 0) current.pair.hasAssistantText = true;
			if (m.tool_calls) current.pair.toolCallCount += countToolCalls(m.tool_calls);
		} else if (m.role === "toolResult") {
			current.pair.toolResults.push(...parseToolResults(m.tool_results));
		}
	}
	flush();
	return pairs;
}

function countToolCalls(json: string): number {
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Assess a sibling's smoothness from a narrow message projection — the path that
 * replaced the full `getTurnPairs` call (#232). Produces the same `scorePair`
 * verdicts as the full `TurnPair` path because `scorePair` only reads the fields
 * this builder populates: `userText`, `priorUserText`, tool-failure flags,
 * tool-result byte counts, and whether the assistant replied at all.
 */
export function assessSiblingFromMessages(messages: readonly NarrowMessage[]): SiblingSmoothness {
	const pairs = buildNarrowPairs(messages);
	return assessNarrowPairs(pairs);
}

/** Assess from pre-built narrow pairs (used by the per-`cwd` shared scan). */
function assessNarrowPairs(pairs: NarrowPair[]): SiblingSmoothness {
	let frictionCount = 0;
	let correctionCount = 0;
	const requests: string[] = [];
	for (const pair of pairs) {
		// Build the minimal TurnPair shape scorePair reads, with the sentinel
		// assistantText and empty thinkingText (which scorePair ignores).
		const scored = scorePair(
			{
				userText: pair.userText,
				priorUserText: pair.priorUserText,
				assistantText: pair.hasAssistantText ? "x" : "",
				thinkingText: "",
				toolCalls: new Array(pair.toolCallCount),
				toolResults: pair.toolResults.map((r) => ({
					toolName: "",
					isError: r.isError,
					textLength: r.textLength,
					errorHead: null,
				})),
			} as unknown as TurnPair,
			DEFAULT_TURN_PAIR_CORE_CONFIG,
		);
		if (scored.high_signal) frictionCount++;
		if (scored.correction_detected) correctionCount++;
		if (requests.length < MAX_REQUEST_SNIPPETS && pair.userText.trim().length > 0) {
			requests.push(truncate(pair.userText, REQUEST_SNIPPET_MAX));
		}
	}
	const smooth = pairs.length > 0 && frictionCount === 0 && correctionCount === 0;
	return { pairCount: pairs.length, smooth, frictionCount, correctionCount, requests };
}

// ────────────────────── per-`cwd` shared smoothness scan ──────────────────────

/**
 * Shared smoothness results for one `cwd`, keyed by sibling session id. Built
 * once per `selectCrossSessionContrast` call and reused across target sessions
 * in the same run that share the same `cwd`, so 10 concurrent sessions in one
 * repo scan the sibling set once, not 10×.
 */
export interface CwdSmoothnessCache {
	cwd: string;
	/** Smoothness per sibling session id (only smooth siblings are kept). */
	bySibling: Map<string, SiblingSmoothness>;
}

/**
 * Load and assess all smooth siblings for a `cwd` from a narrow SQL projection.
 * The projection omits `content_thinking` (the largest column) and every column
 * `scorePair` never reads, so assessing a thousand siblings costs a fraction of
 * the full-message path. Only smooth siblings are retained in the cache.
 *
 * The scan includes ALL sessions in the `cwd` (no `excludeId`) so the cache is
 * fully reusable across every target session in the same repo — a later call
 * from a different session must not find *itself* among the smooth siblings
 * just because the first caller excluded a different id. The target session is
 * filtered out at selection time in `selectCrossSessionContrast`.
 */
export async function scanCwdSmoothness(db: AsyncDatabase, cwd: string, _excludeId: string, minSiblingPairs: number): Promise<CwdSmoothnessCache> {
	const cache: CwdSmoothnessCache = { cwd, bySibling: new Map() };
	if (!cwd) return cache;

	const stmt = db.prepare(
		"SELECT s.id AS session_id, m.id, m.role, m.content_text, m.tool_calls, m.tool_results " +
			"FROM sessions s JOIN messages m ON m.session_id = s.id " +
			"WHERE s.cwd = ? " +
			"ORDER BY s.id ASC, m.rowid ASC",
	);
	const rows = (await stmt.all(cwd)) as Array<{
		session_id: string;
		id: string;
		role: string;
		content_text: string | null;
		tool_calls: string | null;
		tool_results: string | null;
	}>;

	// Group messages by sibling session id (rows are ordered by session_id, then rowid).
	let currentId: string | null = null;
	let currentMsgs: NarrowMessage[] = [];
	for (const row of rows) {
		if (row.session_id !== currentId) {
			if (currentId !== null) assessAndStore(cache, currentId, currentMsgs, minSiblingPairs);
			currentId = row.session_id;
			currentMsgs = [];
		}
		currentMsgs.push({
			id: row.id,
			role: row.role,
			content_text: row.content_text,
			tool_calls: row.tool_calls,
			tool_results: row.tool_results,
		});
	}
	if (currentId !== null) assessAndStore(cache, currentId, currentMsgs, minSiblingPairs);

	return cache;
}

function assessAndStore(cache: CwdSmoothnessCache, siblingId: string, msgs: NarrowMessage[], minSiblingPairs: number): void {
	const assessment = assessSiblingFromMessages(msgs);
	if (assessment.smooth && assessment.pairCount >= minSiblingPairs) {
		cache.bySibling.set(siblingId, assessment);
	}
}

/**
 * Select up to `maxContrastSiblings` smooth sibling sessions in the same repo and
 * distil each into a compact contrast digest. Pure function of raw DB content —
 * deterministic and reproducible.
 *
 * Sibling smoothness is assessed from a narrow SQL projection (no
 * `content_thinking`, no full-message cache), never via `getTurnPairs`. The
 * `getTurnPairs` parameter is retained for API compatibility but is no longer
 * called for sibling assessment — the narrow `db` path is authoritative.
 *
 * A `cwdCache` from a prior `scanCwdSmoothness` call may be passed to share the
 * sibling scan across target sessions in the same repo; when omitted, the scan
 * runs inline.
 */
export async function selectCrossSessionContrast(
	db: AsyncDatabase,
	sessionId: string,
	config: CrossSessionContrastConfig,
	_getTurnPairs: (sessionId: string) => Promise<TurnPair[]>,
	cwdCache?: CwdSmoothnessCache,
): Promise<CrossSessionContrast> {
	if (!config.crossSessionContrast) return EMPTY;
	const cwd = await getSessionCwd(db, sessionId);
	if (!cwd) return EMPTY;

	const smoothness = cwdCache && cwdCache.cwd === cwd
		? cwdCache
		: await scanCwdSmoothness(db, cwd, sessionId, config.minSiblingPairs);

	const candidates: SiblingContrast[] = [];
	for (const [siblingId, assessment] of smoothness.bySibling) {
		// The target session is in the cache too (the scan excludes nothing so the
		// cache is reusable across every session in the repo). A session must never
		// be its own contrast sibling.
		if (siblingId === sessionId) continue;
		const digestText = formatSiblingDigest(siblingId, assessment.pairCount, assessment.requests);
		candidates.push({
			sessionId: siblingId,
			pairCount: assessment.pairCount,
			digestText,
			contentHash: shortHash(digestText),
		});
	}

	// Rank: most substantial first (more pairs), ties broken by id for stability.
	candidates.sort((a, b) => b.pairCount - a.pairCount || a.sessionId.localeCompare(b.sessionId));
	const siblings = candidates.slice(0, Math.max(0, config.maxContrastSiblings));

	const sourceRefs: SourceRef[] = siblings.map((s) => ({
		kind: "session" as const,
		id: `${s.sessionId}:${s.contentHash}`,
	}));
	return { siblings, sourceRefs };
}

/** Render the contrast block appended to the reduce prompt, or "" when there is none. */
export function formatContrastContext(siblings: readonly SiblingContrast[]): string {
	if (siblings.length === 0) return "";
	const lines = [
		"These sibling sessions in the SAME repo went smoothly (no friction detected).",
		"Use them as negative examples: what did the smooth sessions do that this session did not?",
		"",
	];
	for (const s of siblings) lines.push(`- ${s.digestText}`);
	return lines.join("\n");
}

function formatSiblingDigest(sessionId: string, pairCount: number, requests: string[]): string {
	const head = `session ${sessionId.slice(0, 8)} — ${pairCount} turn(s), smooth`;
	if (requests.length === 0) return head;
	return `${head}; requests: ${requests.map((r) => `"${r}"`).join(" | ")}`;
}

function truncate(s: string, maxLen: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}