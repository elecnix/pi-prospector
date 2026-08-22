/**
 * nosey-parker — deterministic session-level secret detection using the ported
 * Nosey Parker rule catalogue.
 *
 * Scans every message field of a session transcript with the Nosey Parker
 * rule set (see `rules.ts` for provenance: upstream v0.24.0, MIT OR
 * Apache-2.0) and emits one `metric` node per session recording what was
 * found. No LLM is used.
 *
 * The analyzer is **standalone** — it declares no dependencies and reads the
 * session's raw messages directly, so it runs even before turn-pair-core has.
 * Its unit identity folds in every message id in the session, so a session
 * that grows new turns re-identifies and is re-scanned on the next run.
 *
 * What distinguishes this detector: per-rule **captures** (the fingerprint
 * covers exactly the captured credential, not the surrounding match) and the
 * **passive/active confidence** distinction, with a config floor
 * (`minConfidence`) that can raise the bar to context-confirmed matches only.
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
import { Type, type Static } from "typebox";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import {
	DEFAULT_NOSEY_PARKER_CONFIG,
	type NoseyParkerConfig,
} from "./config.js";
import {
	detectNoseyParkerLeaks,
	SecretLeakScanResult,
} from "./detectors.js";

/** The node content: the shared scan result plus the session-level envelope fields. */
export const NoseyParkerProperties = Type.Object({
	...SecretLeakScanResult.properties,
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** Convenience boolean: were any leaks found? */
	has_leaks: Type.Boolean(),
	/** Total messages scanned. */
	message_count: Type.Number(),
});
export type NoseyParkerProperties = Static<typeof NoseyParkerProperties>;

export const NOSEY_PARKER_DEF: AnalyzerDef = {
	id: "nosey-parker",
	label: "Secret Leak Detection (Nosey Parker rules)",
	description:
		"Scans session transcripts with the ported Nosey Parker rule catalogue (captured credentials, passive/active confidence) and records redacted findings. No LLM; never stores the matched secret.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: NoseyParkerProperties,
};

export const NOSEY_PARKER_VERSION: AnalyzerVersion = {
	analyzerId: NOSEY_PARKER_DEF.id,
	// 1.0: initial port — a representative, high-signal subset of the Nosey
	// Parker v0.24.0 built-in ruleset (MIT OR Apache-2.0): captured-secret
	// rules with the passive/active confidence distinction. Standalone,
	// deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/nosey-parker/index.ts",
};


// ──────────────────────────── analyzer ────────────────────────────

// ──────────────────────────── analyzer ────────────────────────────

export const noseyParkerAnalyzer: Analyzer = {
	def: NOSEY_PARKER_DEF,
	version: NOSEY_PARKER_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: NOSEY_PARKER_DEF.id,
		configHash: computeConfigHash(DEFAULT_NOSEY_PARKER_CONFIG),
		configJson: DEFAULT_NOSEY_PARKER_CONFIG as unknown as Record<string, unknown>,
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
			(ctx.config.configJson as unknown as NoseyParkerConfig) ?? DEFAULT_NOSEY_PARKER_CONFIG;
		// Re-read messages from the DB rather than the (possibly stale) plan-time
		// list, matching the other detectors' pattern.
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = detectNoseyParkerLeaks(messages, config);

		const properties: NoseyParkerProperties = {
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
export {
	NOSEY_PARKER_RULES,
	NOSEY_PARKER_UPSTREAM,
	detectNoseyParkerLeaks,
	matchedNoseyParkerRuleIds,
} from "./detectors.js";
export { fingerprintOf, redact } from "../secret-scanner.js";
export { DEFAULT_NOSEY_PARKER_CONFIG, type NoseyParkerConfig } from "./config.js";
