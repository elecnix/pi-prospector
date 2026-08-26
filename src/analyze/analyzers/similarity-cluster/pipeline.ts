/**
 * Clustering pipeline for the similarity-cluster analyzer (issue #145).
 *
 * Stages 2–4 of the deterministic near-miss pipeline, adapted from clone
 * detection:
 *
 *   2. Candidate pair nomination — an inverted shingle index. Each item is
 *      indexed under its RAREST shingles only (rarest-first), so even a call
 *      made entirely of boilerplate tokens gets its best shot at landing in a
 *      small bucket; shingles whose document frequency exceeds `maxFreq` are
 *      dropped as too common to narrow the search.
 *   3. Score — a length-band prune first (two sequences whose length ratio
 *      cannot reach minSimilarity can never pass the LCS ratio, so they are
 *      never scored), then the LCS similarity 2·LCS/(|a|+|b|) over two rolling
 *      rows with memory O(min(|a|,|b|)).
 *   4. Group — items sharing a normalised-body hash form ONE exact equivalence
 *      class (never n(n−1)/2 findings); near-misses are reported as PAIRS,
 *      never transitively unioned, because one weak link would merge unrelated
 *      calls into a useless blob.
 *
 * Pure and deterministic: outputs feed content-addressed node identity.
 */

import { fnv1a64 } from "../tool-trajectory/reasoning-fingerprint.js";
import { shortHash } from "../../input-hash.js";

/** One comparable item in a detector's corpus. */
export interface ClusterItem {
	/** Stable unique id: `${sessionId}:${messageId}:${ordinal}`. */
	key: string;
	sessionId: string;
	messageId: string;
	/** Position within its session (user-message index or tool ordinal). */
	turnOrdinal: number;
	/** The normalised token stream. */
	tokens: string[];
	/** Content hash of the normalised stream — exact-duplicate identity. */
	hash: string;
}

/** Per-detector pipeline parameters (from config). */
export interface DetectorParams {
	shingleWidth: number;
	/** Maximum dissimilarity to report: 1 − minSimilarity. */
	threshold: number;
	nominateWith: number;
	maxFreq: number;
	/** Items under this many tokens skip near-miss nomination but still group exactly. */
	minTokens: number;
}

/** One member of a reported cluster finding. */
export interface ClusterMember {
	session_id: string;
	message_id: string;
	turn_ordinal: number;
	normalized_hash: string;
	/** First 200 chars of the normalised token stream. */
	excerpt: string;
}

/** Pairwise similarity between two members of a near-miss finding. */
export interface PairwiseSimilarity {
	i: number;
	j: number;
	similarity: number;
}

export const DETECTORS = ["tool_call", "tool_result", "user_prompt"] as const;
export type Detector = (typeof DETECTORS)[number];

/** One reported cluster: an exact equivalence class or a single near-miss pair. */
export interface ClusterFinding {
	detector: Detector;
	size: number;
	avg_similarity: number;
	/** True when this is a same-hash equivalence class (similarity 1.0 by construction). */
	exact: boolean;
	members: ClusterMember[];
	similarities: PairwiseSimilarity[];
}

export interface DetectorOutcome {
	findings: ClusterFinding[];
	/**
	 * Eligible items that reached zero candidate pairs because every shingle
	 * they could index under was dropped at the frequency cap (or none existed).
	 * Reported, never silently assumed clean.
	 */
	blindCount: number;
	/** Total items scanned in this domain. */
	corpusSize: number;
	/** Candidate pairs actually scored through LCS. */
	comparisons: number;
}

const EXCERPT_MAX = 200;

function excerptOf(tokens: string[]): string {
	return tokens.join(" ").slice(0, EXCERPT_MAX);
}

/** Hash a contiguous token window into a 64-bit shingle key. */
function shingleKey(tokens: string[], start: number, width: number): bigint {
	return fnv1a64(tokens.slice(start, start + width).join("\u001f"));
}

/** Longest common subsequence length via two rolling rows, O(lo·hi) time, O(hi) space. */
export function lcsLength(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	let prev = new Array<number>(b.length + 1).fill(0);
	let cur = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		const ai = a[i - 1]!;
		for (let j = 1; j <= b.length; j++) {
			cur[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
		}
		const swap = prev;
		prev = cur;
		cur = swap;
	}
	return prev[b.length]!;
}

/** Stable member order: session, turn, message, key. */
function memberLess(a: ClusterItem, b: ClusterItem): number {
	return (
		a.sessionId.localeCompare(b.sessionId) ||
		a.turnOrdinal - b.turnOrdinal ||
		a.messageId.localeCompare(b.messageId) ||
		a.key.localeCompare(b.key)
	);
}

function membersOf(items: ClusterItem[]): ClusterMember[] {
	return [...items].sort(memberLess).map((m) => ({
		session_id: m.sessionId,
		message_id: m.messageId,
		turn_ordinal: m.turnOrdinal,
		normalized_hash: m.hash,
		excerpt: excerptOf(m.tokens),
	}));
}

/**
 * Run stages 2–4 over one domain's items. Deterministic end to end: candidate
 * sets are built from sorted keys and every ranking carries explicit
 * tie-breakers, so identical inputs produce byte-identical findings.
 */
export function clusterItems(items: ClusterItem[], p: DetectorParams, detector: Detector): DetectorOutcome {
	const outcome: DetectorOutcome = { findings: [], blindCount: 0, corpusSize: items.length, comparisons: 0 };
	if (items.length < 2) return outcome;

	// ── Stage 4a: exact equivalence classes (hash → members). Runs regardless
	// of minTokens: a short item can never be nominated for near-miss scoring
	// but is still an exact duplicate worth one finding naming every member.
	const byHash = new Map<string, ClusterItem[]>();
	for (const item of items) {
		const bucket = byHash.get(item.hash);
		if (bucket) bucket.push(item);
		else byHash.set(item.hash, [item]);
	}
	const exactHashes = new Set<string>();
	for (const members of byHash.values()) {
		if (members.length >= 2) {
			exactHashes.add(members[0]!.hash);
			outcome.findings.push({
				detector,
				size: members.length,
				avg_similarity: 1,
				exact: true,
				members: membersOf(members),
				similarities: [],
			});
		}
	}

	// ── Stage 2: shingles → document frequencies → rarest-first nomination.
	const eligible = items.filter((it) => it.tokens.length >= p.minTokens && it.tokens.length >= p.shingleWidth);
	const df = new Map<string, number>();
	const itemShingles: Array<Array<[string, number]>> = [];
	for (const item of eligible) {
		const seen = new Set<string>();
		for (let i = 0; i + p.shingleWidth <= item.tokens.length; i++) {
			seen.add(shingleKey(item.tokens, i, p.shingleWidth).toString(16));
		}
		const list: Array<[string, number]> = [];
		for (const s of seen) list.push([s, 0]);
		itemShingles.push(list);
		for (const s of seen) df.set(s, (df.get(s) ?? 0) + 1);
	}

	// Attach DFs, keep only surviving (≤ maxFreq) shingles, take each item's
	// rarest `nominateWith`, and build the inverted index.
	const inverted = new Map<string, number[]>();
	let blind = 0;
	for (let idx = 0; idx < eligible.length; idx++) {
		const item = eligible[idx]!;
		const withDf = itemShingles[idx]!.map(([s]) => [s, df.get(s) ?? 0] as [string, number]);
		const survivors = withDf.filter(([, d]) => d <= p.maxFreq);
		if (survivors.length === 0) {
			blind++;
			continue;
		}
		survivors.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		for (const [s] of survivors.slice(0, p.nominateWith)) {
			const postings = inverted.get(s);
			if (postings) postings.push(idx);
			else inverted.set(s, [idx]);
		}
	}

	// Every pair sharing a surviving bucket is a candidate.
	const candidates = new Set<string>();
	for (const postings of inverted.values()) {
		postings.sort((a, b) => a - b);
		for (let x = 0; x < postings.length; x++) {
			for (let y = x + 1; y < postings.length; y++) {
				const i = postings[x]!;
				const j = postings[y]!;
				candidates.add(`${i}:${j}`);
			}
		}
	}

	// ── Stage 3: length-band prune, then LCS ratio.
	const minSim = Math.max(0, 1 - p.threshold);
	// sim ≤ 2·lo/(lo+hi) ≤ 2·min/… ⇒ pairs below lo/hi ≥ minSim/(2−minSim)
	// cannot reach minSim no matter what the LCS says.
	const minRatio = minSim / (2 - minSim);
	for (const cand of candidates) {
		const [iStr, jStr] = cand.split(":");
		const i = Number(iStr);
		const j = Number(jStr);
		const a = eligible[i]!;
		const b = eligible[j]!;
		if (a.hash === b.hash) continue; // already grouped exactly
		const hi = Math.max(a.tokens.length, b.tokens.length);
		const lo = Math.min(a.tokens.length, b.tokens.length);
		if (lo / hi < minRatio) continue;
		const lcs = lcsLength(a.tokens, b.tokens);
		outcome.comparisons++;
		const sim = (2 * lcs) / (a.tokens.length + b.tokens.length);
		if (sim >= minSim) {
			outcome.findings.push({
				detector,
				size: 2,
				avg_similarity: sim,
				exact: false,
				members: membersOf([a, b]),
				similarities: [{ i: 0, j: 1, similarity: sim }],
			});
		}
	}

	outcome.blindCount = blind;
	return outcome;
}

/**
 * Rank findings the way the issue specifies — exact clones first, then by
 * average similarity, size, and stable tie-breakers — and cap the list.
 */
export function rankFindings(findings: ClusterFinding[], top: number): ClusterFinding[] {
	return [...findings]
		.sort(
			(a, b) =>
				Number(b.exact) - Number(a.exact) ||
				b.avg_similarity - a.avg_similarity ||
				b.size - a.size ||
				a.detector.localeCompare(b.detector) ||
				a.members[0]!.normalized_hash.localeCompare(b.members[0]!.normalized_hash),
		)
		.slice(0, Math.max(0, top));
}

/** Content hash of one item's normalised token stream (its exact-clone identity). */
export function hashTokens(tokens: string[]): string {
	return shortHash(tokens.join("\u001f"));
}
