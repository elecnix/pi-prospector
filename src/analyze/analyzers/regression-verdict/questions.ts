// The LLM verdict: did this session repair a regression, what caused it, and what
// would have stopped it?
//
// The deterministic analyzers answer what a transcript states. This one answers
// what a transcript implies, which is the question that matters for retrospectives:
// an agent frequently repairs a defect without ever learning — or saying — which
// earlier change caused it. The cause still exists in the evidence: the failing
// command names the broken behaviour, the commit shows the repair, and the defect
// statement names the mechanism. A reader can classify that; so can a model.
//
// The verdict is deliberately a classification of EVIDENCE, not a judgement of an
// author. `cause_class` names the kind of mistake, never a person: the output feeds
// a retrospective about the codebase and its rules, which is the only thing that can
// be fixed. Blame that ends at an individual changes nothing and cannot be acted on.
//
// Anti-hallucination rules, each because the model will otherwise invent them:
//
//   - The cause is `unstated` when the packet does not show one. The model is told
//     that guessing is the failure mode, and that `unstated` is a correct answer.
//   - The blamed PR number is a separate, explicitly-evidenced field, and the
//     deterministic analyzers own it. The model may only quote a number it was shown.
//   - A defect that never worked is not a regression, and the model is told to say so.
//
// Deterministic inputs, one model call out. The packet the gate built is the whole
// state, so the same packet always asks the same question — which is what lets the
// verdict be re-judged as the prompt improves.

import type { EvidencePacket } from "./gate.js";

/** The kinds of mistake that produce a regression. Closed set: a retrospective needs counts. */
export const CAUSE_CLASSES = [
	"missing_test",
	"shared_mutable_state",
	"cross_dialect_gap",
	"config_drift",
	"stale_documentation",
	"order_dependency",
	"error_handling_gap",
	"assumption_about_input",
	"incomplete_rename",
	"resource_lifecycle",
	// Added after the first full-corpus run: 267 of 839 regressions landed in
	// `assumption_about_input`, and sampling showed it collecting three unrelated
	// mechanisms — a regex that matched one form of a construct, an operator that
	// overwrote instead of appended, and a pattern broad enough to kill another
	// service's processes. One bucket cannot argue for one change, so they are split.
	"incomplete_match",
	"wrong_operator",
	"scope_too_wide",
	"unclassified",
] as const;
export type CauseClass = (typeof CAUSE_CLASSES)[number];

/** What the retrospective should propose. Closed set, one per verdict. */
export const PREVENTION_CLASSES = [
	"add_regression_test",
	"add_class_level_guard",
	"invariant_in_types",
	"document_the_rule",
	"enforce_in_ci",
	"narrow_the_api",
	"unclassified",
] as const;
export type PreventionClass = (typeof PREVENTION_CLASSES)[number];

export type Verdict = {
	/** Did the session repair a defect at all? */
	fixes_defect: boolean;
	/** Was the defect introduced by an earlier change, rather than never having worked? */
	is_regression: boolean;
	/** The cause in one sentence, or null when the evidence does not show one. */
	cause: string | null;
	/** `stated` = the transcript says it; `inferred` = the model concluded it from the evidence. */
	cause_provenance: "stated" | "inferred" | "unstated";
	cause_class: CauseClass;
	prevention_class: PreventionClass;
	/** One sentence naming what the codebase or its docs should change so this cannot recur. */
	prevention: string | null;
	/** A pull request number the packet itself showed as the cause, or null. */
	blamed_pr: number | null;
	/** How sure the model is, 0 to 1. */
	confidence: number;
	/** The sentence in the packet that most supports the verdict. */
	evidence_quote: string | null;
};

export const VERDICT_TOOL = {
	name: "report_regression_verdict",
	description: "Report the regression verdict for one coding session, from the evidence packet.",
	parameters: {
		type: "object",
		required: [
			"fixes_defect",
			"is_regression",
			"cause",
			"cause_provenance",
			"cause_class",
			"prevention_class",
			"prevention",
			"blamed_pr",
			"confidence",
			"evidence_quote",
		],
		additionalProperties: false,
		properties: {
			fixes_defect: { type: "boolean", description: "True when the session repaired broken behaviour. An additive feature, docs edit, refactor or test-only change is false." },
			is_regression: { type: "boolean", description: "True when an earlier change introduced the defect, so it used to work. False when it never worked, when a vendor or dependency released the defect, or when no defect was fixed." },
			cause: {
				type: ["string", "null"],
				description:
					"The mechanism of the earlier change, in one sentence. Null when the evidence does not show one: guessing is worse than admitting it.",
			},
			cause_provenance: {
				type: "string",
				enum: ["stated", "inferred", "unstated"],
				description:
					"stated = the packet says why. inferred = the packet does not say, but the failure and the repair show it. unstated = the evidence does not support a cause.",
			},
			cause_class: { type: "string", enum: CAUSE_CLASSES as unknown as string[] },
			prevention_class: { type: "string", enum: PREVENTION_CLASSES as unknown as string[] },
			prevention: {
				type: ["string", "null"],
				description:
					"One sentence: what the codebase, its types, its tests or its docs should change so this class of defect cannot recur. Null when no defect was fixed.",
			},
			blamed_pr: {
				type: ["number", "null"],
				description:
					"A pull request number that the packet shows as the cause. Null unless the packet explicitly names it as the cause. Never a number the packet does not contain.",
			},
			confidence: { type: "number", description: "0 to 1." },
			evidence_quote: {
				type: ["string", "null"],
				description: "A short verbatim quote from the packet that most supports the verdict, or null.",
			},
		},
	},
} as const;

export const VERDICT_SYSTEM = `You classify one coding session from an evidence packet, for a retrospective on how a codebase lets defects in.

You are not judging the engineer. You are classifying the KIND of mistake, because only the kind can be fixed.

Read the packet and answer:

1. Did the session repair broken behaviour? An additive feature, a docs edit, a refactor, a test-only change, or a review that changed nothing is not a repair. If the session only discussed a defect without repairing it, "fixes_defect" is false.

2. Was the defect a regression? A regression means an earlier change introduced it, so the behaviour used to work. Answer false when:
   - the defect never worked (a new feature that was always broken),
   - a vendor, SDK, runtime or released dependency caused it,
   - a flaky test was the whole story,
   - no defect was fixed at all.

3. What was the cause? Say how the earlier change let the defect in, and pick the class that names the MECHANISM, not the symptom:

   - \`shared_mutable_state\` — one slice, map or struct reached two owners.
   - \`cross_dialect_gap\` — one client dialect or provider path handled, the other missed.
   - \`config_drift\` — a value, default or shard count drifted from what its consumer requires.
   - \`order_dependency\` — a step required a sequence its caller did not guarantee.
   - \`assumption_about_input\` — code relied on something the caller never promised: a field present, a list non-empty, a version formatted a certain way.
   - \`incomplete_match\` — a matcher covered one form of a construct and missed another: a regex for one syntax, a check for one shape, a filter for one case.
   - \`wrong_operator\` — the logic was structurally right and the operator, comparison or assignment was wrong (\`=\` where \`+=\` was meant, \`<\` where \`<=\` was meant, the wrong field in a condition).
   - \`scope_too_wide\` — an action reached further than its subject: a pattern that matched other services, a write that touched files outside its own directory, a delete that removed more than it created.
   - \`incomplete_rename\` — a rename or move missed a call site or a declaration.
   - \`error_handling_gap\` — a failure was not handled where the boundary owns it.
   - \`resource_lifecycle\` — a resource was not released, was released twice, or outlived its owner.
   - \`missing_test\` — the only defensible statement is that nothing exercised the behaviour.
   - \`stale_documentation\` — the documented rule and the code disagreed.

   Reserve \`assumption_about_input\` for reliance on a caller's promise. A wrong operator is \`wrong_operator\`; a matcher that missed a syntax is \`incomplete_match\`; an action that hit someone else's work is \`scope_too_wide\`. Do not use \`assumption_about_input\` as a catch-all.

   If the packet does not show a cause, answer with a null cause and "unstated". You will be tempted to infer a plausible cause. Do not: an invented cause corrupts the retrospective, and "unstated" is a correct and useful answer. Mark "inferred" only when the failure message and the repair together make the mechanism unambiguous.

4. What would have prevented it? Name the concrete change: a test that pins the failing case, a class-level guard across every dialect, an invariant the type system enforces, a documented rule, or a CI check. Null when no defect was fixed.

5. blamed_pr: only a pull request number the packet names as the cause. Never a number from memory, a link, or a guess.

6. evidence_quote: a short verbatim slice of the packet, so a reader can check you.

Answer with the tool call only.`;

/** Build the user message from the packet. Bounded, and labelled so a quote is checkable. */
export function buildVerdictPrompt(packet: EvidencePacket): string {
	const section = (title: string, lines: readonly string[]) =>
		lines.length ? `## ${title}\n${lines.map((l) => `- ${l}`).join("\n")}` : `## ${title}\n(none)`;

	return [
		`Session: ${packet.session_id}`,
		`Reverted a change: ${packet.reverts ? "yes" : "no"}`,
		`Ran a test, build or lint: ${packet.ran_checks ? "yes" : "no"}`,
		"",
		section("Failures seen", packet.failures),
		"",
		section("Commits made", packet.commits),
		"",
		section("Statements about the defect", packet.defect_statements),
		"",
		section("Files touched", packet.files_touched),
	].join("\n");
}

/** Coerce one field of the model's tool call, tolerating a near-miss. */
function asBool(v: unknown, fallback = false): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v.toLowerCase() === "true";
	return fallback;
}

function asString(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "none") return null;
	return t.slice(0, 600);
}

function asCauseClass(v: unknown): CauseClass {
	return (CAUSE_CLASSES as readonly string[]).includes(String(v)) ? (String(v) as CauseClass) : "unclassified";
}

function asPreventionClass(v: unknown): PreventionClass {
	return (PREVENTION_CLASSES as readonly string[]).includes(String(v)) ? (String(v) as PreventionClass) : "unclassified";
}

/**
 * Read the model's tool call into a Verdict.
 *
 * Consistency is enforced here rather than trusted: a verdict that fixes no defect
 * cannot be a regression, and an unstated cause cannot carry a cause class. A model
 * that contradicts itself is recorded as the contradiction it is, not silently
 * repaired into a plausible-looking row.
 */
export function parseVerdict(raw: unknown): Verdict {
	const o = (raw ?? {}) as Record<string, unknown>;
	const fixesDefect = asBool(o["fixes_defect"]);
	const isRegression = fixesDefect && asBool(o["is_regression"]);
	const provenanceRaw = String(o["cause_provenance"] ?? "unstated");
	const provenance: Verdict["cause_provenance"] =
		provenanceRaw === "stated" || provenanceRaw === "inferred" ? provenanceRaw : "unstated";
	const cause = asString(o["cause"]);
	// A boolean is not a confidence. Coercing first made `true` a perfect score, which
	// weighted a non-answer as the most certain verdict in the corpus.
	const rawConfidence = o["confidence"];
	const confidenceRaw = typeof rawConfidence === "number" ? rawConfidence : Number.NaN;

	// A pull request number is only accepted when it is a positive integer.
	// A boolean is not a pull request number. Coercing first made `true` into #1.
	const rawPr = o["blamed_pr"];
	const blamedPr = typeof rawPr === "number" && Number.isInteger(rawPr) && rawPr > 0 ? rawPr : null;

	// A pull request is only blamed when the verdict states a cause. A blamed number
	// with no mechanism is an accusation the evidence does not carry.
	const keepBlame = isRegression && Boolean(cause) && provenance !== "unstated";

	return {
		fixes_defect: fixesDefect,
		is_regression: isRegression,
		cause: keepBlame ? cause : null,
		cause_provenance: isRegression && cause ? provenance : "unstated",
		// A cause the verdict itself calls unstated carries no class, so the counts
		// downstream never include a mechanism the evidence does not support.
		cause_class: isRegression && cause && provenance !== "unstated" ? asCauseClass(o["cause_class"]) : "unclassified",
		prevention_class: fixesDefect ? asPreventionClass(o["prevention_class"]) : "unclassified",
		prevention: fixesDefect ? asString(o["prevention"]) : null,
		blamed_pr: keepBlame ? blamedPr : null,
		confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0,
		evidence_quote: asString(o["evidence_quote"]),
	};
}
