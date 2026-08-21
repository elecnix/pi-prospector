/**
 * TruffleHog-style detectors: the self-written catalogue (`rules.ts`) applied
 * to a session's message stream through the shared secret-scanning engine,
 * plus the opt-in live-verification pass.
 *
 * Detection is pure and deterministic. Verification (only when config turns it
 * on) recovers the raw candidate value of each emitted finding — by re-walking
 * the engine's identical deterministic candidate stream, never by storing
 * values — and hands each value to the one verifier whose provider-prefix
 * shape matches. A credential is therefore sent to exactly one endpoint, the
 * provider that issued it. Outcomes attach to findings as
 * `{ verified, reason }`; the value itself is discarded after the call and is
 * never written to the graph.
 */

import type { MessageRow } from "../../types.js";
import { Type, type Static } from "typebox";
import {
	scanMessages,
	scanFieldCandidates,
	LeakField,
	SecretLeakFinding,
	SecretLeakScanResult,
} from "../secret-scanner.js";
import { TRUFFLEHOG_RULES } from "./rules.js";
import { DEFAULT_TRUFFLEHOG_CONFIG, assertKnownRuleAndVerifierIds, type TruffleHogConfig } from "./config.js";
import type { CredentialVerifier, VerificationOutcome } from "./verifiers.js";
import { VERIFICATION_OUTCOME_SCHEMA } from "./verifiers.js";

// Re-export the shared engine surface so consumers import the detector
// vocabulary from this module.
export {
	fingerprintOf,
	redact,
	meetsMinSeverity,
	SEVERITY_RANK,
	LeakField,
	type LeakSeverity,
	SecretLeakFinding,
	type SecretLeakRule,
	SecretLeakScanResult,
} from "../secret-scanner.js";
export { TRUFFLEHOG_RULES, TRUFFLEHOG_RULE_IDS, TRUFFLEHOG_CONCEPT } from "./rules.js";
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

/** A finding, optionally carrying its live-verification outcome. */
export const TruffleHogFinding = Type.Object({
	...SecretLeakFinding.properties,
	/** Present only when `verify` was on and a verifier claimed the value's shape. */
	verification: Type.Optional(VERIFICATION_OUTCOME_SCHEMA),
});
export type TruffleHogFinding = Static<typeof TruffleHogFinding>;

/**
 * Detect secret leaks across a session's messages with the self-written
 * catalogue. Pure and deterministic.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (defaults applied for missing keys)
 */
export function detectTrufflehogLeaks(
	messages: readonly MessageRow[],
	config: TruffleHogConfig = DEFAULT_TRUFFLEHOG_CONFIG,
): SecretLeakScanResult {
	assertKnownRuleAndVerifierIds(config);
	return scanMessages(messages, TRUFFLEHOG_RULES, config);
}

// ──────────────────────────── verification ────────────────────────────

/** The fields the shared engine scans, mirroring its SCAN_FIELDS order. */
const SCAN_FIELDS: ReadonlyArray<{ row: keyof MessageRow; label: LeakField }> = [
	{ row: "content_text", label: "content_text" },
	{ row: "content_thinking", label: "content_thinking" },
	{ row: "tool_calls", label: "tool_calls" },
	{ row: "tool_results", label: "tool_results" },
];

/** Stable key joining an emitted finding back to its raw candidate value. */
function candidateKey(messageId: string, field: LeakField, ruleId: string, index: number): string {
	return `${messageId}\u0000${field}\u0000${ruleId}\u0000${index}`;
}

/**
 * Re-walk the deterministic candidate stream the shared engine walked when it
 * emitted `scan.leaks`, recovering the raw value behind each finding. The
 * engine's candidate order is deterministic, so (message, field, rule, index)
 * identifies a candidate exactly — and the raw value never has to be stored
 * anywhere to be recovered.
 */
function recoverCandidateValues(
	messages: readonly MessageRow[],
): Map<string, string> {
	const values = new Map<string, string>();
	for (const m of messages) {
		for (const { row, label } of SCAN_FIELDS) {
			const raw = m[row];
			if (typeof raw !== "string" || raw.length === 0) continue;
			for (const hit of scanFieldCandidates(raw, TRUFFLEHOG_RULES)) {
				values.set(candidateKey(m.id, label, hit.rule.id, hit.index), hit.value);
			}
		}
	}
	return values;
}

/** Summary of one verification pass over a scan's findings. */
export const VerificationSummary = Type.Object({
	/** Findings the provider confirmed as live credentials. */
	verified_true: Type.Number(),
	/** Findings the provider explicitly rejected. */
	verified_false: Type.Number(),
	/** Findings whose verification could not be determined (network error, timeout, unexpected status). */
	verified_unknown: Type.Number(),
	/** Findings with a shape no enabled verifier claims. */
	unverified: Type.Number(),
	/** Actual network probes issued (distinct value+verifier pairs; repeats reuse the first outcome). */
	probes_issued: Type.Number(),
});
export type VerificationSummary = Static<typeof VerificationSummary>;

/**
 * Verify a scan's findings against their issuing providers.
 *
 * Each finding's raw value is matched against the enabled verifiers'
 * `appliesTo` shapes; the first claiming verifier probes the provider. A
 * distinct (verifier, fingerprint) pair is probed at most once per pass — the
 * same credential leaking twice is verified once and both findings share the
 * outcome. Verifier promises are awaited sequentially so a probe burst never
 * fans out; verification never throws.
 */
export async function verifyFindings(
	messages: readonly MessageRow[],
	scan: SecretLeakScanResult,
	config: TruffleHogConfig,
	verifiers: readonly CredentialVerifier[],
): Promise<{ findings: TruffleHogFinding[]; summary: VerificationSummary }> {
	const values = recoverCandidateValues(messages);
	const enabled = config.enabledVerifiers.length === 0
		? verifiers
		: verifiers.filter((v) => config.enabledVerifiers.includes(v.id));

	// Cache probes by (verifier id, fingerprint): same credential, same verdict.
	const probeCache = new Map<string, VerificationOutcome>();
	const summary: VerificationSummary = {
		verified_true: 0,
		verified_false: 0,
		verified_unknown: 0,
		unverified: 0,
		probes_issued: 0,
	};

	const findings: TruffleHogFinding[] = [];
	for (const leak of scan.leaks) {
		const out: TruffleHogFinding = { ...leak };
		const value = values.get(candidateKey(leak.message_id, leak.field, leak.rule_id, leak.match_index));
		const verifier = value === undefined
			? undefined
			: enabled.find((v) => new RegExp(v.appliesTo, "u").test(value));

		if (!verifier || value === undefined) {
			summary.unverified++;
			findings.push(out);
			continue;
		}

		const cacheKey = `${verifier.id}\u0000${leak.fingerprint}`;
		let outcome = probeCache.get(cacheKey);
		if (!outcome) {
			outcome = await verifier.verify(value, config.timeoutMs);
			probeCache.set(cacheKey, outcome);
			summary.probes_issued++;
		}
		out.verification = outcome;
		if (outcome.verified === true) summary.verified_true++;
		else if (outcome.verified === false) summary.verified_false++;
		else summary.verified_unknown++;
		findings.push(out);
	}

	return { findings, summary };
}
