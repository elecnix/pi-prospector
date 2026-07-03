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
 */

import type Database from "better-sqlite3";
import type { MessageRow, SourceRef } from "../../types.js";
import { shortHash } from "../../input-hash.js";
import { buildTurnPairs } from "../turn-pair-core/build.js";
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

/** Load a session's messages in stream order (mirrors the framework's loader). */
export function loadMessagesForContrast(db: Database.Database, sessionId: string): MessageRow[] {
	return db
		.prepare(
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results " +
			"FROM messages WHERE session_id = ? ORDER BY rowid ASC",
		)
		.all(sessionId) as MessageRow[];
}

/** The current session's `cwd` (repo grouping key), or "" if unknown. */
export function getSessionCwd(db: Database.Database, sessionId: string): string {
	const row = db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(sessionId) as { cwd?: string } | undefined;
	return row?.cwd ?? "";
}

/** Sibling session ids sharing a (non-empty) `cwd`, excluding self, in a deterministic order. */
export function getSiblingSessionIds(db: Database.Database, sessionId: string, cwd: string): string[] {
	if (!cwd) return [];
	return (
		db
			.prepare("SELECT id FROM sessions WHERE cwd = ? AND id <> ? ORDER BY id ASC")
			.all(cwd, sessionId) as Array<{ id: string }>
	).map((r) => r.id);
}

/** Deterministic smoothness assessment of a sibling from its raw messages. */
function assessSibling(messages: MessageRow[]): { pairCount: number; smooth: boolean; requests: string[] } {
	const pairs = buildTurnPairs(messages);
	let frictionCount = 0;
	let correctionCount = 0;
	const requests: string[] = [];
	for (const pair of pairs) {
		const scored = scorePair(pair, DEFAULT_TURN_PAIR_CORE_CONFIG);
		if (scored.high_signal) frictionCount++;
		if (scored.correction_detected) correctionCount++;
		if (requests.length < MAX_REQUEST_SNIPPETS && pair.userText.trim().length > 0) {
			requests.push(truncate(pair.userText, REQUEST_SNIPPET_MAX));
		}
	}
	// "Smooth" = enough substance and zero friction/correction signals. Deterministic.
	const smooth = pairs.length > 0 && frictionCount === 0 && correctionCount === 0;
	return { pairCount: pairs.length, smooth, requests };
}

/**
 * Select up to `maxContrastSiblings` smooth sibling sessions in the same repo and
 * distil each into a compact contrast digest. Pure function of raw DB content —
 * deterministic and reproducible.
 */
export function selectCrossSessionContrast(
	db: Database.Database,
	sessionId: string,
	config: CrossSessionContrastConfig,
): CrossSessionContrast {
	if (!config.crossSessionContrast) return EMPTY;
	const cwd = getSessionCwd(db, sessionId);
	if (!cwd) return EMPTY;

	const candidates: SiblingContrast[] = [];
	for (const siblingId of getSiblingSessionIds(db, sessionId, cwd)) {
		const assessment = assessSibling(loadMessagesForContrast(db, siblingId));
		if (!assessment.smooth || assessment.pairCount < config.minSiblingPairs) continue;
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
