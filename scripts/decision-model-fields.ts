/**
 * Per-analyzer field comparisons for `measure-decision-model.ts`: which stored
 * fields the two paths both write, and when two values count as agreeing.
 */

import type { Analyzer, LLMCaller } from "../src/analyze/types.js";

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
	llmForQuotes?: () => LLMCaller;
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
	},
};
