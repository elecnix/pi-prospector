/**
 * Bundled analyzer registry. `registerDefaults(framework)` wires up the built-in
 * analyzers in dependency order; `registerAll(framework, opts)` additionally
 * discovers and registers locally-authored custom analyzers from disk.
 */

import type { AnalyzerFramework } from "./framework.js";
import type { Analyzer } from "./types.js";
import { loadCustomAnalyzers, type LoadError } from "./loader.js";
import { turnPairCoreAnalyzer } from "./analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "./analyzers/turn-pair-llm/index.js";
import { sessionOverviewAnalyzer } from "./analyzers/session-overview/index.js";
import { toolTrajectoryAnalyzer } from "./analyzers/tool-trajectory/index.js";
import { contextEconomyAnalyzer } from "./analyzers/context-economy/index.js";

export const DEFAULT_ANALYZER_IDS = ["turn-pair-core", "turn-pair-llm", "tool-trajectory", "context-economy", "session-overview"] as const;

/** The built-in analyzers registered by a plain analyze run, in dependency order. */
export const BUILTIN_ANALYZERS: Analyzer[] = [
	turnPairCoreAnalyzer,
	turnPairLLMAnalyzer,
	toolTrajectoryAnalyzer,
	contextEconomyAnalyzer,
	sessionOverviewAnalyzer,
];

export function registerDefaults(framework: AnalyzerFramework): void {
	for (const a of BUILTIN_ANALYZERS) framework.register(a);
}

export interface RegisterAllOptions {
	/** Built-in analyzers to register first. Defaults to {@link BUILTIN_ANALYZERS}. */
	builtins?: Analyzer[];
	/** Paths (files/dirs) to discover custom analyzers from, in precedence order. */
	paths?: string[];
}

export interface RegisterAllResult {
	/** Ids of the custom analyzers that were successfully registered. */
	customRegistered: string[];
	/** Per-file load/validation failures; the run still proceeds without them. */
	errors: LoadError[];
}

/**
 * Register built-ins, then discover and register locally-authored custom
 * analyzers from `paths`. Built-ins are registered first so a custom analyzer's
 * id can be checked for collision against them. Loading never throws: a bad
 * analyzer is skipped and reported in `errors`.
 */
export async function registerAll(
	framework: AnalyzerFramework,
	opts: RegisterAllOptions = {},
): Promise<RegisterAllResult> {
	const builtins = opts.builtins ?? BUILTIN_ANALYZERS;
	for (const a of builtins) framework.register(a);

	const builtinIds = builtins.map((a) => a.def.id);
	const { loaded, errors } = await loadCustomAnalyzers({ paths: opts.paths ?? [], builtinIds });
	const customRegistered: string[] = [];
	for (const a of loaded) {
		framework.register(a);
		customRegistered.push(a.def.id);
	}
	return { customRegistered, errors };
}
