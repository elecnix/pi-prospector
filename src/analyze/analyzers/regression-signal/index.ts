/**
 * regression-signal — the session that fixed a defect, and the change it blames.
 *
 * One session-anchored node per session that claims a regression. The node
 * carries the evidence the claim was read from: the signals that fired, the pull
 * requests and commits the session names as the cause, and the message ids the
 * prose lives in. **It proposes nothing.** A claim is not a finding, because
 * whether the blamed change really introduced the defect needs the tree, not a
 * transcript.
 *
 * Two separate facts, deliberately not one. `claims_regression` is the label: the
 * session changed something and states that a defect came from an earlier change,
 * whether or not it names that change. Most real regressions in a large corpus
 * state the cause without a number ("caused by my own extension"), and requiring a
 * number here threw away most of them. `names_the_cause` is what the attribution
 * join needs: a pull request number, unambiguous within a repository. A labelled
 * regression without it is a real finding that simply cannot be attributed.
 *
 * The detection rules live in `detect.ts`, which is the file to change when a rule
 * changes. Deterministic: no model, no network.
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
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { DEFAULT_REGRESSION_SIGNAL_CONFIG, RegressionSignalConfig } from "./config.js";
import { findRegressionEvidence, type Scan } from "./detect.js";

export * from "./config.js";
export * from "./detect.js";

/** The properties a regression-signal node carries. */
export const RegressionSignalProperties = Type.Object({
	session_id: Type.String(),
	/** The label: this session repaired a defect an earlier change caused. */
	claims_regression: Type.Boolean(),
	/** The signals that fired, in a fixed order, so a node is stable across runs. */
	signals_fired: Type.Array(Type.String()),
	signals: Type.Object({
		changed_something: Type.Boolean(),
		reverts: Type.Boolean(),
		causal_claim: Type.Boolean(),
		names_the_cause: Type.Boolean(),
		sought_the_cause: Type.Boolean(),
		states_it_worked_before: Type.Boolean(),
	}),
	cited_pull_requests: Type.Array(
		Type.Object({ number: Type.Number(), quote: Type.String(), message_id: Type.String() }),
	),
	cited_commits: Type.Array(Type.Object({ sha: Type.String(), quote: Type.String(), message_id: Type.String() })),
	/** The session blames an upstream project or a released dependency. */
	blames_upstream: Type.Boolean(),
	/** The session says the defect never worked, which makes it a new defect. */
	never_worked: Type.Boolean(),
	evidence_message_ids: Type.Array(Type.String()),
});
export type RegressionSignalProperties = Static<typeof RegressionSignalProperties>;

export const REGRESSION_SIGNAL_DEF: AnalyzerDef = {
	id: "regression-signal",
	label: "Regression Signal (deterministic)",
	description:
		"Records, on a session, the evidence that it fixed a defect an earlier change introduced: the signals " +
		"that fired, the pull requests and commits it names as the cause, and the messages the claim was read " +
		"from. Reads visible text, thinking, tool calls and tool results. A review that changes nothing files no " +
		"claim, a test named 'regression test' files none, an upstream or released-dependency regression is marked " +
		"as such, and a defect that never worked is marked as a new defect. Deterministic, no LLM. It proposes " +
		"nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: RegressionSignalProperties,
};

export const REGRESSION_SIGNAL_VERSION: AnalyzerVersion = {
	analyzerId: REGRESSION_SIGNAL_DEF.id,
	// 1.0: the claim, its citations, and the labels that separate a regression from
	// an upstream break and from a defect that never worked.
	// 1.1: `claims_regression` no longer requires a named cause. Most real regressions
	// state the mechanism without a pull request number, and requiring one dropped
	// them; attributability moved to `signals.names_the_cause`.
	major: 1,
	minor: 1,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/regression-signal/index.ts",
};

function resolveConfig(raw: unknown): RegressionSignalConfig {
	return { ...DEFAULT_REGRESSION_SIGNAL_CONFIG, ...((raw as Partial<RegressionSignalConfig> | null | undefined) ?? {}) };
}

const MESSAGES_SELECT =
	"SELECT id, session_id, role, content_text, content_thinking, tool_calls, tool_results, stop_reason, error_message, cost_usd " +
	"FROM messages WHERE session_id = ? ORDER BY rowid ASC";

export const regressionSignalAnalyzer: Analyzer = {
	def: REGRESSION_SIGNAL_DEF,
	version: REGRESSION_SIGNAL_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: REGRESSION_SIGNAL_DEF.id,
		configHash: computeConfigHash(DEFAULT_REGRESSION_SIGNAL_CONFIG),
		configJson: DEFAULT_REGRESSION_SIGNAL_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * Plan from the same scan the analysis uses, so a session that claims nothing is
	 * never scheduled and writes no node. The unit's identity folds in a fingerprint
	 * of the rows read: a re-sync that backfills a tool result re-identifies the unit
	 * and recomputes, rather than serving a claim drawn from a thinner transcript.
	 */
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];
		const config = resolveConfig(ctx.config);
		const scan = findRegressionEvidence(ctx.messages, config);
		if (!scan.claims_regression) return [];

		const fingerprint = shortHash(
			ctx.messages
				.map((m) =>
					[
						m.id,
						m.role,
						m.content_text ? shortHash(m.content_text) : "",
						m.content_thinking ? shortHash(m.content_thinking) : "",
						m.tool_calls ? shortHash(m.tool_calls) : "",
						m.tool_results ? shortHash(m.tool_results) : "",
						// Every column the scan reads is hashed. A backfill that adds only an error
						// message must re-identify the source, or the thinner node stays current.
						m.stop_reason ?? "",
						m.error_message ? shortHash(m.error_message) : "",
						m.cost_usd === null || m.cost_usd === undefined ? "" : String(m.cost_usd),
					].join(":"),
				)
				.join("\n"),
		);

		return [
			{
				sources: [{ kind: "session", id: `${ctx.sessionId}#regression-signal=${fingerprint}` }],
				sourceSetHash: shortHash(`regression-signal(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { message_ids: scan.evidence_message_ids, fingerprint },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = (await ctx.db.prepare(MESSAGES_SELECT).all(ctx.sessionId)) as Awaited<
			ReturnType<AnalyzerRunContext["getSessionMessages"]>
		>;
		const scan: Scan = findRegressionEvidence(messages.length ? messages : await ctx.getSessionMessages(ctx.sessionId), config);

		// A claim can disappear between plan and analyze when the transcript gained text
		// that marks it upstream or never-worked. The node is still written, recording
		// that the claim fell away, because an append-only graph must not silently drop a
		// unit it planned.
		const properties: RegressionSignalProperties = {
			session_id: ctx.sessionId,
			claims_regression: scan.claims_regression,
			signals_fired: scan.signals_fired,
			signals: scan.signals,
			cited_pull_requests: scan.cited_pull_requests,
			cited_commits: scan.cited_commits,
			blames_upstream: scan.blames_upstream,
			never_worked: scan.never_worked,
			evidence_message_ids: scan.evidence_message_ids,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		for (const id of scan.evidence_message_ids) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		}

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
