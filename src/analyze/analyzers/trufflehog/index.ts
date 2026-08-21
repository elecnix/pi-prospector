/**
 * trufflehog — the TruffleHog-style detector analyzer: a thin deterministic
 * detector over the shared secret-scanning engine, plus its distinctive
 * contribution, **opt-in live credential verification**.
 *
 * Licence (issue #170): TruffleHog is AGPL-3.0. Only its *verification
 * concept* is implemented here — no upstream code or rule text was vendored
 * or ported. Detection runs against this repository's own small catalogue of
 * genuinely-new patterns (`rules.ts`); broad provider coverage already comes
 * from the stacked detectors (secret-leak, gitleaks, nosey-parker,
 * detect-secrets), so this catalogue is deliberately near-empty rather than
 * duplicative.
 *
 * The verifier half mirrors the repo's LLM seam: production verifiers
 * (`verifiers.ts`) make real network calls to the provider that issued a
 * candidate credential; tests inject deterministic mocks
 * (`mock-verifiers.ts`). Verification is **off by default** (`verify: false`)
 * because it makes network calls and folds their results into the node;
 * enabling it is a config change, so prior nodes correctly become
 * `stale/config` — visible, never silently reused, and preserved as lineage
 * on a `--revise config` run. Each verifier talks only to its own provider,
 * and outcomes carry fixed short reasons — never provider response text and
 * never the credential — so the durable graph cannot become a second leak.
 *
 * Scans the same four message fields as the other detectors (`content_text`,
 * `content_thinking`, `tool_calls`, `tool_results`) and emits one `metric`
 * node per session. No LLM; no subprocess; no binary.
 *
 * The analyzer is **standalone** — it declares no dependencies and reads the
 * session's raw messages directly. Its unit identity folds in every message
 * id in the session, so a session that grows new turns re-identifies and is
 * re-scanned on the next run.
 *
 * Findings never store the matched secret: each carries a redacted preview
 * and a short SHA-256 fingerprint, derived identically to the other
 * detectors. Per the single-proposal-per-leak contract this analyzer emits
 * **metric nodes only**; grouping findings by `(credential fingerprint,
 * message_id)` into one proposal — including collapsing across detectors —
 * is the downstream synthesiser's job.
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
import { DEFAULT_TRUFFLEHOG_CONFIG, type TruffleHogConfig } from "./config.js";
import {
	detectTrufflehogLeaks,
	verifyFindings,
	type TruffleHogFinding,
	type VerificationSummary,
} from "./detectors.js";
import { PRODUCTION_VERIFIERS, type CredentialVerifier } from "./verifiers.js";

export const TRUFFLEHOG_DEF: AnalyzerDef = {
	id: "trufflehog",
	label: "Secret Leak Detection (TruffleHog-style verification)",
	description:
		"Scans session transcripts with a self-written catalogue of new provider-token patterns over the shared secret engine, and — only when config enables it — live-verifies findings against their issuing providers. No AGPL material; no LLM; never stores the matched secret.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const TRUFFLEHOG_VERSION: AnalyzerVersion = {
	analyzerId: TRUFFLEHOG_DEF.id,
	// 1.0: initial version — self-written detection catalogue (figd_, xai-,
	// r8_, sbp_ prefixes) plus the opt-in verifier seam (github-token,
	// openai-key, figma-token). Implements TruffleHog's verification concept
	// only; zero AGPL-3.0 material. Standalone, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/trufflehog/index.ts",
};

export interface TruffleHogProperties {
	/** Session id this analysis covers. */
	session_id: string;
	/** Convenience boolean: were any leaks found? */
	has_leaks: boolean;
	/** Total findings, after allowlisting and severity filtering. */
	leak_count: number;
	/** The findings, capped at `maxMatchesPerField` per field. */
	leaks: TruffleHogFinding[];
	/** Count of matches dropped for exceeding `maxMatchesPerField` in a field. */
	truncated_matches: number;
	/** Count of matches dropped by the allowlist (fingerprint or pattern). */
	allowlisted_matches: number;
	/** Count of matches dropped by disabled rules... reported by rule id. */
	rule_counts: Record<string, number>;
	/** Distinct message ids that contained at least one leak. */
	affected_message_ids: string[];
	/** Total messages scanned. */
	message_count: number;
	/** Whether live verification ran for this node (mirrors config.verify). */
	verify_enabled: boolean;
	/** Verification tally; present only when verification ran. */
	verification?: VerificationSummary;
}

// ──────────────────────────── analyzer ────────────────────────────

/**
 * Build the analyzer. Production runs use the shipped production verifiers;
 * tests call this with mock verifiers so no test ever touches a network.
 */
export function makeTruffleHogAnalyzer(
	verifiers: readonly CredentialVerifier[] = PRODUCTION_VERIFIERS,
): Analyzer {
	return {
		def: TRUFFLEHOG_DEF,
		version: TRUFFLEHOG_VERSION,
		prompts: {} as Record<string, PromptVersion>,
		defaultConfig: {
			id: "",
			analyzerId: TRUFFLEHOG_DEF.id,
			configHash: computeConfigHash(DEFAULT_TRUFFLEHOG_CONFIG),
			configJson: DEFAULT_TRUFFLEHOG_CONFIG as unknown as Record<string, unknown>,
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
				(ctx.config.configJson as unknown as TruffleHogConfig) ?? DEFAULT_TRUFFLEHOG_CONFIG;
			// Re-read messages from the DB rather than the (possibly stale) plan-time
			// list, matching the other detectors' pattern.
			const messages = await ctx.getSessionMessages(ctx.sessionId);
			const scan = detectTrufflehogLeaks(messages, config);

			let leaks: TruffleHogFinding[] = scan.leaks;
			let verification: VerificationSummary | undefined;
			if (config.verify && scan.leak_count > 0) {
				const run = await verifyFindings(messages, scan, config, verifiers);
				leaks = run.findings;
				verification = run.summary;
			}

			const properties: TruffleHogProperties = {
				session_id: ctx.sessionId,
				has_leaks: scan.leak_count > 0,
				leak_count: scan.leak_count,
				leaks,
				truncated_matches: scan.truncated_matches,
				allowlisted_matches: scan.allowlisted_matches,
				rule_counts: scan.rule_counts,
				affected_message_ids: scan.affected_message_ids,
				message_count: messages.length,
				verify_enabled: config.verify,
				...(verification ? { verification } : {}),
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
}

/** The production analyzer instance registered by default. */
export const trufflehogAnalyzer: Analyzer = makeTruffleHogAnalyzer();

// Re-export the public surface so consumers (and tests) import it from one place.
export {
	TRUFFLEHOG_RULES,
	TRUFFLEHOG_RULE_IDS,
	TRUFFLEHOG_CONCEPT,
	detectTrufflehogLeaks,
	verifyFindings,
	type TruffleHogFinding,
	type VerificationSummary,
} from "./detectors.js";
export {
	DEFAULT_TRUFFLEHOG_CONFIG,
	assertKnownRuleAndVerifierIds,
	TruffleHogConfigSchema,
	type TruffleHogConfig,
} from "./config.js";
export {
	PRODUCTION_VERIFIERS,
	VERIFICATION_OUTCOME_SCHEMA,
	VERIFIER_IDS,
	makeProductionVerifiers,
	outcomeForProbe,
	type CredentialVerifier,
	type FetchLike,
	type VerificationOutcome,
} from "./verifiers.js";
export { createMockVerifier, type MockVerifier, type MockVerifierCall } from "./mock-verifiers.js";
export { fingerprintOf, redact } from "../secret-scanner.js";
