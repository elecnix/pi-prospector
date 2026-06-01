/**
 * Input hash computation for idempotency
 * Based on analyzer-design-c.md specification
 */

import { createHash } from "node:crypto";

export interface SourceRef {
	kind: "message" | "analysis_node" | "session";
	id: string;
}

/**
 * Compute hash of a sorted source reference list
 */
export function computeSourceSetHash(sources: SourceRef[]): string {
	const sorted = [...sources].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
	const combined = sorted.map(r => `${r.kind}:${r.id}`).join("|");
	return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Compute hash of prompt bundle (sorted prompt hashes)
 */
export function computePromptBundleHash(promptHashes: string[]): string {
	const sorted = [...promptHashes].sort();
	return createHash("sha256").update(sorted.join("|")).digest("hex").slice(0, 16);
}

/**
 * Compute input hash for idempotency checking
 * input_hash = SHA-256(analyzer_id | version_id | config_id | prompt_bundle_hash | source_set_hash)
 */
export function computeInputHash(
	analyzerId: string,
	versionId: string,
	configId: string,
	promptBundleHash: string,
	sourceSetHash: string
): string {
	const combined = `${analyzerId}|${versionId}|${configId}|${promptBundleHash}|${sourceSetHash}`;
	return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Compute full hash (64 hex chars) for verification
 */
export function computeFullHash(analyzerId: string, versionId: string, configId: string, promptBundleHash: string, sourceSetHash: string): string {
	const combined = `${analyzerId}|${versionId}|${configId}|${promptBundleHash}|${sourceSetHash}`;
	return createHash("sha256").update(combined).digest("hex");
}

/**
 * Compute hash for proposal deduplication
 */
export function computeDedupKey(targetType: string, targetPath: string | null, severity: string, title: string): string {
	const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ");
	const combined = `${targetType}|${targetPath ?? ""}|${severity}|${normalizedTitle}`;
	return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Hash prompt content (first 16 chars for storage, full for verification)
 */
export function hashPrompt(content: string): { hash: string; fullHash: string } {
	const fullHash = createHash("sha256").update(content).digest("hex");
	return { hash: fullHash.slice(0, 16), fullHash };
}