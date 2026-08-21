/**
 * gitleaks — deterministic session-level secret detection using the ported
 * gitleaks rule catalogue.
 *
 * Scans every message field of a session transcript with the gitleaks rule
 * set (see `rules.ts` for provenance: upstream v8.25.0, Apache-2.0) and emits
 * one `metric` node per session recording what was found. No LLM is used.
 *
 * The analyzer is **standalone** — it declares no dependencies and reads the
 * session's raw messages directly, so it runs even before turn-pair-core has.
 * Its unit identity folds in every message id in the session, so a session that
 * grows new turns re-identifies and is re-scanned on the next run.
 *
 * Findings never store the matched secret: each carries a redacted preview and
 * a short SHA-256 fingerprint, derived identically to the `secret-leak`
 * analyzer. Per the single-proposal-per-leak contract this analyzer emits
 * **metric nodes only**; grouping findings by `(credential fingerprint,
 * message_id)` into one proposal is the downstream synthesiser's job, so the
 * same leak found by both detectors never becomes two proposals.
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
import { DEFAULT_GITLEAKS_CONFIG, type GitleaksConfig } from "./config.js";
import { detectGitleaksLeaks, type SecretLeakScanResult } from "./detectors.js";

export const GITLEAKS_DEF: AnalyzerDef = {
	id: "gitleaks",
	label: "Secret Leak Detection (gitleaks rules)",
	description:
		"Scans session transcripts with the ported gitleaks rule catalogue (provider tokens, assignment-context secrets) and records redacted findings. No LLM; never stores the matched secret.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const GITLEAKS_VERSION: AnalyzerVersion = {
	analyzerId: GITLEAKS_DEF.id,
	// 1.0: initial port — ~90 high-signal rules from gitleaks v8.25.0
	// (Apache-2.0): prefix-anchored provider tokens plus assignment-context
	// rules. Standalone, deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/gitleaks/index.ts",
};

export interface GitleaksProperties extends SecretLeakScanResult {
	/** Session id this analysis covers. */
	session_id: string;
	/** Convenience boolean: were any leaks found? */
	has_leaks: boolean;
	/** Total messages scanned. */
	message_count: number;
}

// ──────────────────────────── analyzer ────────────────────────────

export const gitleaksAnalyzer: Analyzer = {
	def: GITLEAKS_DEF,
	version: GITLEAKS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: GITLEAKS_DEF.id,
		configHash: computeConfigHash(DEFAULT_GITLEAKS_CONFIG),
		configJson: DEFAULT_GITLEAKS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// No messages → nothing to scan. (An empty session still gets a summary node
		// from session-overview; this analyzer simply has nothing to report.)
		if (ctx.messages.length === 0) return [];

		// The source set is the full ordered message list, so a session that grows
		// new turns re-identifies (new message ids → new sourceSetHash → `missing`)
		// and is re-scanned on the next run. Editing an existing message row is not
		// a case the transcript model produces, so id-based identity is sufficient.
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
		const config = (ctx.config.configJson as unknown as GitleaksConfig) ?? DEFAULT_GITLEAKS_CONFIG;
		// Re-read messages from the DB rather than the (possibly stale) plan-time
		// list, matching secret-leak's pattern.
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = detectGitleaksLeaks(messages, config);

		const properties: GitleaksProperties = {
			session_id: ctx.sessionId,
			has_leaks: scan.leak_count > 0,
			leak_count: scan.leak_count,
			leaks: scan.leaks,
			truncated_matches: scan.truncated_matches,
			allowlisted_matches: scan.allowlisted_matches,
			filtered_matches: scan.filtered_matches,
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
export { GITLEAKS_RULES, GITLEAKS_UPSTREAM, detectGitleaksLeaks, matchedGitleaksRuleIds } from "./detectors.js";
export { fingerprintOf, redact } from "../secret-scanner.js";
export { DEFAULT_GITLEAKS_CONFIG, type GitleaksConfig } from "./config.js";
