/**
 * Content-addressed hashing and id helpers for the analyzer framework.
 *
 * Idempotency and reproducibility hinge on two content-addressed keys:
 *   - `input_key` is the *recipe* identity: analyzer + version + config
 *     fingerprint + source set. It folds in only *inputs* — never the LLM's
 *     output — so a node is uniquely identified by its input_key, and recomputing
 *     the same recipe over the same sources is a no-op. (`source_set_hash`
 *     identifies just the inputs; two analyses over the same sources share it.)
 *   - `output_key` = H(input_key | canonical(content)) is the content-addressed
 *     id of a *specific result*. A consumer references its upstream sources by
 *     their `output_key`, so a consumer's `input_key` transitively commits to
 *     every upstream output. The whole graph is therefore a Merkle DAG: identical
 *     inputs+outputs reproduce identical keys on any machine, after any wipe, and
 *     a stored key can be re-derived from content to verify it.
 *
 * The version dimension (same source_set_hash, different analyzer version or
 * config fingerprint) yields a *different* input_key but the *same*
 * source_set_hash — that is how alternative versions of the same logical unit
 * are detected and linked via `revises` edges.
 *
 * The analyzer's *shipped* prompt is represented by its version, not by a
 * separate identity axis; only the user's config (including a prompt override
 * and the resolved model) feeds the config fingerprint.
 */

import { createHash, randomUUID } from "node:crypto";

export interface SourceRefLike {
	kind: string;
	id: string;
}

export interface InputHashParts {
	analyzerId: string;
	analyzerVersionId: string;
	/** Fingerprint of the user-controlled config: parameters + resolved model(s). */
	configFingerprint: string;
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
 * Deterministic hash over a bundle of prompt hashes. Order-independent. Used for
 * *run provenance* (which shipped prompts a run used); it is no longer part of
 * node identity, since a shipped prompt is represented by the analyzer version.
 */
export function computePromptBundleHash(promptHashes: readonly string[]): string {
	const canonical = [...promptHashes].sort().join("|");
	return shortHash(`prompts(${canonical})`);
}

/**
 * Fingerprint of everything the *user* controls for a node: the config's
 * content identity (its canonical-JSON hash) plus the concrete models the
 * analyzer resolved to (the tier→model mapping and any pin). Order-independent
 * over models. This is the `config` dimension of identity — a change here marks
 * nodes stale for the (ungraded) `config` reason. Using the config's *content*
 * hash (not its DB-local row id) keeps the fingerprint reproducible across
 * databases. A deterministic analyzer passes no models, so only its config
 * hash contributes.
 */
export function computeConfigFingerprint(
	configHash: string,
	models: readonly string[],
	extra: readonly string[] = [],
): string {
	// `extra` folds in additional identity tokens that are neither config content
	// nor a resolved model — currently a disk-loaded analyzer's source `contentHash`
	// (`code:<hash>`), so editing a custom analyzer marks its nodes stale without a
	// manual version bump. Sorted with the models so it is order-independent.
	const canonicalModels = [...models, ...extra].sort().join("|");
	return shortHash(`config(${configHash}|${canonicalModels})`);
}

/**
 * Canonical JSON hash of an analyzer config object. Object keys are sorted
 * recursively so semantically equal configs hash identically.
 */
export function computeConfigHash(config: unknown): string {
	return shortHash(`config(${canonicalJson(config)})`);
}

/**
 * The unique recipe identity for a node: analyzer + version + config
 * fingerprint + source set. Re-running the same recipe over the same sources
 * produces the same input_key, making analysis idempotent. Inputs only — the
 * LLM's output never feeds this key.
 */
export function computeInputKey(parts: InputHashParts): string {
	const canonical = [
		parts.analyzerId,
		parts.analyzerVersionId,
		parts.configFingerprint,
		parts.sourceSetHash,
	].join("|");
	return shortHash(`input(${canonical})`);
}

/**
 * The content-addressed identity of a node's *result*: the recipe identity
 * (`input_key`) folded together with the canonical node content. Deterministic
 * and reproducible — recomputing it from stored content verifies the node, and
 * a downstream consumer that references this key inherits the output into its
 * own `input_key`. A different output (always a different node, by the
 * append-only invariant) yields a different `output_key`.
 */
export function computeOutputKey(inputKey: string, content: unknown): string {
	return shortHash(`output(${inputKey}|${canonicalJson(content)})`);
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
