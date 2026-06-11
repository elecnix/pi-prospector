/**
 * Content-addressed hashing and id helpers for the analyzer framework.
 *
 * Idempotency hinges on these hashes:
 *   - `source_set_hash` identifies the exact set of inputs a node was built
 *     from. Two analyses over the same sources share a source_set_hash.
 *   - `input_hash` additionally folds in the analyzer identity, version,
 *     config, and prompt bundle. A node is uniquely identified by its
 *     input_hash; recomputing the same recipe over the same sources is a no-op.
 *
 * The version dimension (same source_set_hash, different analyzer_version /
 * config / prompt bundle) yields a *different* input_hash but the *same*
 * source_set_hash — that is how alternative versions of the same logical unit
 * are detected and linked via `revises` edges.
 */

import { createHash, randomUUID } from "node:crypto";

export interface SourceRefLike {
	kind: string;
	id: string;
}

export interface InputHashParts {
	analyzerId: string;
	analyzerVersionId: string;
	configId: string;
	promptBundleHash: string;
	sourceSetHash: string;
}

function sha256hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/** Full 64-char SHA-256 hex digest. */
export function fullHash(input: string): string {
	return sha256hex(input);
}

/** First 16 hex chars of the SHA-256 digest — compact but collision-safe enough. */
export function shortHash(input: string): string {
	return sha256hex(input).slice(0, 16);
}

/**
 * Deterministic hash over a set of source references. Order-independent:
 * sources are sorted by `kind` then `id` before hashing.
 */
export function computeSourceSetHash(sources: readonly SourceRefLike[]): string {
	const canonical = [...sources]
		.map((s) => `${s.kind}:${s.id}`)
		.sort()
		.join("|");
	return shortHash(`sources(${canonical})`);
}

/**
 * Deterministic hash over a bundle of prompt hashes. Order-independent.
 * An analyzer with no prompts has a stable empty-bundle hash.
 */
export function computePromptBundleHash(promptHashes: readonly string[]): string {
	const canonical = [...promptHashes].sort().join("|");
	return shortHash(`prompts(${canonical})`);
}

/**
 * Canonical JSON hash of an analyzer config object. Object keys are sorted
 * recursively so semantically equal configs hash identically.
 */
export function computeConfigHash(config: unknown): string {
	return shortHash(`config(${canonicalJson(config)})`);
}

/**
 * The unique recipe identity for a node: analyzer + version + config + prompts
 * + source set. Re-running the same recipe over the same sources produces the
 * same input_hash, making analysis idempotent.
 */
export function computeInputHash(parts: InputHashParts): string {
	const canonical = [
		parts.analyzerId,
		parts.analyzerVersionId,
		parts.configId,
		parts.promptBundleHash,
		parts.sourceSetHash,
	].join("|");
	return shortHash(`input(${canonical})`);
}

/** Stable, sorted-key JSON serialisation for hashing. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			out[key] = sortKeys(obj[key]);
		}
		return out;
	}
	return value;
}

/**
 * Time-ordered unique id. We use a UUID v7-style prefix (millisecond timestamp)
 * so ids sort chronologically, which keeps lineage timelines naturally ordered.
 */
export function uuidv7(): string {
	const ms = Date.now();
	const tsHex = ms.toString(16).padStart(12, "0");
	const rand = randomUUID().replace(/-/g, "").slice(0, 20);
	return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-7${rand.slice(0, 3)}-${rand.slice(3, 7)}-${rand.slice(7, 19)}`;
}
