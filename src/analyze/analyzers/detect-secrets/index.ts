/**
 * detect-secrets — deterministic session-level secret detection using Yelp
 * detect-secrets' method: plugin-based candidate generation (keyword-context,
 * hex/base64 high-entropy) followed by its distinctive **false-positive
 * filtering**, ported in-process (upstream v1.5.0, BSD-3-Clause — see
 * `generators.ts` and `filters.ts` for per-heuristic provenance).
 *
 * detect-secrets' value on session prose is precision: transcripts are full of
 * example tokens, placeholders, and quoted documentation, which bare regex
 * catalogues flag in droves. Its heuristics are the best-available catalogue
 * of "looks like a secret but isn't", so every candidate must survive the
 * enabled exclusion filters (sequential strings, templated secrets, example
 * placeholders, documentation URLs, code-sample contexts, low shannon
 * entropy, …) before it becomes a finding.
 *
 * The **private-key and JWT plugins are deliberately skipped**: PEM keys and
 * JWTs are already covered by the `secret-leak` catalogue, and the other
 * provider-token plugins (AWS, GitHub, Slack, Stripe, GitLab, SendGrid,
 * Twilio, Discord, npm, OpenAI, …) are covered by the `secret-leak` and
 * gitleaks catalogues. This detector adds only what they lack — see
 * `generators.ts` for the full skipped list.
 *
 * Scans the same four message fields as the other detectors (`content_text`,
 * `content_thinking`, `tool_calls`, `tool_results`) through the shared
 * secret-scanning engine, and emits one `metric` node per session. No LLM, no
 * subprocess, no binary.
 *
 * The analyzer is **standalone** — it declares no dependencies and reads the
 * session's raw messages directly, so it runs even before turn-pair-core has.
 * Its unit identity folds in every message id in the session, so a session
 * that grows new turns re-identifies and is re-scanned on the next run.
 *
 * Findings never store the matched secret: each carries a redacted preview and
 * a short SHA-256 fingerprint, derived identically to the other detectors. Per
 * the single-proposal-per-leak contract this analyzer emits **metric nodes
 * only**; grouping findings by `(credential fingerprint, message_id)` into one
 * proposal is the downstream synthesiser's job, so the same leak found by
 * multiple detectors never becomes two proposals.
 *
 * The node anchors to the session, plus one `anchors` edge per message that
 * contained a leak, so `prospect show` can walk a finding back to the exact
 * turn.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import {
	DEFAULT_DETECT_SECRETS_CONFIG,
	type DetectSecretsConfig,
} from "./config.js";
import {
	detectDetectSecretsLeaks,
	DetectSecretsScanResult,
} from "./detectors.js";
import { Type, type Static } from "typebox";

/** The node content: the detect-secrets scan result plus the session-level envelope fields. */
export const DetectSecretsProperties = Type.Object({
	...DetectSecretsScanResult.properties,
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** Convenience boolean: were any leaks found? */
	has_leaks: Type.Boolean(),
	/** Total messages scanned. */
	message_count: Type.Number(),
});
export type DetectSecretsProperties = Static<typeof DetectSecretsProperties>;

export const DETECT_SECRETS_DEF: AnalyzerDef = {
	id: "detect-secrets",
	label: "Secret Leak Detection (detect-secrets method)",
	description:
		"Scans session transcripts with Yelp detect-secrets' method — keyword-context and high-entropy candidate generators followed by its false-positive exclusion heuristics — and records redacted findings. No LLM; never stores the matched secret.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: DetectSecretsProperties,
};

export const DETECT_SECRETS_VERSION: AnalyzerVersion = {
	analyzerId: DETECT_SECRETS_DEF.id,
	// 1.0: initial port — detect-secrets v1.5.0 (BSD-3-Clause) plugin
	// generators (keyword-context, hex/base64 high-entropy) plus its exclusion
	// heuristics, as deterministic filters applied after candidate generation.
	// Private-key and JWT plugins skipped as covered by the secret-leak
	// catalogue. Standalone, deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/detect-secrets/index.ts",
};


// ──────────────────────────── analyzer ────────────────────────────

export const detectSecretsAnalyzer: Analyzer = {
	def: DETECT_SECRETS_DEF,
	version: DETECT_SECRETS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: DETECT_SECRETS_DEF.id,
		configHash: computeConfigHash(DEFAULT_DETECT_SECRETS_CONFIG),
		configJson: DEFAULT_DETECT_SECRETS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// No messages → nothing to scan. (An empty session still gets a summary
		// node from session-overview; this analyzer simply has nothing to report.)
		if (ctx.messages.length === 0) return [];

		// The source set is the full ordered message list, so a session that
		// grows new turns re-identifies (new message ids → new sourceSetHash →
		// `missing`) and is re-scanned on the next run. Editing an existing
		// message row is not a case the transcript model produces, so id-based
		// identity is sufficient.
		const sources: SourceRef[] = ctx.messages.map((m) => ({
			kind: "message" as const,
			id: m.id,
		}));
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config =
			(ctx.config.configJson as unknown as DetectSecretsConfig) ?? DEFAULT_DETECT_SECRETS_CONFIG;
		// Re-read messages from the DB rather than the (possibly stale) plan-time
		// list, matching the other detectors' pattern.
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = detectDetectSecretsLeaks(messages, config);

		const properties: DetectSecretsProperties = {
			session_id: ctx.sessionId,
			has_leaks: scan.leak_count > 0,
			leak_count: scan.leak_count,
			leaks: scan.leaks,
			truncated_matches: scan.truncated_matches,
			allowlisted_matches: scan.allowlisted_matches,
			filtered_matches: scan.filtered_matches,
			filter_counts: scan.filter_counts,
			rule_counts: scan.rule_counts,
			affected_message_ids: scan.affected_message_ids,
			message_count: messages.length,
		};

		// Anchor to the session (ordinal 0), then to each leaked message so a
		// finding is traceable to the exact turn that contained it.
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		for (const messageId of scan.affected_message_ids) {
			edges.push({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: messageId,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: ordinal++,
			});
		}

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};

// Re-export the catalogue and helpers so consumers (and tests) can import the
// analyzer's public surface from one place.
export {
	DETECT_SECRETS_GENERATORS,
	DETECT_SECRETS_UPSTREAM,
	DETECT_SECRETS_PLUGINS,
	PLUGIN_RULE_IDS,
	DEFAULT_ENTROPY_LIMITS,
	calculateShannonEntropy,
	calculateHexShannonEntropy,
	detectDetectSecretsLeaks,
	matchedDetectSecretsRuleIds,
} from "./detectors.js";
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
} from "./filters.js";
export { fingerprintOf, redact } from "../secret-scanner.js";
export {
	DEFAULT_DETECT_SECRETS_CONFIG,
	type DetectSecretsConfig,
} from "./config.js";
