/**
 * Model tiers. Analyzers request an abstract tier (cheap/mid/expensive); the
 * concrete `provider/model` string is resolved from the prospector config
 * (`~/.pi/agent/prospector.json` → `modelTiers`). This keeps analyzers free of
 * hard-coded model names and lets the user choose models per tier.
 */

import type { ModelTier, ModelTierConfig } from "./types.js";

/**
 * Default tier mapping. These are overridable via prospector config and are
 * intentionally pointed at widely-available Pi providers. The user picks the
 * real models; analyzers only ever ask for a tier.
 */
export const DEFAULT_MODEL_TIERS: ModelTierConfig = {
	cheap: "anthropic/claude-haiku-4-5",
	mid: "anthropic/claude-sonnet-4-5",
	expensive: "anthropic/claude-opus-4-1",
};

const TIER_NAMES = new Set<string>(["cheap", "mid", "expensive"]);

export function isModelTier(value: string): value is ModelTier {
	return TIER_NAMES.has(value);
}

/**
 * Resolve a model spec. A tier name maps through the config; an explicit
 * `provider/model` spec passes through unchanged.
 */
export function resolveModelSpec(spec: string, config?: ModelTierConfig): string {
	const tiers = config ?? DEFAULT_MODEL_TIERS;
	if (isModelTier(spec)) return tiers[spec];
	return spec;
}

/** Split a `provider/model` spec into its parts. The model id may itself contain slashes. */
export function splitModelSpec(spec: string): { provider: string; modelId: string } {
	const idx = spec.indexOf("/");
	if (idx < 0) {
		throw new Error(`Invalid model spec '${spec}'. Expected 'provider/model' or a tier name (cheap|mid|expensive).`);
	}
	return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

/**
 * Apply a one-off model override to a tier mapping. When `override` is set,
 * every tier (cheap/mid/expensive) is pinned to that single model, so an entire
 * analysis run uses exactly one model regardless of the tier each analyzer asks
 * for. The override may itself be a tier name (resolved through `tiers`) or a
 * concrete `provider/model` spec. When `override` is empty the tiers are
 * returned unchanged.
 *
 * Because the resolved model is part of node identity, pinning the model this
 * way produces its own nodes: re-running without the override marks them stale.
 */
export function applyModelOverride(tiers: ModelTierConfig, override?: string): ModelTierConfig {
	if (!override) return tiers;
	const model = resolveModelSpec(override, tiers);
	return { cheap: model, mid: model, expensive: model };
}
