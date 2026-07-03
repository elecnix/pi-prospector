/**
 * Public authoring helper for locally-written custom analyzers.
 *
 * `defineAnalyzer` is optional: the loader normalises and validates any
 * default-exported analyzer object. Using it gives you eager validation at
 * author time (a thrown error the moment the module is imported) plus automatic
 * config/prompt hashing, so a hand-written analyzer needs no hashing boilerplate.
 *
 *   import { defineAnalyzer } from "pi-prospector";
 *   export default defineAnalyzer({ def, version, prompts, defaultConfig, plan, analyze });
 */

import type { Analyzer } from "./types.js";
import { validateAnalyzer } from "./loader.js";
import { computeConfigHash, shortHash } from "./input-hash.js";

export function defineAnalyzer(analyzer: Analyzer): Analyzer {
	if (!analyzer.prompts) analyzer.prompts = {};
	for (const [name, p] of Object.entries(analyzer.prompts)) {
		if (!p.hash) p.hash = shortHash(`prompt(${name}:${p.content})`);
	}
	if (analyzer.defaultConfig && !analyzer.defaultConfig.configHash) {
		analyzer.defaultConfig.configHash = computeConfigHash(analyzer.defaultConfig.configJson ?? {});
	}
	const error = validateAnalyzer(analyzer);
	if (error) throw new Error(`defineAnalyzer: ${error}`);
	return analyzer;
}
