/** Configuration for the message-answers analyzer. */

import { Type, type Static } from "typebox";

export const MessageAnswersConfig = Type.Object({
	/**
	 * A decision model (`provider/model`, e.g. `jev/jev-1.13.0`) that answers the
	 * registered questions. Absent by default: the analyzer then plans nothing,
	 * writes nothing and makes no call, so an analyzer that reads the answers
	 * reports them as unknown.
	 */
	decisionModel: Type.Optional(Type.String()),
});
export type MessageAnswersConfig = Static<typeof MessageAnswersConfig>;

export const DEFAULT_MESSAGE_ANSWERS_CONFIG: MessageAnswersConfig = {};
