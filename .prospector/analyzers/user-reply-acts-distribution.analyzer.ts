/**
 * user-reply-acts-distribution — deterministic session-level roll-up of the
 * user-reply-acts classifier.
 *
 * The classifier emits one multi-act node per user reply. This analyzer folds
 * those nodes into a single session-level distribution: counts of each act and
 * purpose, plus the acceptance/refusal balance. That is the shape you need to
 * answer "what is the distribution of acceptance, refusal, and
 * under-explanation questions in this session?" — the classifier's per-reply
 * nodes are the evidence; this node is the summary.
 *
 * It depends on `user-reply-acts` and consumes its nodes for the session. It is
 * deterministic (no LLM). One `metric` node per session, anchored to the session.
 */

import { defineAnalyzer } from "../../src/analyze/authoring.js";
import type {
	Analyzer,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalysisResult,
	AnalysisUnit,
	SourceRef,
	EdgeSpec,
} from "../../src/analyze/types.js";
import { computeSourceSetHash, computeConfigHash } from "../../src/analyze/input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";
import type { UserReplyActsProperties, AcceptanceAct, RefusalAct, QuestionAct } from "./user-reply-acts.analyzer.js";

const USER_REPLY_ACTS_ID = "user-reply-acts";

interface DistributionProperties {
	session_id: string;
	/** Number of user replies classified (the population). */
	replies_classified: number;
	/** Count of replies with ≥1 acceptance act. */
	replies_with_acceptance: number;
	/** Count of replies with ≥1 refusal act. */
	replies_with_refusal: number;
	/** Count of replies with ≥1 question of any purpose. */
	replies_with_question: number;
	/** Count of replies with ≥1 clarify question (the under-explanation signal). */
	replies_with_clarify_question: number;
	/** Count of replies with ≥1 answer to an assistant question. */
	replies_with_answer: number;
	/** Count of replies flagged continuation. */
	replies_continuation: number;
	/** Count of replies flagged other. */
	replies_other: number;
	/** Count of replies with ≥1 command act. */
	replies_with_command: number;
	/** Count of replies with ≥1 information_provision act. */
	replies_with_information_provision: number;
	/** Count of replies where the model abstained (retry only). */
	replies_abstained: number;
	/** Total acceptance acts by level. */
	acceptances_by_level: { full: number; partial: number };
	/** Total refusal acts by level. */
	refusals_by_level: { full: number; partial: number };
	/** Total questions by purpose. */
	questions_by_purpose: { request: number; decision: number; clarify: number; information: number };
	/** Total answer acts. */
	total_answers: number;
	/**
	 * Acceptance-to-refusal ratio: acceptances / (acceptances + refusals), or null
	 * when neither was observed. A session-level balance indicator.
	 */
	acceptance_refusal_ratio: number | null;
	/** Output keys of the per-reply nodes this distribution was built from. */
	source_output_keys: string[];
}

function emptyDist(sessionId: string): DistributionProperties {
	return {
		session_id: sessionId,
		replies_classified: 0,
		replies_with_acceptance: 0,
		replies_with_refusal: 0,
		replies_with_question: 0,
		replies_with_clarify_question: 0,
		replies_with_answer: 0,
		replies_continuation: 0,
		replies_other: 0,
		replies_with_information_provision: 0,
		replies_with_command: 0,
		replies_abstained: 0,
		acceptances_by_level: { full: 0, partial: 0 },
		refusals_by_level: { full: 0, partial: 0 },
		questions_by_purpose: { request: 0, decision: 0, clarify: 0, information: 0 },
		total_answers: 0,
		acceptance_refusal_ratio: null,
		source_output_keys: [],
	};
}

/** Build the distribution from parsed per-reply properties. Exported for tests. */
export function rollUp(sessionId: string, replies: UserReplyActsProperties[]): DistributionProperties {
	const d = emptyDist(sessionId);
	for (const r of replies) {
		d.replies_classified++;
		if (r.acceptances.length > 0) d.replies_with_acceptance++;
		if (r.refusals.length > 0) d.replies_with_refusal++;
		if (r.questions.length > 0) d.replies_with_question++;
		if (r.questions.some((q) => q.purpose === "clarify")) d.replies_with_clarify_question++;
		if (r.answers.length > 0) d.replies_with_answer++;
		if (r.continuation) d.replies_continuation++;
		if (r.other) d.replies_other++;
		if (r.information_provisions?.length > 0) d.replies_with_information_provision++;
		if (r.commands?.length > 0) d.replies_with_command++;
		if (r.abstention) d.replies_abstained++;
		for (const a of r.acceptances as AcceptanceAct[]) d.acceptances_by_level[a.level]++;
		for (const f of r.refusals as RefusalAct[]) d.refusals_by_level[f.level]++;
		for (const q of r.questions as QuestionAct[]) d.questions_by_purpose[q.purpose]++;
		d.total_answers += r.answers.length;
		d.source_output_keys.push(/* r.prior_core_output_key is the node's own key; use user_message_id as a stable ref */ r.user_message_id);
	}
	const totalAcc = d.acceptances_by_level.full + d.acceptances_by_level.partial;
	const totalRef = d.refusals_by_level.full + d.refusals_by_level.partial;
	d.acceptance_refusal_ratio = totalAcc + totalRef > 0 ? totalAcc / (totalAcc + totalRef) : null;
	return d;
}

const analyzer: Analyzer = {
	def: {
		id: "user-reply-acts-distribution",
		label: "User Reply Acts Distribution (deterministic, session-level)",
		description:
			"Folds the per-reply user-reply-acts classifications into a session-level distribution: counts of each act and question purpose, acceptance/refusal balance. One metric node per session.",
		anchorSpan: "full_session",
		dependencies: [USER_REPLY_ACTS_ID],
	},
	version: {
		analyzerId: "user-reply-acts-distribution",
		major: 1,
		minor: 0,
		implementationKind: "deterministic",
		codeRef: ".prospector/analyzers/user-reply-acts-distribution.analyzer.ts",
	},
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: "user-reply-acts-distribution",
		configHash: computeConfigHash({}),
		configJson: {},
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// Only produce a unit if there is at least one user-reply-acts node.
		const depNodes = ctx.dependencyNodes[USER_REPLY_ACTS_ID] ?? [];
		if (depNodes.length === 0) return [];
		// The source set includes the classifier output keys this roll-up consumes,
		// so a changed classification re-identifies this node (missing) instead of
		// being silently reused — the Merkle-DAG contract.
		const sources: SourceRef[] = [
			{ kind: "session", id: ctx.sessionId },
			...depNodes.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
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

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const depNodes = ctx.getDependencyNodes(USER_REPLY_ACTS_ID);
		const replies: UserReplyActsProperties[] = [];
		const consumedKeys: string[] = [];
		for (const n of depNodes) {
			if (n.node_kind !== "classification") continue;
			try {
				const p = JSON.parse(n.content_json) as UserReplyActsProperties;
				replies.push(p);
				consumedKeys.push(n.output_key);
			} catch {
				/* skip malformed */
			}
		}
		const dist = rollUp(ctx.sessionId, replies);
		// Replace the placeholder refs with the real consumed output keys.
		dist.source_output_keys = consumedKeys;

		const edges: EdgeSpec[] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		for (let i = 0; i < consumedKeys.length; i++) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: consumedKeys[i]!, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 + i });
		}

		return {
			nodeKind: "metric",
			contentJson: dist as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: unit.anchorRef,
			edges,
		};
	},
};

export default defineAnalyzer(analyzer);