import { Type } from "typebox";

/**
 * The `prospect` tool's registration metadata (#292).
 *
 * A tool must be registered while the extension loads, so its name, description,
 * and parameter schema are part of the startup surface — while the handler that
 * implements the actions is not: it is imported on the first tool call.
 */
export const PROSPECT_TOOL = {
	name: "prospect",
	label: "Prospect",
	description:
		"Index sessions, run analysis, check stats, list/accept/reject proposals, and mute/unmute lexicon terms. Actions: sync, analyze, stats, list_proposals, accept, reject, remediate, mute, unmute, mutes, help. " +
		"list_proposals accepts source (pi|claude) to filter by coding harness. " +
		"When accepting/rejecting, pass the human's reasoning via rationale, and disposition to record whether the " +
		"recommended action is planned, already done, or done_differently (the idea triggered a different action). " +
		"Use proposal_ids (string array) on accept/reject for bulk operations with a shared rationale. " +
		"Use remediate when ONE action addresses MANY proposals: pass proposal_ids and a description, and all of them " +
		"are accepted linked to a single shared remediation record instead of N duplicated rationales. " +
		"For muting: the reviewing agent performs the mute after operator feedback — pass the muted term and an optional reason; " +
		"the term stops matching new turns and its prior hit nodes become stale/config, cleanly recomputed by analyze with revise=[\"config\"]. " +
		"Use action analyze to run the analyzer framework over sessions: a frugal plain fill by default (only missing work), " +
		"revise widens the reach to recompute stale nodes (major/minor analyzer bumps, config = user setup changed), " +
		"analyzer restricts the run to one analyzer, model pins every tier to one model for the run (part of node identity), " +
		"and all=true back-fills every session (use after the frustration lexicon learns new words). " +
		"Use action nodes to read analyzer output from the surface (filter by analyzer/node-kind/content, counts over a property, " +
		"latest-per-key for newest verdict per term) and action node with output_key for one node's detail plus its resolved outgoing edges. " +
		"Use action session_summary with session_id for the session-level summary with its evidence: what happened, what went well, " +
		"what caused friction (textual gradients), the verbatim consumed turns behind it, the proposals it produced, and its cross-session contrast siblings. " +
		"Use action leaks to report which sessions contain detected secrets: findings from the credential-detector analyzers with severity, rule, " +
		"redacted preview, fingerprint, and message anchor (params: severity floor, limit, source). " +
		"Use action search with query for content and pattern search over proposals and the session corpus (FTS5): hits carry record kind, id, session, " +
		"a highlighted snippet ranked by bm25, and links into show / node (params: query required; kind all|messages|proposals; limit; source).",
	parameters: Type.Object({
		action: Type.Union([
			Type.Literal("sync"),
			Type.Literal("analyze"),
			Type.Literal("stats"),
			Type.Literal("list_proposals"),
			Type.Literal("accept"),
			Type.Literal("reject"),
			Type.Literal("remediate"),
			Type.Literal("mute"),
			Type.Literal("unmute"),
			Type.Literal("mutes"),
			Type.Literal("nodes"),
			Type.Literal("node"),
			Type.Literal("session_summary"),
			Type.Literal("leaks"),
			Type.Literal("search"),
			Type.Literal("help"),
		]),
		status: Type.Optional(
			Type.Union([
				Type.Literal("open"),
				Type.Literal("applied"),
				Type.Literal("rejected"),
				Type.Literal("duplicate"),
			]),
		),
		severity: Type.Optional(Type.String({ description: "list_proposals: filter by severity (friction, correction, waste, suggestion, reinforcement). leaks: minimum severity floor — report this severity (medium|high|critical) and above." })),
		source: Type.Optional(Type.String({ description: "Filter by coding harness: pi or claude." })),
		session_id: Type.Optional(Type.String({ description: "Scope list_proposals to a single session (only that session's proposals); analyze runs just that one session." })),
		project: Type.Optional(Type.String({ description: "Scope sync to one project (derived from the session directory name) so a fresh install skips every other project on disk." })),
		proposal_id: Type.Optional(Type.String()),
		proposal_ids: Type.Optional(Type.Array(Type.String(), { description: "Proposal ids to accept/reject together (accept/reject/remediate actions)." })),
		description: Type.Optional(Type.String({ description: "The one remediation action that addresses all proposal_ids (remediate action)." })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of proposals to return (defaults to 100 if omitted)." })),
		offset: Type.Optional(Type.Number({ description: "Number of proposals to skip before starting to return results." })),
		rationale: Type.Optional(Type.String({ description: "Human reasoning behind the decision (stored as durable memory)." })),
		disposition: Type.Optional(
			Type.Union([Type.Literal("planned"), Type.Literal("done"), Type.Literal("done_differently")], {
				description: "planned = will do it; done = did the recommended action; done_differently = the idea triggered a different action.",
			}),
		),
		actual_change: Type.Optional(Type.String({ description: "Commit sha / path / note of what was actually done." })),
		term: Type.Optional(Type.String({ description: "The lexicon term to mute or unmute (mute/unmute actions)." })),
		reason: Type.Optional(Type.String({ description: "Operator's free-text reason for muting a term (mute action)." })),
		revise: Type.Optional(
			Type.Array(
				Type.Union([Type.Literal("major"), Type.Literal("minor"), Type.Literal("config"), Type.Literal("all")]),
				{ description: "analyze: revise reasons — which stale nodes the run may recompute (major/minor = analyzer version bumps graded by the author, config = user setup changed, all = every reason). Omit for a frugal plain fill that only fills missing work." },
			),
		),
		recent: Type.Optional(Type.Number({ description: "analyze: run over the N most-recent sessions (by started_at DESC), e.g. for pilots." })),
		model: Type.Optional(Type.String({ description: "analyze: provider/model pinning every tier to one model for this run (the resolved model is part of node identity)." })),
		analyzer: Type.Optional(Type.String({ description: "Analyzer id to read (nodes action; required unless all=true) or to run (analyze action)." })),
		all: Type.Optional(Type.Boolean({ description: "Read nodes of every analyzer (nodes action); analyze: plain-fill every session, not just unanalysed ones." })),
		node_kind: Type.Optional(
			Type.Union([Type.Literal("metric"), Type.Literal("classification"), Type.Literal("summary"), Type.Literal("proposal"), Type.Literal("validation"), Type.Literal("restatement"), Type.Literal("error")], {
				description: "Restrict nodes to one kind (nodes action).",
			}),
		),
		filter: Type.Optional(Type.Array(Type.String(), { description: "key=value content filters, repeatable (nodes action); typed against the analyzer's declared outputSchema when it declares one." })),
		counts: Type.Optional(Type.String({ description: "Group counts over this top-level content property across all matching nodes (nodes action)." })),
		latest_per_key: Type.Optional(Type.String({ description: "Keep only the newest node per distinct value of this content property, e.g. 'term' for the newest lexicon verdict per term (nodes action)." })),
		all_versions: Type.Optional(Type.Boolean({ description: "Include superseded generations — nodes a newer node revises (nodes action). Off by default: counts describe the current generation only." })),
		output_key: Type.Optional(Type.String({ description: "The node's content-addressed output key, or an unambiguous prefix (node action)." })),
		query: Type.Optional(
			Type.String({ description: "search action: FTS5 MATCH query — plain terms (implicit AND), \"quoted phrases\", prefix terms (lexicon*), OR/NOT/AND, NEAR(a b, n), column:term." }),
		),
		kind: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("messages"), Type.Literal("proposals")], {
				description: "search: restrict which record kinds are searched (default all).",
			}),
		),
		// session_id is declared above (list_proposals filter); session_summary reuses it.
	}),
};
