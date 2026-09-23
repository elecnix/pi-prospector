/**
 * Configuration for the decode-collapse analyzer (issue #277).
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 *
 * There is deliberately no perplexity threshold here. The threshold is a
 * property of the corpus, read from held-out sessions on every run; a constant
 * tuned on one corpus sits in a different place on every other one.
 */

import { Type, type Static } from "typebox";

export const DecodeCollapseConfig = Type.Object({
	/** N-gram order of the reference language model. */
	order: Type.Integer({ minimum: 1, maximum: 6 }),
	/** Absolute discount subtracted from every seen n-gram count before interpolation. */
	discount: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
	/**
	 * Minimum tokens a document (one assistant message's reasoning, or its answer
	 * text) must carry to be scored or trained on. A short reply says nothing
	 * reliable about whether it is language.
	 */
	minDocumentTokens: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum tokens a line needs to contribute its own perplexity to the
	 * document's median. Shorter lines are skipped; a document with no qualifying
	 * line is scored as one line.
	 */
	minLineTokens: Type.Integer({ minimum: 1 }),
	/** Tokens kept from the start of each document. Collapse is corrupt from its first token. */
	maxTokensPerDocument: Type.Integer({ minimum: 1 }),
	/**
	 * Sessions in the reference corpus: the earliest sessions (by start time, then
	 * id) that carry at least one document. Once the corpus is larger than this,
	 * newer sessions no longer change the reference, so their arrival leaves every
	 * existing node current.
	 */
	maxReferenceSessions: Type.Integer({ minimum: 2 }),
	/** Training tokens taken from any one reference session, so one long session cannot dominate the model. */
	maxTrainingTokensPerSession: Type.Integer({ minimum: 1 }),
	/** Width of the shingle the cross-session filter indexes. */
	crossSessionShingle: Type.Integer({ minimum: 1 }),
	/**
	 * A reference document whose share of shingles seen in some *other* session
	 * falls below this is kept out of training and calibration. Collapsed output
	 * repeats nothing from any other session; ordinary technical language does.
	 */
	minCrossSessionShare: Type.Number({ minimum: 0, maximum: 1 }),
	/** Every Nth reference session (in hashed-id order) is held out for calibration instead of training. */
	holdoutEvery: Type.Integer({ minimum: 2 }),
	/** Training sessions the model needs before it is trusted to score anything. */
	minTrainingSessions: Type.Integer({ minimum: 1 }),
	/** Held-out documents the calibration needs before its maximum is trusted as a threshold. */
	minHeldOutDocuments: Type.Integer({ minimum: 1 }),
	/**
	 * The threshold is the held-out maximum times this. A maximum read from a
	 * finite sample undershoots the coherent tail, and the more so the smaller
	 * the held-out set, so the default leaves headroom. The margin is relative,
	 * so it scales with the corpus instead of fixing a perplexity: collapsed
	 * output sits orders of magnitude above coherent text, so headroom is cheap.
	 */
	thresholdMultiplier: Type.Number({ minimum: 1 }),
	/** Highest-scoring documents recorded per session, flagged or not — the tail a person confirms. */
	topDocuments: Type.Integer({ minimum: 0 }),
	/** Collapsed documents in a session before the node carries a proposal. */
	minCollapsesForProposal: Type.Integer({ minimum: 1 }),
});
export type DecodeCollapseConfig = Static<typeof DecodeCollapseConfig>;

export const DEFAULT_DECODE_COLLAPSE_CONFIG: DecodeCollapseConfig = {
	order: 3,
	discount: 0.75,
	minDocumentTokens: 20,
	minLineTokens: 4,
	maxTokensPerDocument: 2000,
	maxReferenceSessions: 100,
	maxTrainingTokensPerSession: 20000,
	crossSessionShingle: 4,
	minCrossSessionShare: 0.1,
	holdoutEvery: 5,
	minTrainingSessions: 10,
	minHeldOutDocuments: 20,
	thresholdMultiplier: 1.5,
	topDocuments: 5,
	minCollapsesForProposal: 1,
};
