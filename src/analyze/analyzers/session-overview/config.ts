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
	/**
	 * Enable cross-session success/failure contrast (issue #10): fold up to
	 * `maxContrastSiblings` smooth sibling sessions in the same repo/`cwd` into
	 * this session's source set and hand the reduce step a compact contrast digest.
	 * Deterministic and content-addressed (see cross-session.ts).
	 */
	crossSessionContrast: Type.Boolean(),
	/** Hard cap on smooth sibling sessions folded in as cross-session contrast. */
	maxContrastSiblings: Type.Number(),
	/** Minimum turn pairs a sibling must have to count as a substantial smooth example. */
	minSiblingPairs: Type.Number(),
});
export type SessionOverviewConfig = Static<typeof SessionOverviewConfig>;

/** The cross-session contrast knobs, as consumed by the selection helper. */
export interface CrossSessionContrastConfig {
	crossSessionContrast: boolean;
	maxContrastSiblings: number;
	minSiblingPairs: number;
}

export const DEFAULT_SESSION_OVERVIEW_CONFIG: SessionOverviewConfig = {
	mapTier: "cheap",
	reduceTier: "mid",
	temperature: 0,
	mapReduceOverChars: 12000,
	segmentChars: 6000,
	maxSegments: 12,
	crossSessionContrast: true,
	maxContrastSiblings: 3,
	minSiblingPairs: 2,
};
