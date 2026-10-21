/**
 * Resolve every model a run will use before it analyzes anything, so a model
 * the registry cannot see stops the run at once instead of failing each
 * session at its LLM step.
 */

import type { ModelRegistry } from "../pi-stubs.js";
import { splitModelSpec } from "./model-tiers.js";
import { decisionModelOf } from "./decision-model.js";

/** Throw when any `provider/model` spec is absent from `registry`. */
export async function assertModelsResolve(registry: ModelRegistry, specs: Iterable<string>): Promise<void> {
	const missing: string[] = [];
	for (const spec of new Set(specs)) {
		// A decision model is reached through the decision client, not the Pi registry.
		if (decisionModelOf(spec) !== undefined) continue;
		const { provider, modelId } = splitModelSpec(spec);
		if (!(await registry.find(provider, modelId))) missing.push(spec);
	}
	if (missing.length === 0) return;
	throw new Error(
		`Model not found in Pi registry: ${missing.join(", ")}. Nothing was analysed. ` +
			`Check modelTiers in prospector.json. The standalone prospect command doesn't load Pi extensions, ` +
			`so a model that an extension provides is missing here: run it through Pi instead, ` +
			`as \`pi -e <path-to-pi-prospector>/src/index.ts --prospect "analyze …"\`.`,
	);
}
