/**
 * Configuration for the session-delivery analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const SessionDeliveryConfig = Type.Object({
	/** Tool names treated as shell execution, whose `command` argument is read. Compared case-insensitively. */
	shellToolNames: Type.Array(Type.String()),
	/**
	 * Regex sources, matched case-insensitively and per line against the result
	 * text of a call the host reported as a success. A match means the work did
	 * not happen: git exits 0 for some refusals, and a pipe hides the exit status
	 * of the rest. Only a result row that carries exactly one result is read,
	 * because the transcript joins several results' texts and cannot split them
	 * again.
	 */
	commitFailureMarkers: Type.Array(Type.String()),
	pushFailureMarkers: Type.Array(Type.String()),
	mergeFailureMarkers: Type.Array(Type.String()),
	/** Character cap on the result text read per call. */
	maxResultChars: Type.Integer({ minimum: 1 }),
});
export type SessionDeliveryConfig = Static<typeof SessionDeliveryConfig>;

export const DEFAULT_SESSION_DELIVERY_CONFIG: SessionDeliveryConfig = {
	shellToolNames: ["bash"],
	commitFailureMarkers: ["nothing to commit", "nothing added to commit", "no changes added to commit", "^fatal:", "^error:"],
	pushFailureMarkers: ["! \\[rejected\\]", "! \\[remote rejected\\]", "failed to push", "^fatal:"],
	mergeFailureMarkers: ["not mergeable", "merge conflict", "^fatal:", "^failed to"],
	maxResultChars: 20_000,
};
