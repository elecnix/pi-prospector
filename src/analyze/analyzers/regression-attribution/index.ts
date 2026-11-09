import { shortHash } from "../../input-hash.js";
import { contentOf } from "./node-content.js";
import type {
	Analyzer,
	AnalysisNodeRow,
	AnalysisUnit,
	AnalyzerPlanContext,
	AnalyzerRunContext,
} from "../../types.js";
// regression-attribution: the join that turns a claim into a chain.
//
// `regression-signal` writes, on the fix session, the pull requests and commits it
// blames. On its own that is an accusation with no author. This analyzer closes
// the loop: for each blamed pull request it finds the session that opened it, so
// the graph carries a walkable path
//
//     fix session → blamed PR → session that opened it → that session's agent
//
// and a reader can ask the question the corpus could not answer before: which
// earlier piece of work caused this repair, and who or what did that work.
//
// The join is deliberately narrow. It matches on the pull request number within
// one repository, never on a title or a guess, and it only follows PRs some local
// session is known to have opened. A blame it cannot resolve is recorded as
// unresolved rather than dropped, because "we could not find the author" and
// "there is no author" are different facts and only the first is honest.
//
// What it does NOT do, and why:
//
//   - It does not decide whether the blamed change really introduced the defect.
//     That needs the tree (git blame, the merged bodies) and belongs to the
//     verification step, not to a deterministic pass over transcripts.
//   - It does not follow commits to sessions. A commit sha in a transcript rarely
//     carries the repository it belongs to, so a sha→session join would be a
//     guess. Pull request numbers are unambiguous within a repository, so they are
//     the only join performed here.
//
// Deterministic: no model, no network. Reads `regression-signal` nodes and the
// pull request records the `pr-opened` analyzers already wrote.

import {
	attribute,
	attributionHash,
	claimFromNode,
	recordFromNode,
	type PullRequestRecord,
	type AttributionResult,
} from "./detect.js";
import { DEFAULT_REGRESSION_ATTRIBUTION_CONFIG, type RegressionAttributionConfig } from "./config.js";

export const ANALYZER_ID = "regression-attribution";
export const SIGNAL_ANALYZER_ID = "regression-signal";
export const PR_ANALYZER_IDS = ["pr-opened", "pr-opened-script"] as const;

type DependencyNode = AnalysisNodeRow;







/**
 * Read a node's content. The framework hands dependency rows back with
 * `content_json` as a string; a caller that passes an already-parsed object is
 * tolerated so tests can build rows by hand.
 */

export const regressionAttributionAnalyzer: Analyzer = {
	def: {
		id: ANALYZER_ID,
		label: "Regression Attribution (deterministic)",
		description:
			"Joins a regression claim to the pull request it blames and to the session that opened that " +
			"pull request. Reads the `regression-signal` claim on this session and the pull request records " +
			"`pr-opened` and `pr-opened-script` wrote across every session. Matches on pull request number " +
			"within one repository only, refuses an ambiguous number rather than inventing an author, records " +
			"an unresolvable blame as unresolved, and flags a repair of the session's own earlier change as " +
			"self-inflicted. Deterministic, no LLM. It proposes nothing.",
		anchorSpan: "full_session" as const,
		dependencies: [SIGNAL_ANALYZER_ID, ...PR_ANALYZER_IDS] as string[],
		outputSchema: {
			type: "object",
			properties: {
				session_id: { type: "string" },
				resolved_count: { type: "number" },
				unresolved_count: { type: "number" },
				self_inflicted: { type: "boolean" },
				attributions: { type: "array" },
			},
		},
	},
	version: {
		analyzerId: ANALYZER_ID,
		major: 1,
		minor: 0,
		implementationKind: "deterministic" as const,
		codeRef: "src/analyze/analyzers/regression-attribution/index.ts",
	},
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: ANALYZER_ID,
		configHash: "",
		configJson: DEFAULT_REGRESSION_ATTRIBUTION_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * Plan only for a session that makes a claim.
	 *
	 * The unit's identity folds in two things. The claim node id: a recomputed claim (a
	 * new revision of the signal node) must re-identify the attribution, or it keeps
	 * answering against a claim that no longer exists. And the pull request records
	 * this claim's blamed numbers resolve to: a pull request recorded *after* this
	 * session was first analysed turns an unresolved blame into a resolved one, and
	 * without that in the identity the node would stay unresolved for good.
	 */
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const claims = ctx.dependencyNodes[SIGNAL_ANALYZER_ID] ?? [];
		if (claims.length === 0) return [];

		// The newest claim for this session. Dependency reads are newest-last in graph
		// order; take the last, and fall back to the first when order is unknowable.
		const claimNode = claims[claims.length - 1];
		if (!claimNode) return [];
		const claim = claimFromNode(contentOf(claimNode));
		if (!claim) return [];

		// What the blamed numbers resolve to *now*. A number with no record contributes
		// "none", so the transition from unresolved to resolved is a visible change.
		// What the blamed citations resolve to *now*. A qualified citation names its repository,
		// so it resolves against that repository alone and the ambiguity below cannot arise for
		// it. A bare number keeps the rule: one repository and one session resolves, two do not.
		const seen = new Set<string>();
		const targets = claim.cited_pull_requests
			.map((c) => ({
				number: c.number,
				repo: c.owner && c.repo ? `${c.owner}/${c.repo}`.toLowerCase() : null,
			}))
			.filter((t) => {
				const k = t.repo ? `${t.repo}#${t.number}` : `*#${t.number}`;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			})
			.sort((x, y) => x.number - y.number || (x.repo ?? "").localeCompare(y.repo ?? ""));
		const resolution: string[] = [];
		for (const target of targets) {
			let opener = "none";
			try {
				// Each source is read in its own try, as analyze() does: one absent reader must
				// not hide the other's records, or the identity and the content disagree.
				const all: Array<{ id: string; content_json: string | null }> = [];
				for (const id of ["pr-opened", "pr-opened-script"] as const) {
					try {
						all.push(...(await ctx.getGlobalDependencyNodes(id)));
					} catch {
						// Absent reader: the other source still counts.
					}
				}
				const matches = all
					.map((node) => recordFromNode(contentOf(node)))
					.filter(
						(r): r is NonNullable<typeof r> =>
							Boolean(r) &&
							(r as { number: number }).number === target.number &&
							(target.repo === null || `${(r as { owner: string }).owner}/${(r as { repo: string }).repo}`.toLowerCase() === target.repo),
					);
				// Lower-cased, as the match predicate is: one repository recorded under two casings
				// is one repository, not two.
				const repos = new Set(matches.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
				const sessions = new Set(matches.map((r) => r.session_id).filter(Boolean));
				if (repos.size === 1 && sessions.size === 1) {
					// The title and url are copied into the node, so they are part of what the
					// node says; a re-recorded pull request must re-identify it.
					const one = matches[0]!;
					opener = `${one.session_id}|${one.owner}/${one.repo}|${one.title ?? ""}|${one.url ?? ""}`;
				}
			} catch {
				// Nothing resolvable; the key records none.
			}
			resolution.push(`${target.repo ?? "*"}#${target.number}:${opener}`);
		}
		const recordsKey = shortHash(resolution.join(","));

		return [
			{
				sources: [{ kind: "session", id: `${ctx.sessionId}#regression-attribution=${claimNode.id}:${recordsKey}` }],
				sourceSetHash: `regression-attribution(${ctx.sessionId}|${claimNode.id}|${recordsKey})`,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { claim_node_id: claimNode.id, records_key: recordsKey },
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext) {
		const claims = await ctx.getDependencyNodes(SIGNAL_ANALYZER_ID);
		const claimNode = claims[claims.length - 1];
		const claim = claimNode ? claimFromNode(contentOf(claimNode)) : null;

		// Pull request records come from every session, not just this one: the whole
		// point is finding the author of an earlier change.
		const records: PullRequestRecord[] = [];
		for (const id of PR_ANALYZER_IDS) {
			let nodes: DependencyNode[] = [];
			try {
				nodes = await ctx.getGlobalDependencyNodes(id);
			} catch {
				// The analyzer is not installed. The built-in ids always are, but a
				// deployment that removed one must degrade to "no records from it"
				// rather than failing the whole join.
				continue;
			}
			for (const node of nodes) {
				const record = recordFromNode(contentOf(node));
				if (record) records.push(record);
			}
		}

		const empty: AttributionResult = {
			session_id: ctx.sessionId,
			attributions: [],
			cited_commits: [],
			resolved_count: 0,
			unresolved_count: 0,
			self_inflicted: false,
		};
		const result = claim ? attribute(ctx.sessionId, claim, records) : empty;

		const properties = {
			session_id: ctx.sessionId,
			attributions: result.attributions,
			cited_commits: result.cited_commits,
			resolved_count: result.resolved_count,
			unresolved_count: result.unresolved_count,
			self_inflicted: result.self_inflicted,
			hash: attributionHash(result),
		};

		const edges: Array<{ toRefKind: string; toRefId: string; edgeKind: string; ordinal: number }> = [
			{ toRefKind: "session", toRefId: ctx.sessionId, edgeKind: "anchors", ordinal: 0 },
		];
		if (claimNode) {
			edges.push({ toRefKind: "analysis_node", toRefId: claimNode.id, edgeKind: "consumes", ordinal: 1 });
		}
		// Anchor the message that carried each blame, so a reader can walk back to the
		// prose that named the cause.
		let ordinal = 2;
		for (const a of result.attributions) {
			if (!a.message_id) continue;
			edges.push({ toRefKind: "message", toRefId: a.message_id, edgeKind: "anchors", ordinal: ordinal++ });
		}

		return {
			nodeKind: "classification" as const,
			contentJson: properties,
			anchorKind: "session" as const,
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};

export default regressionAttributionAnalyzer;
