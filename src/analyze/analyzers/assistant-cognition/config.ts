/** Configuration for the assistant-cognition analyzer. */

import { Type, type Static } from "typebox";

export const AssistantCognitionConfig = Type.Object({
	/** Model tier used for the cognitive-state classification. */
	tier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** Sampling temperature. */
	temperature: Type.Number(),
	/**
	 * Minimum length (characters) of a turn's aggregated thinking text for the
	 * turn to be analysed at all. Turns whose assistant produced no (or only a
	 * token) thinking trace carry no cognitive signal worth a model call.
	 */
	minThinkingLength: Type.Number(),
	/**
	 * A decision model (`provider/model`, e.g. `jev/jev-1.13.0`) that grades
	 * confusion, indecision, and surprise in one request (#338). Only a turn it
	 * judges surprised makes a generative call, on `tier`, for the quote.
	 */
	decisionModel: Type.Optional(Type.String()),
});
export type AssistantCognitionConfig = Static<typeof AssistantCognitionConfig>;

export const DEFAULT_ASSISTANT_COGNITION_CONFIG: AssistantCognitionConfig = {
	tier: "cheap",
	temperature: 0,
	/** A shorter thinking trace is rarely more than boilerplate ("Okay, let me..."). */
	minThinkingLength: 80,
};
