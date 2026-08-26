/**
 * phase-trajectory — deterministic plan-compliance signals from a phase
 * sequence (issue #115, after LivePlan's Langutory).
 *
 * Every turn of the session maps to exactly one problem-solving phase —
 * navigate | reproduce | patch | validate | other — and drift is read from the
 * resulting sequence: premature patching, skipped validation, sessions that
 * never patch, phases out of canonical order, and prolonged same-phase
 * stagnation. One `metric` node per session, anchored to the session, beside
 * tool-trajectory's trajectory signals. No LLM.
 *
 * The node content is deliberately kept a clean, stable record — the full
 * phase sequence plus its signals — so companion analyzers (issue #121's
 * plan-compliance scores PPC/POC/PPF/PC) can consume it without reshaping it.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import {
	DEFAULT_PHASE_TRAJECTORY_CONFIG,
	type PhaseTrajectoryConfig,
} from "./config.js";
import {
	classifyTurnPhases,
	detectPhaseSignals,
	PhaseEntrySchema,
	PhaseSignalSchema,
} from "./classify.js";
import { Type, type Static } from "typebox";

export const PhaseTrajectoryProperties = Type.Object({
	/** Session id this analysis covers. */
	session_id: Type.String(),
	/** The session's classified phase sequence, one entry per turn. */
	phases: Type.Array(PhaseEntrySchema),
	/** All plan-compliance and stagnation signals detected. */
	signals: Type.Array(PhaseSignalSchema),
	/** Counts per signal kind. */
	signal_counts: Type.Record(Type.String(), Type.Number()),
	/** How many signals are plan violations (the rest are inefficiency). */
	plan_violation_count: Type.Number(),
	/** Longest run of consecutive same-phase turns in the session. */
	longest_phase_run: Type.Number(),
	/** Total turns classified. */
	turn_count: Type.Number(),
	/** Whether the session ever reached the patch phase. */
	patched: Type.Boolean(),
});
export type PhaseTrajectoryProperties = Static<typeof PhaseTrajectoryProperties>;

export const PHASE_TRAJECTORY_DEF: AnalyzerDef = {
	id: "phase-trajectory",
	label: "Phase Trajectory (deterministic)",
	description:
		"Maps each turn to a problem-solving phase (navigate/reproduce/patch/validate/other) and detects plan violations (premature patching, skip-validation, no-patch-termination, phase-order-violation) and prolonged stagnation from the phase sequence (#115). No LLM.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id],
	outputSchema: PhaseTrajectoryProperties,
};

export const PHASE_TRAJECTORY_VERSION: AnalyzerVersion = {
	analyzerId: PHASE_TRAJECTORY_DEF.id,
	// 1.0 (issue #115): per-turn phase classification over turn-pair-core's
	// conversation view, reusing tool-trajectory's read-only/mutating argument
	// parser; five deterministic signals over the phase sequence. Node content
	// kept minimal and stable for the #121 plan-compliance-score consumers.
	//
	// 1.1 (issue #119): every signal now carries a `riskClass`
	// ("blocking" | "non-blocking"), mirroring tool-trajectory's TrajectorySignal.
	// Output gains a field; detection semantics are unchanged. Minor: additive
	// shape change, no new weighting path — phase signals feed no friction score.
	major: 1,
	minor: 1,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/phase-trajectory/index.ts",
};

function resolveConfig(raw: unknown): PhaseTrajectoryConfig {
	return (raw as PhaseTrajectoryConfig) ?? DEFAULT_PHASE_TRAJECTORY_CONFIG;
}

// ─────────────────────────── analyzer ───────────────────────────

export const phaseTrajectoryAnalyzer: Analyzer = {
	def: PHASE_TRAJECTORY_DEF,
	version: PHASE_TRAJECTORY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: PHASE_TRAJECTORY_DEF.id,
		configHash: computeConfigHash(DEFAULT_PHASE_TRAJECTORY_CONFIG),
		configJson: DEFAULT_PHASE_TRAJECTORY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// One unit per session, consuming turn-pair-core nodes.
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		if (coreNodes.length === 0 && ctx.messages.length === 0) return [];

		const sources: SourceRef[] = [
			...coreNodes.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];
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
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const entries = classifyTurnPhases(messages as unknown as MessageRow[], config);
		const signals = detectPhaseSignals(entries, config);

		const signalCounts: Record<string, number> = {};
		for (const s of signals) {
			signalCounts[s.signal] = (signalCounts[s.signal] ?? 0) + 1;
		}

		let longestRun = 0;
		let runLength = 0;
		for (let i = 0; i < entries.length; i++) {
			runLength =
				i > 0 && entries[i]!.phase === entries[i - 1]!.phase ? runLength + 1 : 1;
			if (runLength > longestRun) longestRun = runLength;
		}

		const properties: PhaseTrajectoryProperties = {
			session_id: ctx.sessionId,
			phases: entries.map((e) => ({
				turn_index: e.turnIndex,
				phase: e.phase,
				user_message_id: e.userMessageId,
				message_ids: e.messageIds,
				sample_commands: e.sampleCommands,
			})),
			signals,
			signal_counts: signalCounts,
			plan_violation_count: signals.filter((s) => s.plan_violation).length,
			longest_phase_run: longestRun,
			turn_count: entries.length,
			patched: entries.some((e) => e.phase === "patch"),
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		const coreNodes = await ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id);
		for (const n of coreNodes) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: n.output_key, edgeKind: EDGE_KINDS.CONSUMES, ordinal: ordinal++ });
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
