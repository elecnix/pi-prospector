/**
 * git-commands — the commits, pushes and pull request merges a session ran.
 *
 * One session-anchored metric node per session lists each git command event
 * (commit, push, pull request merge) with its time and whether it worked, plus
 * counts per kind, anchored to the session and to each call. A session that ran
 * none gets an empty list, so a monthly rate keeps its denominator.
 *
 * A commit says the session ran `git commit` and the command worked. It never
 * says the work was right, and the system still assigns no outcome to a
 * session. Opening a pull request is `pr-opened`'s record, and a reader joins
 * the two. Deterministic, no LLM, and it proposes nothing.
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
import { DEFAULT_GIT_COMMANDS_CONFIG, type GitCommandsConfig } from "./config.js";
import { findGitCommandEvents } from "./detect.js";

const KIND = Type.Union([Type.Literal("commit"), Type.Literal("push"), Type.Literal("pr_merge")]);

export const GIT_COMMAND_EVENT = Type.Object({
	kind: KIND,
	succeeded: Type.Boolean(),
	result_checked: Type.Boolean(),
	at: Type.Union([Type.String(), Type.Null()]),
	call_message_id: Type.String(),
	result_message_id: Type.Union([Type.String(), Type.Null()]),
});

const KIND_COUNTS = Type.Object({ attempted: Type.Number(), succeeded: Type.Number() });

/** The properties a git-commands node carries in its `contentJson`. */
export const GIT_COMMANDS_PROPERTIES = Type.Object({
	session_id: Type.String(),
	events: Type.Array(GIT_COMMAND_EVENT),
	commit: KIND_COUNTS,
	push: KIND_COUNTS,
	pr_merge: KIND_COUNTS,
});
export type GitCommandsProperties = Static<typeof GIT_COMMANDS_PROPERTIES>;

export const GIT_COMMANDS_DEF: AnalyzerDef = {
	id: "git-commands",
	label: "Git Commands (deterministic)",
	description:
		"Records the commits, pushes and pull request merges a session ran: each with its time and whether it worked, plus counts per kind. A success the host reported is checked against the result text, since git can refuse with exit 0 and a pipe hides the status. A session that ran none gets an empty list. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: GIT_COMMANDS_PROPERTIES,
};

export const GIT_COMMANDS_VERSION: AnalyzerVersion = {
	analyzerId: GIT_COMMANDS_DEF.id,
	// 1.0: commit, push, and pull request merge events from the shell.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/git-commands/index.ts",
};

function resolveConfig(raw: unknown): GitCommandsConfig {
	return { ...DEFAULT_GIT_COMMANDS_CONFIG, ...((raw as Partial<GitCommandsConfig> | null | undefined) ?? {}) };
}

/** Fingerprint of what the detection reads: ids, roles, calls, results, and result texts. */
function gitCommandsFingerprint(messages: readonly MessageRow[]): string {
	return shortHash(
		messages
			.map((m) =>
				[
					m.id,
					m.role,
					m.timestamp ?? "",
					m.tool_calls ? shortHash(m.tool_calls) : "",
					m.tool_results ? shortHash(m.tool_results) : "",
					m.content_text ? shortHash(m.content_text) : "",
				].join(":"),
			)
			.join("\n"),
	);
}

export const gitCommandsAnalyzer: Analyzer = {
	def: GIT_COMMANDS_DEF,
	version: GIT_COMMANDS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: GIT_COMMANDS_DEF.id,
		configHash: computeConfigHash(DEFAULT_GIT_COMMANDS_CONFIG),
		configJson: DEFAULT_GIT_COMMANDS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`git-commands(${ctx.sessionId}|${gitCommandsFingerprint(ctx.messages)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const events = findGitCommandEvents(messages, config);
		const count = (kind: "commit" | "push" | "pr_merge") => {
			const of = events.filter((e) => e.kind === kind);
			return { attempted: of.length, succeeded: of.filter((e) => e.succeeded).length };
		};

		const properties: GitCommandsProperties = {
			session_id: ctx.sessionId,
			events,
			commit: count("commit"),
			push: count("push"),
			pr_merge: count("pr_merge"),
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...[...new Set(events.map((e) => e.call_message_id))].map((id, i) => ({
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
