/**
 * Gitleaks detectors: the ported catalogue applied to a session's message
 * stream through the shared secret-scanning engine. Pure and deterministic.
 *
 * Findings never store the matched secret — the shared engine redacts to a
 * preview plus a short SHA-256 fingerprint, identical to the `secret-leak`
 * analyzer's derivation, so the future proposal synthesiser can collapse the
 * same leak found by both detectors into one proposal.
 */

import type { MessageRow } from "../../types.js";
import {
	scanMessages,
	matchedRuleIdsFor,
	type SecretLeakScanResult,
} from "../secret-scanner.js";
import { GITLEAKS_RULES } from "./rules.js";
import { DEFAULT_GITLEAKS_CONFIG, type GitleaksConfig } from "./config.js";

// Re-export the shared engine surface so consumers import the detector
// vocabulary from this module.
export {
	fingerprintOf,
	redact,
	meetsMinSeverity,
	SEVERITY_RANK,
	type LeakField,
	type LeakSeverity,
	type SecretLeakFinding,
	type SecretLeakRule,
	type SecretLeakScanResult,
} from "../secret-scanner.js";
export { GITLEAKS_RULES, GITLEAKS_UPSTREAM } from "./rules.js";
export { DEFAULT_GITLEAKS_CONFIG, type GitleaksConfig } from "./config.js";

/**
 * Detect secret leaks across a session's messages with the gitleaks catalogue.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectGitleaksLeaks(
	messages: readonly MessageRow[],
	config: GitleaksConfig = DEFAULT_GITLEAKS_CONFIG,
): SecretLeakScanResult {
	return scanMessages(messages, GITLEAKS_RULES, config);
}

/**
 * Convenience: scan a single string against the gitleaks catalogue and return
 * the rule ids that matched. Used by unit tests; not called on the hot path.
 */
export function matchedGitleaksRuleIds(text: string): string[] {
	return matchedRuleIdsFor(GITLEAKS_RULES, text);
}
