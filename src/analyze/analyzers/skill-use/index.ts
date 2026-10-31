/**
 * skill-use — which skills a session loaded, and how often.
 *
 * The corpus already counts skill calls as a share of tool calls. It does not say
 * which skill. Without identity a reader cannot tell a session that leaned on one
 * skill from one that tried six, or see a skill fall out of use over a month.
 *
 * One session-anchored metric node per session, listing each skill used with its
 * call count, how it was loaded, and how many calls failed, anchored to the
 * session and to the first call of each skill. A session that loaded no skill
 * still gets a node with an empty list, so a monthly rate has an honest
 * denominator. Deterministic, no LLM, and it proposes nothing.
 *
 * It records use, not the rules in force at the time: the instruction corpus is
 * read from disk as it is now, so which skills were *available* in a past session
 * is not recoverable and is not claimed.
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
import { DEFAULT_SKILL_USE_CONFIG, type SkillUseConfig } from "./config.js";
import { summariseSkillUse } from "./detect.js";

export const SKILL_USE_ENTRY = Type.Object({
	name: Type.String(),
	via: Type.Union([Type.Literal("skill_tool"), Type.Literal("skill_file")]),
	calls: Type.Number(),
	failed_calls: Type.Number(),
	first_call_message_id: Type.String(),
});

/** The properties a skill-use node carries in its `contentJson`. */
export const SKILL_USE_PROPERTIES = Type.Object({
	session_id: Type.String(),
	skills: Type.Array(SKILL_USE_ENTRY),
	skill_call_count: Type.Number(),
	distinct_skill_count: Type.Number(),
	tool_call_count: Type.Number(),
});
export type SkillUseProperties = Static<typeof SKILL_USE_PROPERTIES>;

export const SKILL_USE_DEF: AnalyzerDef = {
	id: "skill-use",
	label: "Skill Use (deterministic)",
	description:
		"Records which skills a session loaded and how often: a call to the host's skill tool, or a read of a skill's SKILL.md on a host with no such tool. One session-anchored metric node per session with each skill's name, call count, and failed calls, anchored to the first call of each skill. A session that loaded no skill gets an empty list, so rates have a denominator. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: SKILL_USE_PROPERTIES,
};

export const SKILL_USE_VERSION: AnalyzerVersion = {
	analyzerId: SKILL_USE_DEF.id,
	// 1.0: skill identity and counts from the skill tool and SKILL.md reads.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/skill-use/index.ts",
};

function resolveConfig(raw: unknown): SkillUseConfig {
	return { ...DEFAULT_SKILL_USE_CONFIG, ...((raw as Partial<SkillUseConfig> | null | undefined) ?? {}) };
}

/** Fingerprint of what the detection reads: each row's id, role, calls, and results. */
function skillFingerprint(messages: readonly MessageRow[]): string {
	return shortHash(
		messages
			.map((m) =>
				[
					m.id,
					m.role,
					m.tool_calls ? shortHash(m.tool_calls) : "",
					m.tool_results ? shortHash(m.tool_results) : "",
				].join(":"),
			)
			.join("\n"),
	);
}

export const skillUseAnalyzer: Analyzer = {
	def: SKILL_USE_DEF,
	version: SKILL_USE_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: SKILL_USE_DEF.id,
		configHash: computeConfigHash(DEFAULT_SKILL_USE_CONFIG),
		configJson: DEFAULT_SKILL_USE_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`skill-use(${ctx.sessionId}|${skillFingerprint(ctx.messages)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const summary = summariseSkillUse(messages, config);

		const properties: SkillUseProperties = {
			session_id: ctx.sessionId,
			skills: summary.skills,
			skill_call_count: summary.skills.reduce((n, s) => n + s.calls, 0),
			distinct_skill_count: new Set(summary.skills.map((s) => s.name)).size,
			tool_call_count: summary.tool_call_count,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			// One edge per message: two skills loaded in one step share a call row.
			...[...new Set(summary.skills.map((s) => s.first_call_message_id))].map((id, i) => ({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: i + 1,
			})),
		];

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
