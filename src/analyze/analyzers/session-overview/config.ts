/** Configuration for the session-overview analyzer. */

import { Type, type Static } from "typebox";

export const SessionOverviewConfig = Type.Object({
	/** Model tier for the map phase (segment summaries). */
	mapTier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** Model tier for the reduce phase (summary + proposals). */
	reduceTier: Type.Union([Type.Literal("cheap"), Type.Literal("mid"), Type.Literal("expensive")]),
	/** Sampling temperature. */
	temperature: Type.Number(),
	/** Digest size (chars) above which map-reduce kicks in. */
	mapReduceOverChars: Type.Number(),
	/** Target segment size (chars) for the map phase. */
	segmentChars: Type.Number(),
	/** Hard cap on segments processed per session. */
	maxSegments: Type.Number(),
});
export type SessionOverviewConfig = Static<typeof SessionOverviewConfig>;

export const DEFAULT_SESSION_OVERVIEW_CONFIG: SessionOverviewConfig = {
	mapTier: "cheap",
	reduceTier: "mid",
	temperature: 0,
	mapReduceOverChars: 12000,
	segmentChars: 6000,
	maxSegments: 12,
};
