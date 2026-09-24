/**
 * Normalised lexical fingerprinting of the agent's private reasoning.
 *
 * Thought-oscillation (issue #117) detects repeated reasoning without progress:
 * near-duplicate thinking blocks across turns. The comparison cannot be raw text
 * — whitespace, casing, code blocks, file paths, URLs, and identifiers churn
 * between two attempts at the *same* dead end — so each reasoning block is first
 * reduced to prose, then fingerprinted over shingles so near-duplicates match
 * but genuine paraphrases do not:
 *
 *   1. strip everything that is not the agent's own language (code blocks,
 *      paths, URLs, identifiers — the same shape filters `lexicon-candidates`
 *      uses, reused here so the two analyzers cannot disagree about what counts
 *      as prose);
 *   2. normalise case and whitespace;
 *   3. take word 5-gram shingles, hashed individually into 64 bits (FNV-1a) so
 *      the fingerprint is a *set*, immune to token-level noise;
 *   4. similarity between two fingerprints is the **Jaccard** of their hashed
 *      shingle sets — the exact value min-hash would estimate, computed directly
 *      because a session yields only dozens of shingles per block.
 *
 * Two attempts that repeat the same reasoning share nearly all shingles; a
 * paraphrase reshuffles enough words that every 5-gram changes and the sets
 * barely intersect. Texts shorter than one shingle are not fingerprintable at
 * all: a two-word fragment ("still failing") would match every turn it appears
 * in, so such blocks are skipped upstream.
 *
 * Pure and deterministic throughout: these fingerprints feed content-addressed
 * node identity, so the same reasoning must always yield the same value on any
 * machine.
 */

import { stripNonProse } from "../lexicon-candidates/tokenize.js";

/** Words per shingle. Five words is long enough that coincidental overlap is rare. */
export const REASONING_SHINGLE_SIZE = 5;

/**
 * One reasoning block's lexical fingerprint: the set of 64-bit hashes of its
 * normalised 5-gram shingles, plus the normalised prose itself for diagnostics.
 */
export interface ReasoningFingerprint {
	normalized: string;
	/** Distinct FNV-1a hashes of the block's 5-gram shingles. */
	shingleHashes: Set<bigint>;
}

/**
 * Reduce reasoning text to comparable prose: shape filters applied, lowercased,
 * whitespace collapsed. Returns "" when nothing prose-shaped survives.
 */
export function normalizeReasoningText(text: string): string {
	if (!text) return "";
	const stripped = stripNonProse(text.normalize("NFKC"));
	return stripped.toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * The word 5-gram shingles of already-normalised prose, in order. Text shorter
 * than one shingle yields no shingles at all.
 */
export function reasoningShingles(normalized: string): string[] {
	const words = normalized.length === 0 ? [] : normalized.split(" ");
	if (words.length < REASONING_SHINGLE_SIZE) return [];
	const shingles: string[] = [];
	for (let i = 0; i + REASONING_SHINGLE_SIZE <= words.length; i++) {
		shingles.push(words.slice(i, i + REASONING_SHINGLE_SIZE).join(" "));
	}
	return shingles;
}

/** FNV-1a over 64 bits. Small, stable across machines — BigInt keeps the arithmetic exact. */
export function fnv1a64(input: string): bigint {
	let h = 0xcbf29ce484222325n;
	for (let i = 0; i < input.length; i++) {
		h ^= BigInt(input.charCodeAt(i));
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h;
}

/** Hex form of a fingerprint's identity digest, for carrying inside signal evidence. */
export function fingerprintHex(fingerprint: ReasoningFingerprint): string {
	return fnv1a64(fingerprint.normalized).toString(16).padStart(16, "0");
}

/**
 * Similarity of two fingerprints in [0, 1]: the Jaccard of their hashed shingle
 * sets. Identical reasoning scores 1; a couple of edited sentences in an
 * otherwise-repeated block stays high; a genuine paraphrase collapses toward 0
 * because changing any word of a 5-gram destroys five shingles at a stroke.
 */
export function fingerprintSimilarity(a: ReasoningFingerprint, b: ReasoningFingerprint): number {
	if (a.shingleHashes.size === 0 || b.shingleHashes.size === 0) return 0;
	let shared = 0;
	for (const h of a.shingleHashes) {
		if (b.shingleHashes.has(h)) shared++;
	}
	const union = a.shingleHashes.size + b.shingleHashes.size - shared;
	return union === 0 ? 0 : shared / union;
}

/**
 * Fingerprint one reasoning block, or null when its normalised prose is too
 * short to form even one shingle.
 */
export function fingerprintReasoning(text: string): ReasoningFingerprint | null {
	const normalized = normalizeReasoningText(text);
	const shingles = reasoningShingles(normalized);
	if (shingles.length === 0) return null;
	return { normalized, shingleHashes: new Set(shingles.map(fnv1a64)) };
}
