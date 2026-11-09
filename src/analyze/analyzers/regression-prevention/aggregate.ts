// regression-prevention: the corpus-level retrospective.
//
// The per-session analyzers answer "what happened". This one answers the question
// the operator actually asked: across the whole corpus, which KINDS of defect keep
// getting in, and what change to the codebase, its types, or its documentation
// would stop that class from recurring?
//
// It is a corpus-scoped synthesis, not a per-session one. It reads every
// `regression-verdict` node, groups them by `cause_class`, counts how often each
// prevention would have applied, and emits one proposal per cause class that
// clears a threshold. A class that recurred nine times is a gap in the codebase's
// invariants; a class seen once is noise, so the threshold exists.
//
// Three deliberate refusals, because a retrospective is easy to fake:
//
//   - **No model call.** The verdicts already carry the classification and the
//     prevention prose. Grouping them is arithmetic, and a second model pass over
//     its own conclusions would only add hallucination to a count.
//   - **No invented counts.** Every figure in a proposal is read from the graph.
//     When the corpus is thin, the proposal says the count and lets the reader see
//     it is thin, rather than rounding a single incident up to a trend.
//   - **No blame.** A proposal names a mechanism and a change, never a session or a
//     person. The failures named in `examples` are evidence for the class, not an
//     accusation about who wrote them.
//
// Deterministic.

import { CAUSE_CLASSES, PREVENTION_CLASSES, type CauseClass, type PreventionClass } from "../regression-verdict/questions.js";

export const ANALYZER_ID = "regression-prevention";
export const VERDICT_ANALYZER_ID = "regression-verdict";

export type Config = {
	/** A cause class needs at least this many verdicts before it earns a proposal. */
	minOccurrences: number;
	/** Cap on how many example sessions a proposal names. */
	maxExamples: number;
	/** Only count verdicts at or above this confidence. */
	minConfidence: number;
};

export const DEFAULT_CONFIG: Config = { minOccurrences: 3, maxExamples: 4, minConfidence: 0.4 };

/** What the proposal recommends, keyed by the cause class it addresses. */
export const PREVENTION_BY_CAUSE: Record<CauseClass, { prevention: PreventionClass; target_type: string; change: string }> = {
	missing_test: {
		prevention: "add_regression_test",
		target_type: "workflow",
		change:
			"Require a test that exercises the changed behaviour's failure mode, not only its success path, before a change to this area merges.",
	},
	shared_mutable_state: {
		prevention: "invariant_in_types",
		target_type: "code",
		change:
			"Make the shared value impossible to hand out by reference: an opaque wrapper that copies on read or store, enforced by the type rather than by convention.",
	},
	cross_dialect_gap: {
		prevention: "add_class_level_guard",
		target_type: "code",
		change:
			"Cover every client dialect in one shared test table, so a change proven for one path fails loudly on the other instead of shipping.",
	},
	config_drift: {
		prevention: "enforce_in_ci",
		target_type: "workflow",
		change:
			"Validate the configuration against its schema in CI, so a field that a consumer requires cannot be absent or empty at runtime.",
	},
	stale_documentation: {
		prevention: "document_the_rule",
		target_type: "docs",
		change:
			"State the rule where the code is edited, and make the doc a gate input: a change that contradicts it fails the check rather than being discovered later.",
	},
	order_dependency: {
		prevention: "invariant_in_types",
		target_type: "code",
		change:
			"Remove the ordering requirement, or make the required order impossible to violate: a builder that returns a type which only the next step accepts.",
	},
	error_handling_gap: {
		prevention: "add_class_level_guard",
		target_type: "code",
		change:
			"Handle the failure class at the boundary that owns it, so a new call site inherits the handling instead of each one remembering to add it.",
	},
	assumption_about_input: {
		prevention: "narrow_the_api",
		target_type: "code",
		change:
			"Encode what the caller guarantees in the type or a validation at the boundary, so an assumption the caller does not promise cannot be relied on silently.",
	},
	incomplete_rename: {
		prevention: "enforce_in_ci",
		target_type: "workflow",
		change:
			"Make the rename mechanical and machine-checked — a compiler-visible rename, or a CI grep for the old identifier — instead of a list of edits.",
	},
	resource_lifecycle: {
		prevention: "add_class_level_guard",
		target_type: "code",
		change:
			"Give the resource one owner with paired acquire/release, so a caller cannot leave it unclosed or close it twice.",
	},
	incomplete_match: {
		prevention: "add_class_level_guard",
		target_type: "code",
		change:
			"Enumerate every form the construct can take in one place — a table of syntaxes, a list of shapes — and test the matcher against all of them, so the second form cannot slip past the first.",
	},
	wrong_operator: {
		prevention: "invariant_in_types",
		target_type: "code",
		change:
			"Make the wrong operation impossible or loud: a type that does not accept a plain assignment where accumulation is meant, or an expression whose meaning one test states in words.",
	},
	scope_too_wide: {
		prevention: "narrow_the_api",
		target_type: "code",
		change:
			"Narrow the action to its own subject: an identifier the code owns rather than a pattern that can match others, and a dry-run listing the target set before it acts.",
	},
	unclassified: {
		prevention: "unclassified",
		target_type: "code",
		change: "No single mechanism recurs here yet; read the individual verdicts.",
	},
};

/** One verdict, as this analyzer reads it from a node. */
export type VerdictRow = {
	session_id: string;
	fixes_defect: boolean;
	is_regression: boolean;
	cause: string | null;
	cause_class: CauseClass;
	prevention_class: PreventionClass;
	prevention: string | null;
	confidence: number;
};

/** Read a `regression-verdict` node's content into a VerdictRow, tolerating junk. */
export function verdictFromNode(content: unknown): VerdictRow | null {
	const c = content as Record<string, unknown> | null | undefined;
	if (!c || typeof c !== "object") return null;
	const causeClass = (CAUSE_CLASSES as readonly string[]).includes(String(c["cause_class"]))
		? (String(c["cause_class"]) as CauseClass)
		: "unclassified";
	const preventionClass = (PREVENTION_CLASSES as readonly string[]).includes(String(c["prevention_class"]))
		? (String(c["prevention_class"]) as PreventionClass)
		: "unclassified";
	const conf = Number(c["confidence"]);
	return {
		session_id: String(c["session_id"] ?? ""),
		fixes_defect: c["fixes_defect"] === true,
		is_regression: c["is_regression"] === true,
		cause: typeof c["cause"] === "string" ? c["cause"] : null,
		cause_class: causeClass,
		prevention_class: preventionClass,
		prevention: typeof c["prevention"] === "string" ? c["prevention"] : null,
		confidence: Number.isFinite(conf) ? conf : 0,
	};
}

export type Cluster = {
	cause_class: CauseClass;
	occurrences: number;
	/** Every confidence in the cluster, so the proposal can state its support honestly. */
	mean_confidence: number;
	/** Distinct causes reported for this class, most common first, capped. */
	example_causes: string[];
	example_sessions: string[];
};

/** Group verdicts into cause classes. Pure, so the arithmetic is testable without a database. */
export function clusterVerdicts(verdicts: readonly VerdictRow[], config: Config = DEFAULT_CONFIG): Cluster[] {
	const byClass = new Map<CauseClass, VerdictRow[]>();
	for (const v of verdicts) {
		// Only a defect that an earlier change introduced counts toward the retrospective.
		// A vendor break or a new feature's never-worked path is not a codebase gap.
		if (!v.fixes_defect || !v.is_regression) continue;
		if (v.confidence < config.minConfidence) continue;
		const list = byClass.get(v.cause_class) ?? [];
		list.push(v);
		byClass.set(v.cause_class, list);
	}

	const clusters: Cluster[] = [];
	for (const [causeClass, rows] of byClass) {
		const causes = new Map<string, number>();
		for (const r of rows) {
			if (!r.cause) continue;
			const key = r.cause.trim();
			if (key) causes.set(key, (causes.get(key) ?? 0) + 1);
		}
		clusters.push({
			cause_class: causeClass,
			occurrences: rows.length,
			mean_confidence: rows.reduce((s, r) => s + r.confidence, 0) / rows.length,
			example_causes: [...causes.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 3)
				.map(([c]) => c.slice(0, 300)),
			example_sessions: [...new Set(rows.map((r) => r.session_id))].filter(Boolean).slice(0, config.maxExamples),
		});
	}

	// Most-recurring class first: the retrospective is ranked by how often it bit.
	return clusters.sort((a, b) => b.occurrences - a.occurrences || a.cause_class.localeCompare(b.cause_class));
}

/** The proposal text for one cluster: what recurs, how often, and the change it argues for. */
export function proposalFor(cluster: Cluster): {
	target_type: string;
	title: string;
	summary: string;
	detail: string;
	evidence: string;
	severity: string;
	confidence: number;
} {
	const rule = PREVENTION_BY_CAUSE[cluster.cause_class] ?? PREVENTION_BY_CAUSE.unclassified;
	const label = cluster.cause_class.replace(/_/g, " ");
	const times = cluster.occurrences === 1 ? "once" : `${cluster.occurrences} times`;

	return {
		target_type: rule.target_type,
		title: `${label}: ${cluster.occurrences} regression${cluster.occurrences === 1 ? "" : "s"} from one cause class`,
		summary: `Coding sessions repaired a regression caused by ${label} ${times}. ${rule.change}`,
		detail: [
			`**Class.** ${label}`,
			`**Verdicts.** ${cluster.occurrences}, mean confidence ${cluster.mean_confidence.toFixed(2)}.`,
			cluster.example_causes.length ? `**Mechanisms seen.**\n${cluster.example_causes.map((c) => `- ${c}`).join("\n")}` : "",
			`**The change this argues for.** ${rule.change}`,
			`**Prevention kind.** ${rule.prevention.replace(/_/g, " ")}.`,
			cluster.example_sessions.length ? `**Evidence sessions.** ${cluster.example_sessions.map((s) => `\`${s}\``).join(", ")}` : "",
		]
			.filter(Boolean)
			.join("\n\n"),
		evidence: cluster.example_causes[0] ?? label,
		// Severity ranks the class against the corpus, not against a fixed number. At
		// corpus scale every class clears any small constant, so a constant band made all
		// ten proposals "high" and the ranking said nothing. `severityOf` is applied by
		// the caller, which knows the largest class; this default is the single-class case.
		severity: "medium",
		confidence: Math.max(0.2, Math.min(0.95, cluster.mean_confidence)),
	};
}

/**
 * Rank one class against the corpus.
 *
 * A fixed band is useless at scale: on 839 regressions every class cleared ten, so
 * every proposal was "high" and the ranking carried no information. Ranking by share
 * of the largest class keeps the ordering meaningful as the corpus grows — the class
 * that recurs most is high, a class a tenth as common is low, whatever the absolute
 * counts are.
 */
export function severityOf(occurrences: number, largest: number): "high" | "medium" | "low" {
	if (largest <= 0) return "low";
	const share = occurrences / largest;
	if (share >= 0.5) return "high";
	if (share >= 0.2) return "medium";
	return "low";
}

/** Build the proposals worth filing, thresholded. */
export function buildProposals(
	verdicts: readonly VerdictRow[],
	config: Config = DEFAULT_CONFIG,
): { total_verdicts: number; regressions: number; clusters: Cluster[]; improvement_proposals: ReturnType<typeof proposalFor>[] } {
	const clusters = clusterVerdicts(verdicts, config);
	const qualifying = clusters.filter((c) => c.occurrences >= config.minOccurrences && c.cause_class !== "unclassified");
	const largest = qualifying.reduce((m, c) => Math.max(m, c.occurrences), 0);
	return {
		total_verdicts: verdicts.length,
		regressions: verdicts.filter((v) => v.fixes_defect && v.is_regression).length,
		clusters,
		improvement_proposals: qualifying.map((c) => ({ ...proposalFor(c), severity: severityOf(c.occurrences, largest) })),
	};
}
