/**
 * secret-leak — deterministic session-level secret detection.
 *
 * Scans every message field of a session transcript for high-confidence
 * credential patterns (provider-anchored API keys, PEM private-key headers,
 * signed JWTs) and emits one `metric` node per session recording what was
 * found. No LLM is used.
 *
 * The analyzer is **standalone** — it declares no dependencies and reads the
 * session's raw messages directly, so it runs even before turn-pair-core has.
 * Its unit identity folds in every message id in the session, so a session that
 * grows new turns re-identifies and is re-scanned on the next run.
 *
 * Findings never store the matched secret: each carries a redacted preview and a
 * short SHA-256 fingerprint. The analysis graph is durable and widely readable,
 * so it must not become a second leak surface — the same reasoning that makes
 * `gitleaks --redact` the default in CI.
 *
 * The node anchors to the session, plus one `anchors` edge per message that
 * contained a leak, so `prospect show` can walk a finding back to the exact
 * turn. Metric nodes from this analyzer are queryable alongside the other
 * session-level metrics and may be consumed by a future synthesis analyzer.
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
	DEFAULT_SECRET_LEAK_CONFIG,
	type SecretLeakConfig,
} from "./config.js";
import { detectSecretLeaks, type SecretLeakScanResult } from "./detectors.js";

export const SECRET_LEAK_DEF: AnalyzerDef = {
	id: "secret-leak",
	label: "Secret Leak Detection (deterministic)",
	description:
		"Scans session transcripts for high-confidence credential patterns (provider API keys, PEM private keys, signed JWTs) and records redacted findings. No LLM; never stores the matched secret.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const SECRET_LEAK_VERSION: AnalyzerVersion = {
	analyzerId: SECRET_LEAK_DEF.id,
	// 1.0: initial catalogue — AWS, GitHub, Google, Slack, Stripe, GitLab,
	// Anthropic, OpenAI, PEM private keys, signed JWTs. Standalone, deterministic.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/secret-leak/index.ts",
};

export interface SecretLeakProperties extends SecretLeakScanResult {
	/** Session id this analysis covers. */
	session_id: string;
	/** Convenience boolean: were any leaks found? */
	has_leaks: boolean;
	/** Total messages scanned. */
	message_count: number;
}

// ──────────────────────────── analyzer ────────────────────────────

export const secretLeakAnalyzer: Analyzer = {
	def: SECRET_LEAK_DEF,
	version: SECRET_LEAK_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: SECRET_LEAK_DEF.id,
		configHash: computeConfigHash(DEFAULT_SECRET_LEAK_CONFIG),
		configJson: DEFAULT_SECRET_LEAK_CONFIG as unknown as Record<string, unknown>,
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
		const config = (ctx.config.configJson as unknown as SecretLeakConfig) ?? DEFAULT_SECRET_LEAK_CONFIG;
		// Re-read messages from the DB rather than the (possibly stale) plan-time
		// list, matching tool-trajectory's pattern.
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = detectSecretLeaks(messages, config);

		const properties: SecretLeakProperties = {
			session_id: ctx.sessionId,
			has_leaks: scan.leak_count > 0,
			leak_count: scan.leak_count,
			leaks: scan.leaks,
			truncated_matches: scan.truncated_matches,
			allowlisted_matches: scan.allowlisted_matches,
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
export { SECRET_LEAK_RULES, detectSecretLeaks, redact, fingerprintOf, type SecretLeakFinding } from "./detectors.js";
export { DEFAULT_SECRET_LEAK_CONFIG, type SecretLeakConfig } from "./config.js";