/**
 * stale-verification — passing test, lint, and gate runs that a later edit
 * threw away.
 *
 * time-economy reports where a session's time went; this analyzer reports the
 * part of it spent verifying a tree that then changed before anything used the
 * result. A slow gate that passes and is then invalidated by one more edit is
 * paid for twice, or not at all if the commit takes the edit unverified. The
 * cause decides the fix: the agent editing after its own full run calls for
 * running the slow check last, and reviewer findings arriving after the run
 * call for reviewing first.
 *
 * Deterministic, no LLM. Detection rules are documented in `detect.ts`.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	IdentityReader,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { DEFAULT_STALE_VERIFICATION_CONFIG, type StaleVerificationConfig } from "./config.js";
import { StaleScanSchema, findStaleVerifications, type StaleCause, type StaleScan } from "./detect.js";
import {
	VERIFICATION_COMMANDS_DEF,
	judgedSetFingerprint,
	verificationCommandsByCommand,
	type VerificationCommandProperties,
} from "../verification-commands/index.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const StaleVerificationRawProposal = Type.Object({
	target_type: Type.String(),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type StaleVerificationRawProposal = Static<typeof StaleVerificationRawProposal>;

/** The properties a stale-verification node carries in its `contentJson`. */
export const STALE_VERIFICATION_PROPERTIES = Type.Object({
	session_id: Type.String(),
	...StaleScanSchema.properties,
	improvement_proposals: Type.Array(StaleVerificationRawProposal),
});
export type StaleVerificationProperties = Static<typeof STALE_VERIFICATION_PROPERTIES>;

export const STALE_VERIFICATION_DEF: AnalyzerDef = {
	id: "stale-verification",
	label: "Stale Verification (deterministic)",
	description:
		"Finds passing test, lint, build, and gate runs that a later edit made stale before any commit used them, and says what caused the edit (the agent, a human prompt, or a subagent such as a reviewer) and what followed it (a rerun, or a commit with no rerun). Deterministic, no LLM. Proposes a change when the agent's own edits or subagent findings throw away more verification time than the threshold, or when commits repeatedly take unverified edits.",
	anchorSpan: "full_session",
	dependencies: [VERIFICATION_COMMANDS_DEF.id],
	outputSchema: STALE_VERIFICATION_PROPERTIES,
};

export const STALE_VERIFICATION_VERSION: AnalyzerVersion = {
	analyzerId: STALE_VERIFICATION_DEF.id,
	// 1.0: synchronous verification runs, edit tools and in-place shell edits,
	// cause by prompt or subagent, outcome by rerun or commit.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/stale-verification/index.ts",
};

/** The stored config over the defaults, so a partial config cannot leave a threshold undefined. */
export function resolveConfig(raw: unknown): StaleVerificationConfig {
	return { ...DEFAULT_STALE_VERIFICATION_CONFIG, ...((raw as Partial<StaleVerificationConfig> | null | undefined) ?? {}) };
}

/**
 * Fingerprint of everything the detection reads: each message's id, role,
 * timestamp, text, tool calls, and tool results.
 */
function fingerprint(messages: readonly MessageRow[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		lines.push(
			[
				m.id,
				m.role,
				m.timestamp ?? "",
				m.role === "user" && m.content_text ? shortHash(m.content_text) : "",
				m.tool_calls ? shortHash(m.tool_calls) : "",
				m.tool_results ? shortHash(m.tool_results) : "",
			].join(":"),
		);
	}
	return shortHash(lines.join("\n"));
}

const minutes = (seconds: number): number => Math.round(seconds / 60);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function evidenceFor(scan: StaleScan, cause: StaleCause, cap: number): string {
	return scan.stale_runs
		.filter((s) => s.cause === cause)
		.sort((a, b) => b.seconds - a.seconds)
		.slice(0, cap)
		.map((s) => `${s.message_id} (${minutes(s.seconds)} min, edit ${s.edit_message_id})`)
		.join(", ");
}

/** The proposals a scan earns under the configured thresholds. */
export function buildProposals(scan: StaleScan, config: StaleVerificationConfig): StaleVerificationRawProposal[] {
	const proposals: StaleVerificationRawProposal[] = [];
	const count = (cause: StaleCause) => scan.stale_runs.filter((s) => s.cause === cause).length;

	const agentSeconds = scan.stale_seconds_by_cause.agent;
	if (agentSeconds >= config.proposalMinSeconds && count("agent") > 0) {
		const n = count("agent");
		proposals.push({
			target_type: "agents_md",
			title: `${n} passing verification ${plural(n, "run", "runs")} went stale after the agent's own edits`,
			summary:
				`The agent edited files after ${n} passing ${plural(n, "run", "runs")} and before committing, ` +
				`so ${minutes(agentSeconds)} min of verification no longer described the tree it committed.`,
			detail:
				"Run the slow checks (the full test suite, the gate script, the build) once, after the last edit. " +
				"While still editing, run the narrow test for the code being changed. " +
				"Finish follow-up edits such as docs, comments, and formatting before the slow run, not after it.",
			evidence: `Stale runs, longest first: ${evidenceFor(scan, "agent", config.evidenceCap)}`,
			confidence: 0.75,
			severity: "waste",
		});
	}

	const subagentSeconds = scan.stale_seconds_by_cause.subagent;
	if (subagentSeconds >= config.proposalMinSeconds && count("subagent") > 0) {
		const n = count("subagent");
		proposals.push({
			target_type: "agents_md",
			title: `${n} passing verification ${plural(n, "run", "runs")} went stale after a subagent's findings`,
			summary:
				`A subagent ran between ${n} passing ${plural(n, "run", "runs")} and the next edit, ` +
				`and the edits it led to threw away ${minutes(subagentSeconds)} min of verification.`,
			detail:
				"When a review or another subagent can lead to edits, run it before the slow checks, or run both at once and verify only after its findings are addressed. " +
				"Keep the slow run for the tree you intend to commit.",
			evidence: `Stale runs, longest first: ${evidenceFor(scan, "subagent", config.evidenceCap)}`,
			confidence: 0.7,
			severity: "waste",
		});
	}

	const unverified = scan.unverified_commit_count;
	if (unverified >= config.unverifiedCommitProposalMin) {
		const runs = scan.stale_runs.filter((s) => s.outcome === "committed_unverified");
		proposals.push({
			target_type: "agents_md",
			title: `${unverified} commits took edits made after the last passing run, without a rerun`,
			summary:
				`${unverified} times, the agent edited files after its checks passed and committed with no check in between. ` +
				"CI or a reviewer is then the first to see whether those edits broke anything.",
			detail:
				"After the last edit, rerun at least the checks that cover the edited files before committing. " +
				"When the edit cannot affect them (a comment, a doc outside any checked file), say so in the commit message.",
			evidence: runs
				.slice(0, config.evidenceCap)
				.map((s) => `edit ${s.edit_message_id} after run ${s.message_id}`)
				.join(", "),
			confidence: 0.6,
			severity: "medium",
		});
	}

	return proposals;
}

export const staleVerificationAnalyzer: Analyzer = {
	def: STALE_VERIFICATION_DEF,
	version: STALE_VERIFICATION_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: STALE_VERIFICATION_DEF.id,
		configHash: computeConfigHash(DEFAULT_STALE_VERIFICATION_CONFIG),
		configJson: DEFAULT_STALE_VERIFICATION_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * The learned command set is part of this analyzer's config identity.
	 *
	 * A verdict the corpus learned changes which runs this analyzer can see,
	 * so a conclusion drawn under the older set is stale rather than standing
	 * unchallenged. Folding the set's fingerprint into the config fingerprint
	 * marks the nodes for the `config` reason: a plain fill leaves them alone,
	 * and `--revise config` recomputes them with lineage preserved.
	 */
	async identityExtrasAsync(read: IdentityReader): Promise<readonly string[]> {
		const judged = verificationCommandsByCommand(await read(VERIFICATION_COMMANDS_DEF.id));
		return [`learned:${judgedSetFingerprint(judged)}`];
	},
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];
		const fp = fingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#stale=${fp}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`stale-verification(${ctx.sessionId}|${fp})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		// The commands the corpus judged to verify the tree, which the pattern list
		// does not cover. Read across every session, because the judgement belongs
		// to the corpus rather than to the session that first surfaced it.
		const judged = verificationCommandsByCommand(await ctx.getGlobalDependencyNodes(VERIFICATION_COMMANDS_DEF.id));
		const scan = findStaleVerifications(messages, config, new Set(judged.keys()));
		const proposals = buildProposals(scan, config);
		const properties: StaleVerificationProperties = { session_id: ctx.sessionId, ...scan, improvement_proposals: proposals };

		// Anchor the session, each stale run, and the edit that made it stale.
		const anchored = [
			...new Set([...scan.stale_runs.flatMap((s) => [s.message_id, s.edit_message_id]), ...scan.zero_exit_failures.message_ids]),
		];
		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
			...anchored.map((id, i) => ({ toRefKind: REF_KINDS.MESSAGE, toRefId: id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: i + 1 })),
		];

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
