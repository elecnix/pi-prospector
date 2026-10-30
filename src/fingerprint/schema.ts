import { Type, type Static, type TObject, type TSchema } from "typebox";
import { HARNESS_SOURCES } from "../harness.js";

/**
 * The corpus fingerprint: numbers about a corpus of sessions that are safe to
 * share. Like the usage report (`src/telemetry/schema.ts`), every value is a
 * number, a date, or a member of a fixed list below. There is no place in it
 * for conversation text, paths, titles, project names, session ids, or the
 * ids of custom analyzers, so a fingerprint cannot carry them even by mistake.
 *
 * Two things set it apart from the usage report. It describes what the sessions
 * contain, not how the tool was used. And it separates **objective** figures
 * (counted or timed from the transcript, or by a deterministic analyzer) from
 * **inferred** ones (a language model judged them), because a reader weighs
 * those differently.
 */

/** Bumped when a field changes meaning or goes away. Adding a field does not bump it. */
export const FINGERPRINT_SCHEMA_VERSION = 1;

/**
 * The smallest number of sessions any published figure may rest on. A bucket,
 * group, or section built from fewer sessions is merged into its neighbour,
 * folded into `other`, or withheld, so no figure describes a handful of
 * sessions. Five is the common floor for small-cell suppression: low enough
 * that a personal corpus of a few weeks still yields figures, high enough that
 * no figure is one or two sessions in disguise.
 */
export const MIN_GROUP_SIZE = 5;

/** Sources a fingerprint may name. A session whose source is none of them is `unknown`. */
export const SOURCE_GROUPS = [...HARNESS_SOURCES, "unknown"] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];

/** Categories of a frustration signal: the lexicon's closed set plus the wordless markers. */
export const FRUSTRATION_CATEGORIES = [
	"profanity",
	"insult",
	"negation",
	"correction",
	"repetition",
	"urgency",
	"confusion",
	"dissatisfaction",
	"praise",
	"paralinguistic",
	"other",
] as const;

/** Friction types the turn classifier may answer, plus `other` for anything else. */
export const FRICTION_TYPES = ["none", "wrong_approach", "missed_instruction", "tool_misuse", "repetition", "rebuttal", "other"] as const;

/** Sentiments the turn classifier may answer, plus `other` for anything else. */
export const SENTIMENTS = ["positive", "neutral", "frustrated", "other"] as const;

/** The bucket edges, in the unit of each distribution; the last bucket is open-ended. */
export const DURATION_EDGES_MINUTES = [0, 5, 15, 30, 60, 120, 240] as const;
export const PROMPT_EDGES = [0, 2, 4, 8, 16, 32] as const;
export const TOOL_CALL_EDGES = [0, 1, 10, 25, 50, 100, 250] as const;

const Count = Type.Integer({ minimum: 0 });

/** A figure that could not be published, and why. */
export const Withheld = Type.Object(
	{ status: Type.Literal("withheld"), reason: Type.Literal("below-min-group-size") },
	{ additionalProperties: false },
);
export type Withheld = Static<typeof Withheld>;

/** The union of a fixed list of strings, typed as that list. */
function oneOf<T extends string>(values: readonly T[]) {
	return Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));
}

/** `{ status: "ok" }` plus a section's fields, or the section withheld. */
function section<P extends Record<string, TSchema>>(fields: TObject<P>) {
	return Type.Union([Type.Object({ status: Type.Literal("ok"), ...fields.properties }, { additionalProperties: false }), Withheld]);
}

/** One bucket of a histogram: sessions whose value is `from` up to, but not including, `to`. */
export const Bucket = Type.Object(
	{ from: Count, to: Type.Union([Count, Type.Null()]), sessions: Count },
	{ additionalProperties: false },
);
export type Bucket = Static<typeof Bucket>;

/**
 * How one value is spread over sessions. Every bucket holds none or at least
 * {@link MIN_GROUP_SIZE} sessions: adjacent buckets are merged until that holds.
 */
export const Distribution = section(
	Type.Object({
		sessions: Count,
		unit: Type.Union([Type.Literal("minutes"), Type.Literal("prompts"), Type.Literal("tool-calls")]),
		p50: Type.Number(),
		p90: Type.Number(),
		buckets: Type.Array(Bucket),
	}),
);
export type Distribution = Static<typeof Distribution>;

/** One group of a breakdown: `sessions` is how many sessions it came from, `count` how many events. */
const Group = <K extends TSchema>(key: K) => Type.Object({ key, count: Count, sessions: Count }, { additionalProperties: false });

const SourceKey = oneOf([...SOURCE_GROUPS, "other"] as const);
const OtherOr = <T extends string>(values: readonly T[]) => oneOf([...values, "other"] as const);

export const FailureGroupOut = Type.Object(
	{
		axis: oneOf(["turn", "tool", "child", "other"] as const),
		/** An id from the failure-class catalogue, `unclassified`, or `other`. */
		classId: Type.String(),
		count: Count,
		sessions: Count,
	},
	{ additionalProperties: false },
);
export type FailureGroupOut = Static<typeof FailureGroupOut>;

export const Fingerprint = Type.Object(
	{
		schemaVersion: Type.Literal(FINGERPRINT_SCHEMA_VERSION),
		kind: Type.Literal("corpus-fingerprint"),
		/** The UTC date the graph and the sessions are read as of. */
		asOf: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
		/** What the caller asked for. `null` means no restriction. */
		filter: Type.Object(
			{
				sources: Type.Union([Type.Array(oneOf(HARNESS_SOURCES)), Type.Null()]),
				from: Type.Union([Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }), Type.Null()]),
				to: Type.Union([Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }), Type.Null()]),
			},
			{ additionalProperties: false },
		),
		minGroupSize: Type.Literal(MIN_GROUP_SIZE),
		sessions: Type.Object(
			{
				/** Top-level sessions in the filter. A sub-agent's own session is counted under `shape.subAgents`. */
				count: Count,
				/** Sessions per source; a source under the minimum is folded into `other`, or dropped when `other` is also under it. */
				bySource: Type.Array(Group(SourceKey)),
			},
			{ additionalProperties: false },
		),
		/** Counted or timed from the transcript, or by a deterministic analyzer. */
		objective: Type.Object(
			{
				usage: Type.Object(
					{
						/** Distinct UTC days on which a session started. */
						activeDays: Type.Union([Count, Withheld]),
						/** First message to last message of a session, wall clock. */
						duration: Distribution,
						/** The time-economy analyzer's active time: tool-call spans plus message gaps up to its idle cap. */
						activeTime: section(
							Type.Object({
								sessionsMeasured: Count,
								totalHours: Type.Number(),
								distribution: Distribution,
							}),
						),
					},
					{ additionalProperties: false },
				),
				shape: Type.Object(
					{
						promptsPerSession: Distribution,
						toolCallsPerSession: Distribution,
						/** Sessions that started a sub-agent, and the sub-agent sessions they started. */
						subAgents: Type.Union([
							Type.Object({ status: Type.Literal("ok"), sessionsWithSubAgents: Count, subAgentSessions: Count }, { additionalProperties: false }),
							Withheld,
						]),
					},
					{ additionalProperties: false },
				),
				/** From the failure-modes analyzer: deterministic, matched against a hand-written catalogue. */
				failures: section(
					Type.Object({
						sessionsMeasured: Count,
						turnFailures: Count,
						toolFailures: Count,
						byClass: Type.Array(FailureGroupOut),
					}),
				),
			},
			{ additionalProperties: false },
		),
		/** Judged by a language model. Read these as estimates. */
		inferred: Type.Object(
			{
				/** From turn-frustration: words a model judged to carry frustration, matched in text the person typed. */
				frustration: section(
					Type.Object({
						sessionsMeasured: Count,
						signals: Count,
						byCategory: Type.Array(Group(OtherOr(FRUSTRATION_CATEGORIES.filter((c) => c !== "other")))),
					}),
				),
				/** From turn-pair-llm, which classifies only the turns that looked high-signal, so these describe those turns. */
				turnClassification: section(
					Type.Object({
						sessionsMeasured: Count,
						turnsClassified: Count,
						frictionType: Type.Array(Group(OtherOr(FRICTION_TYPES.filter((c) => c !== "other")))),
						sentiment: Type.Array(Group(OtherOr(SENTIMENTS.filter((c) => c !== "other")))),
					}),
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export type Fingerprint = Static<typeof Fingerprint>;
