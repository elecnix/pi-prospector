/**
 * session-ending — deterministic classification of how a session ended
 * (issue #102).
 *
 * pi-prospector knows a great deal about what happened *during* a session and
 * nothing about how it finished, so every session's friction is mined on
 * identical terms. Yet the same friction means very different things depending
 * on the ending: corrections in a session that merged a working PR were
 * survivable; the same corrections before the user walked away mid-task point
 * at something that actually blocked them.
 *
 * This analyzer labels each session's ending — `resolved`, `abandoned`,
 * `handed-off`, `errored`, or the conservative default `unclear` — from signals
 * already in the transcript: how the last verification-class command exited,
 * whether the final events are failures, whether the session ends mid-work.
 * Detection rules are documented in `detect.ts`; there are no thresholds to
 * tune toward proposals because **this analyzer proposes nothing**.
 *
 * The label exists to weight ranking only, never to gate detection (the same
 * rule DESIGN.md sets for the learned lexicon). Per the repo's architecture,
 * weighting is a synthesis/display concern: proposal materialisation has no
 * weight axis, and cross-analyzer coupling for it would violate
 * dependency-scoped visibility. So this analyzer emits one session-anchored
 * metric node carrying the label plus its evidence; consumers join on the
 * session anchor at read time — outputs may read any analyzer's nodes without
 * declaring a dependency, and a future session-level synthesiser can declare
 * this analyzer as a proper dependency when it consumes the label upstream of
 * identity. Until such a consumer exists the label is emitted, stored, and
 * verifiable — the measurement first, its uses layered on top.
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
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import {
	DEFAULT_SESSION_ENDING_CONFIG,
	type SessionEndingConfig,
} from "./config.js";
import {
	classifyEnding,
	EndingEvidenceSchema,
	EndingLabelSchema,
} from "./detect.js";

/** The properties a session-ending node carries in its `contentJson`. */
export const SESSION_ENDING_PROPERTIES = Type.Object({
	session_id: Type.String(),
	label: EndingLabelSchema,
	evidence: EndingEvidenceSchema,
	unresolved_tool_call_count: Type.Number(),
	tool_call_count: Type.Number(),
	stop_reason_recorded: Type.Boolean(),
});
export type SessionEndingProperties = Static<typeof SESSION_ENDING_PROPERTIES>;

export const SESSION_ENDING_DEF: AnalyzerDef = {
	id: "session-ending",
	label: "Session Ending (deterministic)",
	description:
		"Labels how each session ended — resolved, abandoned, handed-off, errored, or the conservative unclear — from the transcript tail: how the last verification-class command exited, whether the final events are failures, whether work was cut off mid-stream. Deterministic, no LLM; emits a metric node only, as ranking input for downstream synthesis — it never gates detection.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: SESSION_ENDING_PROPERTIES,
};

export const SESSION_ENDING_VERSION: AnalyzerVersion = {
	analyzerId: SESSION_ENDING_DEF.id,
	// 1.0 (issue #102): tail-of-transcript ending classification over the shared
	// action stream with config-driven verification/closure patterns and the
	// generous `unclear` default.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/session-ending/index.ts",
};

function resolveConfig(raw: unknown): SessionEndingConfig {
	return (raw as SessionEndingConfig) ?? DEFAULT_SESSION_ENDING_CONFIG;
}

/**
 * Fingerprint of everything this analyzer reads: every message's role, id,
 * text length, text hash, and failure flags. Hashing the texts themselves (not
 * just which rows exist) makes a re-sync that backfills content or stop
 * reasons re-identify as missing and recompute — the same trade the other
 * deterministic analyzers make.
 */
function endingFingerprint(messages: readonly MessageRow[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		const text = m.content_text ?? "";
		lines.push(
			`${m.role}:${m.id}:${text.length}:${shortHash(text)}:${m.stop_reason ?? ""}:${m.error_message ? 1 : 0}`,
		);
	}
	return shortHash(lines.join("\n"));
}

export const sessionEndingAnalyzer: Analyzer = {
	def: SESSION_ENDING_DEF,
	version: SESSION_ENDING_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: SESSION_ENDING_DEF.id,
		configHash: computeConfigHash(DEFAULT_SESSION_ENDING_CONFIG),
		configJson: DEFAULT_SESSION_ENDING_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// An empty transcript ends nothing; every non-empty one gets a label.
		if (ctx.messages.length === 0) return [];

		const fingerprint = endingFingerprint(ctx.messages);
		const sources: SourceRef[] = [
			{ kind: "session", id: `${ctx.sessionId}#ending=${fingerprint}` },
		];
		return [
			{
				sources,
				sourceSetHash: shortHash(`session-ending(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = classifyEnding(messages, config);
		if (scan === null) {
			throw new Error(
				`session-ending unit planned but transcript is empty (session ${ctx.sessionId})`,
			);
		}

		const properties: SessionEndingProperties = {
			session_id: ctx.sessionId,
			label: scan.label,
			evidence: scan.evidence,
			unresolved_tool_call_count: scan.unresolved_tool_call_count,
			tool_call_count: scan.tool_call_count,
			stop_reason_recorded: scan.stop_reason_recorded,
		};

		// Anchor to the session (a session-level verdict) and to the exact row
		// the label was decided on, so the evidence trail reaches the message.
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			{ toRefKind: REF_KINDS.MESSAGE, toRefId: scan.evidence.final_message_id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 1 },
		];

		return {
			// Metric, not classification: this is a deterministic measurement of a
			// session, and `classification` is reserved for language-model
			// judgements (DESIGN.md, node kinds).
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
