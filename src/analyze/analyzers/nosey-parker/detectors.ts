/**
 * Nosey Parker detectors: the ported catalogue applied to a session's message
 * stream through the shared secret-scanning engine. Pure and deterministic.
 *
 * Findings never store the matched secret — the shared engine redacts to a
 * preview plus a short SHA-256 fingerprint, derived identically to the other
 * detectors, so the future proposal synthesiser can collapse the same leak
 * found by several detectors into one proposal. Unlike the other catalogues,
 * most rules here capture the secret as group 1 inside a larger match, so the
 * fingerprint covers exactly the credential, not its surrounding context.
 */

import type { MessageRow } from "../../types.js";
import {
	scanMessages,
	matchedRuleIdsFor,
	type SecretLeakScanResult,
} from "../secret-scanner.js";
import { NOSEY_PARKER_RULES } from "./rules.js";
import { DEFAULT_NOSEY_PARKER_CONFIG, type NoseyParkerConfig } from "./config.js";

// Re-export the shared engine surface so consumers import the detector
// vocabulary from this module.
export {
	fingerprintOf,
	redact,
	meetsMinSeverity,
	meetsMinConfidence,
	SEVERITY_RANK,
	CONFIDENCE_RANK,
	LeakField,
	LeakSeverity,
	LeakConfidence,
	SecretLeakFinding,
	type SecretLeakRule,
	SecretLeakScanResult,
} from "../secret-scanner.js";
export { NOSEY_PARKER_RULES, NOSEY_PARKER_UPSTREAM } from "./rules.js";
export { DEFAULT_NOSEY_PARKER_CONFIG, type NoseyParkerConfig } from "./config.js";

/**
 * Detect secret leaks across a session's messages with the Nosey Parker
 * catalogue.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectNoseyParkerLeaks(
	messages: readonly MessageRow[],
	config: NoseyParkerConfig = DEFAULT_NOSEY_PARKER_CONFIG,
): SecretLeakScanResult {
	return scanMessages(messages, NOSEY_PARKER_RULES, config);
}

/**
 * Convenience: scan a single string against the Nosey Parker catalogue and
 * return the rule ids that matched. Used by unit tests; not called on the hot
 * path.
 */
export function matchedNoseyParkerRuleIds(text: string): string[] {
	return matchedRuleIdsFor(NOSEY_PARKER_RULES, text);
}
