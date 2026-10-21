/**
 * Per-analyzer field comparisons for `measure-decision-model.ts`: which stored
 * fields the two paths both write, and when two values count as agreeing.
 */

import type { Analyzer } from "../src/analyze/types.js";

export interface MeasuredField {
	name: string;
	equal: (generative: Record<string, unknown>, decision: Record<string, unknown>) => boolean;
	/** For graded fields: within one level. */
	near?: (generative: Record<string, unknown>, decision: Record<string, unknown>) => boolean;
}

export interface MeasuredAnalyzer {
	load: () => Promise<Analyzer>;
	fields: MeasuredField[];
	/** Label counts per path, so a reader sees where disagreement comes from. */
	distributions?: (pairs: Array<[Record<string, unknown>, Record<string, unknown>]>) => Record<string, unknown>;
	/** Whether the decision path may call the generative model (quote extraction). */
	allowsLLM?: boolean;
	/** Generative label → decision label → count, per categorical field. */
	confusion?: (pairs: Array<[Record<string, unknown>, Record<string, unknown>]>) => Record<string, Record<string, Record<string, number>>>;
}

function matrix(pairs: Array<[Record<string, unknown>, Record<string, unknown>]>, names: string[]) {
	const out: Record<string, Record<string, Record<string, number>>> = {};
	for (const name of names) {
		const m: Record<string, Record<string, number>> = {};
		for (const [g, d] of pairs) {
			const row = (m[String(g[name])] ??= {});
			row[String(d[name])] = (row[String(d[name])] ?? 0) + 1;
		}
		out[name] = m;
	}
	return out;
}

/**
 * The grade the decision path reached for a signal, read from its stored
 * probabilities so the measurement does not depend on the quote step.
 */
function decidedSurprise(d: Record<string, unknown>): string {
	const p = d["probabilities"] as Record<string, Record<string, number>> | undefined;
	if (!p || (p["surprise"]?.["true"] ?? 0) <= 0.5) return "none";
	const sev = Object.entries(p["surprise_severity"] ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
	return !sev || sev === "none" ? "mild" : sev;
}

const same = (name: string): MeasuredField => ({ name, equal: (g, d) => g[name] === d[name] });

function graded(name: string, levels: readonly string[]): MeasuredField {
	const idx = (v: unknown) => levels.indexOf(String(v));
	return {
		name,
		equal: (g, d) => g[name] === d[name],
		near: (g, d) => Math.abs(idx(g[name]) - idx(d[name])) <= 1,
	};
}

function counts(pairs: Array<[Record<string, unknown>, Record<string, unknown>]>, name: string) {
	const gen: Record<string, number> = {};
	const dec: Record<string, number> = {};
	for (const [g, d] of pairs) {
		gen[String(g[name])] = (gen[String(g[name])] ?? 0) + 1;
		dec[String(d[name])] = (dec[String(d[name])] ?? 0) + 1;
	}
	return { generative: gen, decision: dec };
}

/** The grade of a cognition signal array: its highest entry, or "none". */
function topGrade(value: unknown, key: "level" | "severity"): string {
	const order = ["none", "mild", "moderate", "high"];
	let best = 0;
	for (const e of Array.isArray(value) ? value : []) best = Math.max(best, order.indexOf(String((e as Record<string, unknown>)[key])));
	return order[best] ?? "none";
}

function cognitionField(name: string, key: "level" | "severity"): MeasuredField {
	const order = ["none", "mild", "moderate", "high"];
	return {
		name,
		equal: (g, d) => topGrade(g[name], key) === topGrade(d[name], key),
		near: (g, d) => Math.abs(order.indexOf(topGrade(g[name], key)) - order.indexOf(topGrade(d[name], key))) <= 1,
	};
}

function present(name: string): MeasuredField {
	const has = (v: unknown) => Array.isArray(v) && v.length > 0;
	return { name: `${name}_present`, equal: (g, d) => has(g[name]) === has(d[name]) };
}

const ORDER = ["none", "mild", "moderate", "high"];
const surprisePresent: MeasuredField = {
	name: "surprise_present",
	equal: (g, d) => (topGrade(g["surprise"], "severity") !== "none") === (decidedSurprise(d) !== "none"),
};
const surpriseGrade: MeasuredField = {
	name: "surprise",
	equal: (g, d) => topGrade(g["surprise"], "severity") === decidedSurprise(d),
	near: (g, d) => Math.abs(ORDER.indexOf(topGrade(g["surprise"], "severity")) - ORDER.indexOf(decidedSurprise(d))) <= 1,
};

function gradeCounts(pairs: Array<[Record<string, unknown>, Record<string, unknown>]>, name: string, key: "level" | "severity") {
	return counts(pairs.map(([g, d]) => [{ [name]: topGrade(g[name], key) }, { [name]: topGrade(d[name], key) }]), name);
}

export const MEASURED_ANALYZERS: Record<string, MeasuredAnalyzer> = {
	"turn-pair-llm": {
		load: async () => (await import("../src/analyze/analyzers/turn-pair-llm/index.js")).turnPairLLMAnalyzer,
		fields: [same("sentiment"), same("friction_type"), same("is_genuine_correction"), graded("severity", ["low", "medium", "high"])],
		distributions: (pairs) => ({
			sentiment: counts(pairs, "sentiment"),
			friction_type: counts(pairs, "friction_type"),
			is_genuine_correction: counts(pairs, "is_genuine_correction"),
			severity: counts(pairs, "severity"),
		}),
		confusion: (pairs) => matrix(pairs, ["sentiment", "friction_type", "is_genuine_correction", "severity"]),
	},
	"frustration-lexicon": {
		load: async () => (await import("../src/analyze/analyzers/frustration-lexicon/index.js")).frustrationLexiconAnalyzer,
		fields: [
			same("polarity"),
			same("category"),
			same("language"),
			// What turn-frustration actually uses: a non-neutral verdict at or above minConfidence (0.5).
			{
				name: "usable_signal",
				equal: (g, d) => {
					const usable = (v: Record<string, unknown>) => v["polarity"] !== "neutral" && Number(v["confidence"]) >= 0.5 ? String(v["polarity"]) : "none";
					return usable(g) === usable(d);
				},
			},
		],
		distributions: (pairs) => ({ polarity: counts(pairs, "polarity"), category: counts(pairs, "category") }),
		confusion: (pairs) => matrix(pairs, ["polarity"]),
	},
	"user-reply-acts": {
		load: async () => (await import("../.prospector/analyzers/user-reply-acts.analyzer.js")).default,
		fields: [
			...["acceptances", "refusals", "questions", "answers", "commands", "information_provisions", "memories"].map(present),
			same("continuation"),
			same("other"),
			{
				name: "question_purpose",
				equal: (g, d) => {
					const purposes = (v: unknown) => new Set((Array.isArray(v) ? v : []).map((q) => String((q as Record<string, unknown>)["purpose"])));
					const a = purposes(g["questions"]);
					const b = purposes(d["questions"]);
					return a.size === 0 ? b.size === 0 : [...b].some((x) => a.has(x));
				},
			},
		],
		confusion: (pairs) =>
			matrix(
				pairs.map(([g, d]) => {
					const has = (v: Record<string, unknown>, k: string) => (Array.isArray(v[k]) && (v[k] as unknown[]).length > 0) || v[k] === true;
					const row = (v: Record<string, unknown>) =>
						Object.fromEntries(["acceptances", "refusals", "questions", "answers", "commands", "information_provisions", "memories", "other"].map((k) => [k, has(v, k)]));
					return [row(g), row(d)];
				}),
				["acceptances", "refusals", "questions", "answers", "commands", "information_provisions", "memories", "other"],
			),
	},
	"assistant-cognition": {
		load: async () => (await import("../src/analyze/analyzers/assistant-cognition/index.js")).assistantCognitionAnalyzer,
		fields: [
			present("confusion"),
			cognitionField("confusion", "level"),
			present("indecision"),
			cognitionField("indecision", "level"),
			surprisePresent,
			surpriseGrade,
		],
		distributions: (pairs) => ({
			confusion: gradeCounts(pairs, "confusion", "level"),
			indecision: gradeCounts(pairs, "indecision", "level"),
			surprise: counts(pairs.map(([g, d]) => [{ s: topGrade(g["surprise"], "severity") }, { s: decidedSurprise(d) }]), "s"),
		}),
		allowsLLM: true,
	},
};
