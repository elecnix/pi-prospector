/**
 * Config for the model-mix analyzer.
 */

export interface ModelMixConfig {
	/** A model needs at least this many turns before any verdict is drawn. */
	minTurnCountPerModel: number;
	/** A model whose escalation share is at or above this is flagged for retries. */
	escalateRateThreshold: number;
}

export const DEFAULT_MODEL_MIX_CONFIG: ModelMixConfig = {
	/** ~a few dozen real turns is the smallest defensible sample. */
	minTurnCountPerModel: 20,
	escalateRateThreshold: 0.3,
};
