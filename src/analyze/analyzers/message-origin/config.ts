/** Configuration for the message-origin analyzer. */

import { Type, type Static } from "typebox";

export const MessageOriginConfig = Type.Object({
	/**
	 * A decision model (`provider/model`, e.g. `jev/jev-1.13.0` or a local
	 * `nimble/nimble`) that settles the messages the heuristics leave undecided.
	 * Absent by default: those messages then keep the provisional label `typed` and
	 * `decided: false`, and a run costs nothing.
	 */
	decisionModel: Type.Optional(Type.String()),
	/**
	 * The lowest probability the decision model's answer to each question may have
	 * for the message to count as settled. Below it the node stays undecided and
	 * keeps the model's distribution, so a reader can see how close the call was.
	 */
	minConfidence: Type.Number(),
});
export type MessageOriginConfig = Static<typeof MessageOriginConfig>;

export const DEFAULT_MESSAGE_ORIGIN_CONFIG: MessageOriginConfig = {
	minConfidence: 0.6,
};
