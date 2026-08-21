/**
 * presidio — the Presidio-method PII detector analyzer.
 *
 * Licence (issue #173): Microsoft Presidio is Apache-2.0. Only its *method*
 * is implemented here — pattern recognizers with mandatory checksum
 * validators, confidence scoring, and per-entity allow/deny lists. No
 * upstream code or rule text was vendored or ported. Reference
 * implementation studied: `microsoft/presidio` (Apache-2.0), 2.2 series.
 *
 * This is the first **PII** detector in the stack (the previous five find
 * credentials). It extends coverage from secrets to private data: emails,
 * phone numbers, IP addresses, card numbers, IBANs, SSNs, postal codes, and
 * coordinates. **NER-based detection (person names, addresses) is deferred**
 * per the issue's option (b): v1 ships pattern+checksum recognizers only —
 * fully deterministic, zero model cost, and the checksum validators alone
 * catch credit cards, IBANs, and similar with near-zero false positives. The
 * recognizer registry (`recognizers.ts`) is shaped so a later NER recognizer
 * can join through the LLM seam (deterministic candidates gating a structured
 * model pass) without reshaping config identity.
 *
 * Scans the same four message fields as the other detectors (`content_text`,
 * `content_thinking`, `tool_calls`, `tool_results`) and emits one `metric`
 * node per session. No LLM; no subprocess; no model.
 *
 * The analyzer is **standalone** — it declares no dependencies and reads the
 * session's raw messages directly. Its unit identity folds in every message
 * id in the session, so a session that grows new turns re-identifies and is
 * re-scanned on the next run.
 *
 * Redaction invariant: a finding carries `message_id`, the entity type, a
 * redacted preview, and a short SHA-256 fingerprint of the matched value —
 * derived identically to the secret detectors (`fingerprintOf`), so the
 * cross-detector `(credential fingerprint, message_id)` grouping of the
 * single-proposal-per-leak contract applies unchanged. A person's name has no
 * checksum; its fingerprint is still what dedups and allowlists. The matched
 * value itself is never stored. Per that contract this analyzer emits **metric
 * nodes only**; grouping findings into one proposal — including collapsing
 * across detectors — is the downstream synthesiser's job.
 *
 * The node anchors to the session, plus one `anchors` edge per message that
 * contained a finding, so `prospect show` can walk a finding back to the
 * exact turn.
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
import { DEFAULT_PRESIDIO_CONFIG, type PresidioConfig } from "./config.js";
import { detectPii, type PiiFinding, type PiiScanResult } from "./detectors.js";

export const PRESIDIO_DEF: AnalyzerDef = {
	id: "presidio",
	label: "PII Detection (Presidio-method)",
	description:
		"Detects personally identifiable information in session transcripts with Presidio-method pattern recognizers and mandatory checksum validators (Luhn credit cards, mod-97 IBANs, SSN validity rules), scored and filtered per entity type. NER deferred — deterministic only. Apache-2.0 method port; no upstream code. Never stores the matched value.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const PRESIDIO_VERSION: AnalyzerVersion = {
	analyzerId: PRESIDIO_DEF.id,
	// 1.0: initial version — eight pattern recognizers (email, phone, IP,
	// credit card, IBAN, US SSN, postal code, coordinates) with mandatory
	// checksum validators where the format has one, fingerprint-based
	// allow/deny lists, and per-field capping. NER deferred (issue option b).
	// Standalone, deterministic, metric nodes only.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/presidio/index.ts",
};

export interface PresidioProperties {
	/** Session id this analysis covers. */
	session_id: string;
	/** Convenience boolean: were any PII findings recorded? */
	has_pii: boolean;
	/** Total findings, after deny/allow/score filtering and capping. */
	pii_count: number;
	/** The findings, capped at `maxMatchesPerField` per field. */
	piis: PiiFinding[];
	/** Matches dropped for exceeding `maxMatchesPerField` in a field. */
	truncated_matches: number;
	/** Matches dropped by the allowlist (fingerprint or pattern). */
	allowlisted_matches: number;
	/** Matches below the configured score floor (deny-listed values excepted). */
	below_score_matches: number;
	/** Candidates dropped by a mandatory checksum validator. */
	invalid_matches: number;
	/** Candidates subsumed by a longer overlapping match. */
	overlap_matches: number;
	/** Findings per entity type. */
	entity_counts: Record<string, number>;
	/** Distinct message ids that contained at least one finding. */
	affected_message_ids: string[];
	/** Total messages scanned. */
	message_count: number;
}

// ──────────────────────────── analyzer ────────────────────────────

/**
 * Build the analyzer. The seam exists for symmetry with the other detectors
 * and for future injection (a NER recognizer's model pass would arrive here);
 * detection is fully deterministic, so production and tests share behaviour.
 */
export function makePresidioAnalyzer(): Analyzer {
	return {
		def: PRESIDIO_DEF,
		version: PRESIDIO_VERSION,
		prompts: {} as Record<string, PromptVersion>,
		defaultConfig: {
			id: "",
			analyzerId: PRESIDIO_DEF.id,
			configHash: computeConfigHash(DEFAULT_PRESIDIO_CONFIG),
			configJson: DEFAULT_PRESIDIO_CONFIG as unknown as Record<string, unknown>,
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
				(ctx.config.configJson as unknown as PresidioConfig) ?? DEFAULT_PRESIDIO_CONFIG;
			// Re-read messages from the DB rather than the (possibly stale) plan-time
			// list, matching the other detectors' pattern.
			const messages = ctx.getSessionMessages(ctx.sessionId);
			const scan: PiiScanResult = detectPii(messages, config);

			const properties: PresidioProperties = {
				session_id: ctx.sessionId,
				has_pii: scan.pii_count > 0,
				pii_count: scan.pii_count,
				piis: scan.piis,
				truncated_matches: scan.truncated_matches,
				allowlisted_matches: scan.allowlisted_matches,
				below_score_matches: scan.below_score_matches,
				overlap_matches: scan.overlap_matches,
				invalid_matches: scan.invalid_matches,
				entity_counts: scan.entity_counts,
				affected_message_ids: scan.affected_message_ids,
				message_count: messages.length,
			};

			// Anchor to the session (ordinal 0), then to each message that contained
			// a finding so it is traceable to the exact turn.
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

/** The production analyzer instance registered by default (enabled). */
export const presidioAnalyzer: Analyzer = makePresidioAnalyzer();
export { detectPii, type PiiFinding, type PiiScanResult } from "./detectors.js";
export {
	DEFAULT_PRESIDIO_CONFIG,
	assertKnownEntityTypes,
	PresidioConfigSchema,
	type PresidioConfig,
} from "./config.js";
export {
	PII_RECOGNIZERS,
	PII_ENTITY_TYPES,
	PII_SEVERITY_RANK,
	luhnValid,
	ibanMod97Valid,
	ssnValid,
	isPrivateIPv4,
	isLowSensitivityIPv6,
	coordinatesValid,
	judge,
	type PiiEntityType,
	type PiiSeverity,
	type PiiRecognizer,
} from "./recognizers.js";
export { fingerprintOf, redact } from "../secret-scanner.js";
