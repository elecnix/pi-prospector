/**
 * Prompt for the rule-restatement check.
 *
 * The model reads one proposal and the instruction corpus, and says whether the
 * rule is already there. The comparison is semantic on purpose: a rule proposed
 * after the fact rarely shares wording with the rule that exists, and the same
 * rule is often proposed from its other end ("the orchestrator never closes
 * tickets" and "the PR opener closes the ticket" are one rule).
 *
 * A claim that the rule exists must quote it. The quote is checked against the
 * corpus verbatim (whitespace-insensitive) before it is believed, so a model
 * that invents a rule cannot mark a real gap as covered.
 */

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { shortHash } from "../../input-hash.js";
import { extractJsonObject } from "../turn-pair-llm/prompt.js";
import type { CorpusExcerpt } from "./corpus.js";

export const JUDGE_RESTATEMENT_PROMPT = `You check whether a proposed rule for a coding agent's standing instructions is already stated in the instructions that agent runs under.

You are given one PROPOSAL and the INSTRUCTION FILES in scope. Decide:
- "restated": the instructions already state this rule. Different wording counts. So does the same rule stated from the other side (for example "the orchestrator never closes tickets" and "whoever opens the PR closes the ticket" are one rule).
- "partial": the instructions state part of it, or a weaker or narrower form, and the proposal would add something real.
- "gap": nothing in the instructions states it.

When the verdict is "restated" or "partial", copy the single most relevant sentence or line from the instructions into "quote" EXACTLY as written, and put that file's path in "path". Do not paraphrase the quote. When the verdict is "gap", leave "quote" and "path" empty.

Judge only what the instructions say, not whether the agent followed them. Answer by calling the judge_restatement tool.`;

export const JUDGE_RESTATEMENT_PROMPT_HASH = shortHash(JUDGE_RESTATEMENT_PROMPT);

export const RestatementVerdict = Type.Union([Type.Literal("restated"), Type.Literal("partial"), Type.Literal("gap")]);
export type RestatementVerdict = Static<typeof RestatementVerdict>;

export const JudgeRestatementArgs = Type.Object({
	verdict: RestatementVerdict,
	path: Type.String({ description: "path of the file holding the quote; empty for gap" }),
	quote: Type.String({ description: "the existing rule, copied exactly; empty for gap" }),
	rationale: Type.String({ description: "one short sentence" }),
});
export type JudgeRestatementArgs = Static<typeof JudgeRestatementArgs>;

/** Forced-tool-call schema for the restatement judgement. */
export const JUDGE_RESTATEMENT_TOOL = {
	name: "judge_restatement",
	description: "Submit whether the proposed rule is already stated in the instruction files.",
	parameters: JudgeRestatementArgs,
};

export const RuleProposal = Type.Object({
	title: Type.String(),
	summary: Type.String(),
	detail: Type.Union([Type.String(), Type.Null()]),
	target_type: Type.String(),
	target_path: Type.Union([Type.String(), Type.Null()]),
});
export type RuleProposal = Static<typeof RuleProposal>;

/** The proposal's own words — what passage selection ranks against. */
export function proposalText(p: RuleProposal): string {
	return [p.title, p.summary, p.detail ?? ""].filter((s) => s.trim().length > 0).join("\n");
}

export function buildRestatementPrompt(p: RuleProposal, corpus: readonly CorpusExcerpt[]): string {
	const target = p.target_path ? `${p.target_type}: ${p.target_path}` : p.target_type;
	const lines = [
		"PROPOSAL",
		`Target: ${target}`,
		`Title: ${p.title}`,
		`Summary: ${p.summary}`,
	];
	if (p.detail && p.detail.trim().length > 0) lines.push(`Detail: ${p.detail}`);
	lines.push("", "INSTRUCTION FILES");
	for (const f of corpus) {
		lines.push("", `=== ${f.path}${f.excerpted ? " (relevant excerpts)" : ""} ===`, f.text);
	}
	return lines.join("\n");
}

/**
 * The judgement from a reply: the tool call if present, else a JSON object in
 * the text channel. Null when neither carries a well-formed verdict — the caller
 * fails loudly rather than guess, since a guessed "gap" and a guessed
 * "restated" are both findings a reader would act on.
 */
export function extractJudgement(structured: unknown, text: string): JudgeRestatementArgs | null {
	const candidates: unknown[] = [];
	if (structured && typeof structured === "object") candidates.push(structured);
	if (text && text.includes("{")) {
		try {
			candidates.push(extractJsonObject(text));
		} catch (err) {
			// The text channel carried no JSON object. A tool call may still have
			// answered, so this is not yet a failure; the caller throws if nothing did.
			if (!(err instanceof Error)) throw err;
		}
	}
	for (const c of candidates) {
		const obj = c as Record<string, unknown>;
		const normalised = {
			verdict: obj["verdict"],
			path: typeof obj["path"] === "string" ? obj["path"] : "",
			quote: typeof obj["quote"] === "string" ? obj["quote"] : "",
			rationale: typeof obj["rationale"] === "string" ? obj["rationale"] : "",
		};
		if (Check(JudgeRestatementArgs, normalised)) return normalised;
	}
	return null;
}

function squash(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Where the quote actually appears: the cited file if it contains it, else the
 * first corpus file that does. Null when the quote is in none of them — the
 * model's claim that the rule exists is then unsupported. Whitespace, markdown
 * emphasis and list markers are ignored so a quote without the `**` still
 * matches; case is not, because a copied quote keeps its capitalisation.
 */
export function locateQuote(quote: string, files: ReadonlyArray<{ path: string; content: string }>, citedPath: string): string | null {
	const strip = (s: string): string => squash(s.replace(/[*_`>]/g, "").replace(/(^|\n)\s*(?:[-+]|\d+\.)\s+/g, "$1"));
	const needle = strip(quote);
	if (needle.length < 12) return null;
	const cited = files.find((f) => f.path === citedPath);
	if (cited && strip(cited.content).includes(needle)) return cited.path;
	const other = files.find((f) => strip(f.content).includes(needle));
	return other ? other.path : null;
}
