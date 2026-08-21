/**
 * secret-scanner — the SecretScanner-style container/filesystem evidence
 * detector analyzer.
 *
 * Licence (issue #172): Deepfence SecretScanner's repository root is MIT, but
 * its detection rules are split across `config.yaml` signatures and a YARA
 * rules include with mixed provenance, so **no upstream code or rule text was
 * vendored or ported**. What this analyzer implements is SecretScanner's
 * *method* — layered extraction of artifact contexts (Dockerfiles, compose
 * files, `.env` files, build logs, CI logs, shell export blocks) followed by
 * multi-pattern detection over the extracted values — applied to the
 * container and filesystem **evidence inside session transcripts**. It never
 * mounts anything, never scans a live filesystem, and never shells out.
 * Reference implementation studied: `deepfence/SecretScanner`, release
 * v2.5.8 (method and config surface only).
 *
 * Its distinctive contribution over the stacked detectors (secret-leak,
 * gitleaks, nosey-parker, detect-secrets, trufflehog) is the **extraction
 * layer** (`extractors.ts`): flat regex scanning sees one undifferentiated
 * text stream, while this analyzer recognises which artifact a value lived in
 * and segments it into key/value candidates, so a finding says WHERE the
 * value was ("ENV in Dockerfile", ".env entry") — and values that only matter
 * in an artifact context (a build-arg, an exported profile variable) become
 * visible at all. Detection reuses the bundled catalogues through the shared
 * engine plus one structural rule; see `detectors.ts`.
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
 * and a short SHA-256 fingerprint derived identically to the other detectors.
 * Per the single-proposal-per-leak contract this analyzer emits **metric
 * nodes only**; grouping findings by `(credential fingerprint, message_id)`
 * into one proposal — including collapsing across detectors — is the
 * downstream synthesiser's job.
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
import { DEFAULT_SECRET_SCANNER_CONFIG, type SecretScannerConfig } from "./config.js";
import { detectArtifactLeaks, SecretScannerScanResult } from "./detectors.js";
import { Type, type Static } from "typebox";

/** The node content: the artifact scan result plus the session-level envelope fields. */
export const SecretScannerProperties = Type.Object({
	...SecretScannerScanResult.properties,
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** Convenience boolean: were any leaks found? */
	has_leaks: Type.Boolean(),
	/** Total messages scanned. */
	message_count: Type.Number(),
});
export type SecretScannerProperties = Static<typeof SecretScannerProperties>;

export const SECRET_SCANNER_DEF: AnalyzerDef = {
	id: "secret-scanner",
	label: "Secret Leak Detection (SecretScanner-style container/filesystem evidence)",
	description:
		"Extracts container and filesystem artifact contexts from session transcripts (Dockerfiles, compose env blocks, .env entries, build logs, CI logs, shell exports), segments them into key/value candidates, and detects secrets with the bundled catalogue families plus a structural name/shape check. Implements Deepfence SecretScanner's method only — no upstream code or rules. No LLM; never stores the matched secret.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: SecretScannerProperties,
};

export const SECRET_SCANNER_VERSION: AnalyzerVersion = {
	analyzerId: SECRET_SCANNER_DEF.id,
	// 1.0: initial version — layered extraction (containerfile, compose,
	// dotenv, build log, CI log, shell export) + catalogue/structural
	// detection. Reimplements Deepfence SecretScanner's method only; zero
	// upstream rule text. Standalone, deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/secret-scanner/index.ts",
};


// ──────────────────────────── analyzer ────────────────────────────

/**
 * Build the analyzer. The seam exists for symmetry with the other detectors
 * and for future injection; detection is fully deterministic, so production
 * and tests use the same instance behaviour.
 */
export function makeSecretScannerAnalyzer(): Analyzer {
	return {
		def: SECRET_SCANNER_DEF,
		version: SECRET_SCANNER_VERSION,
		prompts: {} as Record<string, PromptVersion>,
		defaultConfig: {
			id: "",
			analyzerId: SECRET_SCANNER_DEF.id,
			configHash: computeConfigHash(DEFAULT_SECRET_SCANNER_CONFIG),
			configJson: DEFAULT_SECRET_SCANNER_CONFIG as unknown as Record<string, unknown>,
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
				(ctx.config.configJson as unknown as SecretScannerConfig) ?? DEFAULT_SECRET_SCANNER_CONFIG;
			// Re-read messages from the DB rather than the (possibly stale) plan-time
			// list, matching the other detectors' pattern.
			const messages = await ctx.getSessionMessages(ctx.sessionId);
			const scan: SecretScannerScanResult = detectArtifactLeaks(messages, config);

			const properties: SecretScannerProperties = {
				session_id: ctx.sessionId,
				has_leaks: scan.leak_count > 0,
				leak_count: scan.leak_count,
				leaks: scan.leaks,
				truncated_matches: scan.truncated_matches,
				allowlisted_matches: scan.allowlisted_matches,
				rule_counts: scan.rule_counts,
				artifact_counts: scan.artifact_counts,
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
}

/** The production analyzer instance registered by default. */
export const secretScannerAnalyzer: Analyzer = makeSecretScannerAnalyzer();

// Re-export the public surface so consumers (and tests) import it from one place.
export {
	DEFAULT_SECRET_SCANNER_CONFIG,
	assertKnownRuleIds,
	SecretScannerConfigSchema,
	type SecretScannerConfig,
} from "./config.js";
export {
	ARTIFACT_CATALOGUE_RULES,
	ARTIFACT_CATALOGUE_RULE_IDS,
	STRUCTURAL_RULE_ID,
	detectArtifactLeaks,
	hasCredentialShape,
	type SecretScannerFinding,
	type SecretScannerScanResult,
} from "./detectors.js";
export {
	extractArtifactCandidates,
	extractContainerfileCandidates,
	extractDotenvCandidates,
	extractBuildLogCandidates,
	extractCiLogCandidates,
	extractShellExportCandidates,
	ARTIFACT_KINDS,
	type ArtifactCandidate,
	type ArtifactKind,
} from "./extractors.js";
export { fingerprintOf, redact } from "../secret-scanner.js";
