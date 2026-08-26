/**
 * grounded-claims — deterministic turn-anchored consistency checks (issue #100).
 *
 * Every other analyzer judges a session by what people *said* and what tools
 * *reported*. Nothing checked whether what the agent claimed matches what the
 * tools actually returned. This analyzer adds two checks from Real-Time
 * Detection and Repair of LLM Agent Failures (arXiv:2608.02464) — the paper's
 * `total_consistency` and `required_coverage`, minus its live-interrupt half,
 * which needs re-execution and a touched workspace, neither of which this
 * system does:
 *
 *   - **ungrounded-claim** (`total_consistency`) — the assistant states a
 *     concrete fact (number, count, percentage, path, file:line location, line
 *     reference) that appears nowhere in that turn's tool results. A fabricated
 *     result leaves no trace in any existing signal; this is where it becomes
 *     visible. The third paper check (result shape / `tool_contract`) is a
 *     follow-up: we have no tool schemas to check shapes against.
 *
 *   - **unacted-request** (`required_coverage`) — the user's message contains a
 *     concrete actionable request (run the tests, build, open a PR, commit,
 *     push, delete a named path) but no tool call in this or the immediately
 *     following turn actually did it.
 *
 * One analyzer with two check types rather than two analyzers: both are
 * turn-anchored over the same shared action stream and turn construction, emit
 * the same node shape, and share one identity story (issue #100 names them as
 * three checks of one concern). Splitting them would duplicate the turn walk
 * without giving either an independent version lifecycle it needs.
 *
 * Detection is fully deterministic (no LLM, no thresholds); the heuristics live
 * in `detect.ts`. Following the sibling deterministic analyzers'
 * hit-node convention (turn-frustration), each signal is one `metric` node per
 * (turn, signal), anchored to the turn's user message — growth is additive and
 * a future session-overview consumer can declare this analyzer as a dependency
 * without reordering the registry.
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
import { computeConfigHash, computeSourceSetHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import {
	DEFAULT_GROUNDED_CLAIMS_CONFIG,
	type GroundedClaimsConfig,
} from "./config.js";
import {
	scanConsistencySignals,
	type ConsistencySignal,
} from "./detect.js";

export const GROUNDED_CLAIMS_PROPERTIES = Type.Object({
	user_message_id: Type.String(),
	pair_index: Type.Number(),
	signal: Type.Union([
		Type.Literal("ungrounded-claim"),
		Type.Literal("unacted-request"),
	]),
	claim_kind: Type.Union([
		Type.Literal("number"),
		Type.Literal("count"),
		Type.Literal("percentage"),
		Type.Literal("path"),
		Type.Literal("location"),
		Type.Literal("line-ref"),
		Type.Literal("request"),
	]),
	/** The verbatim claim token, or the request trigger sentence excerpt. */
	claim: Type.String(),
	request_type: Type.Union([Type.Null(), Type.String()]),
	/** Human-readable statement of the discrepancy — the evidence itself. */
	detail: Type.String(),
});
export type GroundedClaimsProperties = Static<typeof GROUNDED_CLAIMS_PROPERTIES>;

export const GROUNDED_CLAIMS_DEF: AnalyzerDef = {
	id: "grounded-claims",
	label: "Grounded Claims Consistency Checks (deterministic)",
	description:
		"Checks what the agent claimed against what the tools returned (#100): ungrounded claims (a stated number, path, test count, percentage, or line reference absent from that turn's tool results) and unacted requests (a concrete user request no tool call in this or the following turn satisfied). No LLM, no thresholds; the evidence is the discrepancy itself.",
	anchorSpan: "pair",
	dependencies: [],
	outputSchema: GROUNDED_CLAIMS_PROPERTIES,
};

export const GROUNDED_CLAIMS_VERSION: AnalyzerVersion = {
	analyzerId: GROUNDED_CLAIMS_DEF.id,
	major: 1,
	// 1.0 (issue #100): the first two checks — ungrounded-claim and
	// unacted-request. The third (result shape) waits on tool schemas.
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/grounded-claims/index.ts",
};

function resolveConfig(raw: unknown): GroundedClaimsConfig {
	return (raw as GroundedClaimsConfig) ?? DEFAULT_GROUNDED_CLAIMS_CONFIG;
}

/** Signal kind for the term-kind source ref, mirroring turn-frustration. */
function signalSourceId(sig: ConsistencySignal): string {
	return `${sig.signal}:${sig.claimKind}:${shortHash(sig.claim)}`;
}

export const groundedClaimsAnalyzer: Analyzer = {
	def: GROUNDED_CLAIMS_DEF,
	version: GROUNDED_CLAIMS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: GROUNDED_CLAIMS_DEF.id,
		configHash: computeConfigHash(DEFAULT_GROUNDED_CLAIMS_CONFIG),
		configJson: DEFAULT_GROUNDED_CLAIMS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const config = resolveConfig(ctx.config);
		const signals = scanConsistencySignals(ctx.messages, config);

		return signals.map((sig) => {
			// Sources: the turn's content fingerprint rides inside the message
			// source id, so a re-sync that changes any message of the turn
			// re-identifies the units as missing instead of leaving stale-looking
			// conclusions standing — the same trade files-in-play makes.
			const sources: SourceRef[] = [
				{ kind: "message", id: `${sig.userMessageId}#turn=${sig.turnFingerprint}` },
				{ kind: "term", id: signalSourceId(sig) },
			];
			return {
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: sig.userMessageId,
				meta: sig as unknown as Record<string, unknown>,
			};
		});
	},

	analyze(unit: AnalysisUnit, _ctx: AnalyzerRunContext): AnalysisResult {
		const meta = unit.meta as unknown as ConsistencySignal;
		const properties: GroundedClaimsProperties = {
			user_message_id: meta.userMessageId,
			pair_index: meta.pairIndex,
			signal: meta.signal,
			claim_kind: meta.claimKind,
			claim: meta.claim,
			request_type: meta.requestType,
			detail: meta.detail,
		};
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			edges: [
				{
					toRefKind: REF_KINDS.MESSAGE,
					toRefId: unit.anchorRef,
					edgeKind: EDGE_KINDS.ANCHORS,
					ordinal: 0,
				},
			],
		};
	},
};
