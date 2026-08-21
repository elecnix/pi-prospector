/**
 * detect-secrets detectors: the ported pipeline applied to a session's message
 * stream — **candidate generators → exclusion filters → findings**. Pure and
 * deterministic.
 *
 * Candidate generation, redaction, fingerprinting, allowlisting, and the
 * per-field cap all run through the shared secret-scanning engine
 * (`scanMessages`), so findings are shaped and fingerprinted identically to
 * every other detector. The engine's exclusion seam runs the ported
 * detect-secrets heuristics (`filters.ts`) between matching and the cap, so a
 * candidate must survive every enabled filter to become a finding — the
 * single-proposal-per-leak contract only works because the fingerprint covers
 * exactly what survived.
 *
 * Findings never store the matched secret: each carries a redacted preview and
 * a short SHA-256 fingerprint. Per that contract this analyzer emits **metric
 * nodes only**; grouping findings by `(credential fingerprint, message_id)`
 * into one proposal is the downstream synthesiser's job.
 */

import type { MessageRow } from "../../types.js";
import {
	scanMessages,
	type SecretLeakScanResult,
} from "../secret-scanner.js";
import {
	DETECT_SECRETS_GENERATORS,
	PLUGIN_RULE_IDS,
	type DetectSecretsPluginId,
} from "./generators.js";
import { EXCLUSION_FILTERS, type ExclusionFilterContext } from "./filters.js";
import {
	DEFAULT_DETECT_SECRETS_CONFIG,
	assertKnownPluginAndFilterIds,
	type DetectSecretsConfig,
} from "./config.js";

// Re-export the shared engine surface so consumers import the detector
// vocabulary from this module.
export {
	fingerprintOf,
	redact,
	meetsMinSeverity,
	meetsMinConfidence,
	SEVERITY_RANK,
	CONFIDENCE_RANK,
	type LeakField,
	type LeakSeverity,
	type LeakConfidence,
	type SecretLeakFinding,
	type SecretLeakRule,
	type SecretLeakScanResult,
} from "../secret-scanner.js";
export {
	DETECT_SECRETS_GENERATORS,
	DETECT_SECRETS_UPSTREAM,
	DETECT_SECRETS_PLUGINS,
	PLUGIN_RULE_IDS,
	DEFAULT_ENTROPY_LIMITS,
	calculateShannonEntropy,
	calculateHexShannonEntropy,
} from "./generators.js";
export {
	EXCLUSION_FILTERS,
	EXCLUSION_FILTER_IDS,
	isTemplatedSecret,
	isPrefixedWithDollarSign,
	isNotAlphanumericString,
	isSequentialString,
	isPotentialUuid,
	isLowEntropy,
	isPlaceholderValue,
	isLikelyIdString,
	isIndirectReference,
	isDocumentationUrlContext,
	isInsideCodeSampleContext,
	type ExclusionFilterContext,
	type ExclusionFilterOptions,
} from "./filters.js";
export {
	DEFAULT_DETECT_SECRETS_CONFIG,
	assertKnownPluginAndFilterIds,
	type DetectSecretsConfig,
} from "./config.js";

/** Result of one detect-secrets scan over a session's messages. */
export interface DetectSecretsScanResult extends SecretLeakScanResult {
	/**
	 * Matches dropped by the exclusion filters (each counted in
	 * `filter_counts` by the filter that rejected it).
	 */
	filtered_matches: number;
	/** Per-filter id: how many candidates that heuristic rejected. */
	filter_counts: Record<string, number>;
}

/** Rule ids disabled when the given plugins are disabled. */
function disabledRuleIdsFor(disabledPlugins: readonly string[]): Set<string> {
	const disabled = new Set<string>();
	for (const plugin of disabledPlugins) {
		for (const ruleId of PLUGIN_RULE_IDS[plugin as DetectSecretsPluginId] ?? []) {
			disabled.add(ruleId);
		}
	}
	return disabled;
}

/**
 * Detect secret leaks across a session's messages with the detect-secrets
 * method: generate candidates (keyword-context, hex/base64 high-entropy), then
 * apply every enabled exclusion heuristic, then emit findings.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectDetectSecretsLeaks(
	messages: readonly MessageRow[],
	config: DetectSecretsConfig = DEFAULT_DETECT_SECRETS_CONFIG,
): DetectSecretsScanResult {
	assertKnownPluginAndFilterIds(config);

	const disabledRules = disabledRuleIdsFor(config.disabledPlugins);
	const disabledFilters = new Set(config.disabledFilters);
	const filterOpts = { entropyThreshold: config.entropyThreshold };
	const filterCounts: Record<string, number> = {};

	const exclude = (ctx: {
		rule: { id: string };
		value: string;
		index: number;
		line: string;
		text: string;
	}): boolean => {
		const filterCtx: ExclusionFilterContext = {
			value: ctx.value,
			line: ctx.line,
			text: ctx.text,
			index: ctx.index,
			ruleId: ctx.rule.id,
		};
		for (const filter of EXCLUSION_FILTERS) {
			if (disabledFilters.has(filter.id)) continue;
			if (filter.applies(filterCtx, filterOpts)) {
				filterCounts[filter.id] = (filterCounts[filter.id] ?? 0) + 1;
				return true;
			}
		}
		return false;
	};

	const scan = scanMessages(
		messages,
		DETECT_SECRETS_GENERATORS,
		{
			disabledRules: [...disabledRules],
			allowFingerprints: config.allowFingerprints,
			allowPatterns: config.allowPatterns,
			maxMatchesPerField: config.maxMatchesPerField,
			minSeverity: config.minSeverity,
			minConfidence: "passive",
		},
		{ exclude },
	);

	return {
		...scan,
		filtered_matches: scan.filtered_matches,
		filter_counts: filterCounts,
	};
}

/**
 * Convenience: run the full generator→filter pipeline over a single string and
 * return the generator rule ids whose candidates survived. Used by unit tests;
 * not called on the hot path.
 */
export function matchedDetectSecretsRuleIds(
	text: string,
	config: DetectSecretsConfig = DEFAULT_DETECT_SECRETS_CONFIG,
): string[] {
	const fakeMessage: MessageRow = {
		id: "probe",
		session_id: "probe",
		parent_id: null,
		timestamp: null,
		role: "user",
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
	return detectDetectSecretsLeaks([fakeMessage], config).leaks.map((l) => l.rule_id).sort();
}
