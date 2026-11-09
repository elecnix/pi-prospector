import type { Analyzer, AnalysisUnit, AnalyzerPlanContext, AnalyzerRunContext, AnalysisNodeRow } from "../../types.js";
// regression-prevention: the corpus-wide retrospective, as a proposal node.
//
// Reads every `regression-verdict` node, groups the regressions by cause class,
// and emits one `summary` node whose `improvement_proposals` array the framework
// materialises into reviewable proposals. This is the step that answers the
// operator's actual question — which kinds of defect keep getting in, and what
// change to the codebase, its types or its docs would stop that class recurring.
//
// The node is corpus-scoped, not session-scoped: it anchors to the corpus (the
// analyzer emits one node for the whole run, anchored on a synthetic session id) so
// it is recomputed when the verdict population changes rather than once per session.
//
// No model call. The verdicts already carry the classification and the prevention
// prose; grouping them is arithmetic. A second model pass over its own conclusions
// would add hallucination to a count.
//
// Deterministic.

import {
	buildProposals,
	clusterVerdicts,
	verdictFromNode,
	VERDICT_ANALYZER_ID,
	type VerdictRow,
} from "./aggregate.js";
import { contentOf } from "../regression-attribution/node-content.js";
import { DEFAULT_REGRESSION_PREVENTION_CONFIG, type RegressionPreventionConfig } from "./config.js";

export const ANALYZER_ID = "regression-prevention";

/**
 * The anchor for the corpus-level node.
 *
 * It must be a real session: `analysis_edges` carries a foreign key to `sessions`,
 * and a synthetic id fails the insert. The anchor is the lowest session id in the
 * population, which is arbitrary but stable — the same verdict set always yields the
 * same anchor, so the unit keeps one identity instead of one per planning session.
 */
export function corpusAnchor(verdicts: readonly VerdictRow[]): string {
	return verdicts.map((v) => v.session_id).filter(Boolean).sort()[0] ?? "";
}

function resolveConfig(raw: unknown): RegressionPreventionConfig {
	return { ...DEFAULT_REGRESSION_PREVENTION_CONFIG, ...((raw as Partial<RegressionPreventionConfig> | null | undefined) ?? {}) };
}

type DependencyNode = AnalysisNodeRow;








/** A stable hash of the verdict population, so a change re-identifies the unit. */
function populationHash(verdicts: readonly VerdictRow[]): string {
	let h = 2166136261;
	const push = (s: string) => {
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
	};
	for (const v of [...verdicts].sort((a, b) => a.session_id.localeCompare(b.session_id))) {
		// The prose is part of the population: a proposal quotes the causes it grouped,
		// so a re-judge that keeps the same classes but rewrites them must re-identify
		// the unit, or the node keeps quoting text no verdict says any more.
		push(v.session_id);
		push(v.cause_class);
		push(v.prevention_class);
		push(v.cause ?? "");
		push(v.prevention ?? "");
		push(String(v.fixes_defect));
		push(String(v.is_regression));
		push(String(v.confidence));
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

async function readVerdicts(get: (id: string) => Promise<DependencyNode[]>): Promise<VerdictRow[]> {
	let nodes: DependencyNode[] = [];
	try {
		nodes = await get(VERDICT_ANALYZER_ID);
	} catch {
		return [];
	}
	const out: VerdictRow[] = [];
	for (const node of nodes) {
		const row = verdictFromNode(contentOf(node));
		if (row) out.push(row);
	}
	return out;
}

export const regressionPreventionAnalyzer: Analyzer = {
	def: {
		id: ANALYZER_ID,
		label: "Regression Prevention (corpus synthesis)",
		description:
			"Groups every `regression-verdict` by the kind of mistake that let the defect in, counts how often each " +
			"class recurred, and files one proposal per class that clears a threshold — naming the change to the " +
			"codebase, its types, its tests or its docs that would stop that class recurring. Reads the graph only; " +
			"no model call, and every figure is read rather than estimated. Deterministic.",
		anchorSpan: "full_session" as const,
		dependencies: [VERDICT_ANALYZER_ID] as string[],
		outputSchema: {
			type: "object",
			properties: {
				total_verdicts: { type: "number" },
				regressions: { type: "number" },
				clusters: { type: "array" },
			},
		},
	},
	version: {
		analyzerId: ANALYZER_ID,
		major: 1,
		minor: 0,
		implementationKind: "deterministic" as const,
		codeRef: "src/analyze/analyzers/regression-prevention/index.ts",
	},
	prompts: {},
	defaultConfig: {
		id: "",
		analyzerId: ANALYZER_ID,
		configHash: "",
		configJson: DEFAULT_REGRESSION_PREVENTION_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * One unit for the whole corpus, described by the population it read. Plan runs
	 * on every session, but the unit identity ignores which session planned it, so
	 * the framework recognises one logical unit rather than one per session.
	 */
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const verdicts = await readVerdicts(ctx.getGlobalDependencyNodes);
		if (verdicts.length === 0) return [];
		const config = resolveConfig(ctx.config);
		const clusters = clusterVerdicts(verdicts, config);
		// Nothing to say yet: a corpus whose regressions are all below the threshold
		// files nothing rather than a proposal about a single incident.
		if (clusters.filter((c) => c.occurrences >= config.minOccurrences && c.cause_class !== "unclassified").length === 0) return [];

		const hash = populationHash(verdicts);
		const anchor = corpusAnchor(verdicts);
		if (!anchor) return [];

		// A wider corpus yields a different population hash and therefore a new unit. The
		// framework links revisions only for a stale unit of the same identity, so the
		// predecessor is linked here: without it the older node stays current beside the
		// new one and its proposals stay open, which is how a partial run's four proposals
		// survived the full-corpus run that superseded them.
		const prior = [...ctx.ownNodes].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))).pop();

		return [
			{
				sources: [{ kind: "session", id: `${anchor}#regression-prevention=${hash}` }],
				sourceSetHash: `regression-prevention(${hash})`,
				anchorKind: "session",
				anchorRef: anchor,
				meta: { population_hash: hash, ...(prior ? { revises: prior.id } : {}) },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext) {
		const config = resolveConfig(ctx.config.configJson);
		const verdicts = await readVerdicts(ctx.getGlobalDependencyNodes);
		const built = buildProposals(verdicts, config);

		const revises = typeof unit.meta?.["revises"] === "string" ? (unit.meta["revises"] as string) : undefined;

		const properties = {
			total_verdicts: built.total_verdicts,
			regressions: built.regressions,
			clusters: built.clusters,
			improvement_proposals: built.improvement_proposals,
		};

		return {
			// `summary` is the node kind the framework materialises proposals from.
			nodeKind: "summary" as const,
			contentJson: properties,
			anchorKind: "session" as const,
			anchorRef: unit.anchorRef,
			edges: [
				{ toRefKind: "session", toRefId: unit.anchorRef, edgeKind: "anchors", ordinal: 0 },
				...(revises ? [{ toRefKind: "analysis_node", toRefId: revises, edgeKind: "revises", ordinal: 1 }] : []),
			],
		};
	},
};

export default regressionPreventionAnalyzer;
