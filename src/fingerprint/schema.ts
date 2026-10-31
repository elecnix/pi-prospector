import { Type, type Static, type TSchema } from "typebox";
import { HARNESS_SOURCES } from "../harness.js";
import type { FingerprintContributor, MeasureSpec } from "./contributor.js";

/**
 * The corpus fingerprint: numbers about a corpus of sessions that are safe to
 * share. Like the usage report (`src/telemetry/schema.ts`), every value is a
 * number, a date, or a member of a fixed list. There is no place in it for
 * conversation text, paths, titles, project names, session ids, or the ids of
 * custom analyzers, so a fingerprint cannot hold them even by mistake.
 *
 * The header is fixed. The sections are not: each is declared by a
 * **contributor** (see `contributor.ts`), and {@link fingerprintSchema} builds
 * the strict schema from the contributors' declarations. A contributor cannot
 * widen what a value may be. A measure is a distribution over fixed buckets, a
 * count, or a breakdown over lists the contributor fixed in advance, and
 * the schema built from them rejects anything else.
 *
 * Two kinds of section are kept apart: **objective** figures (counted or timed
 * from the transcript, or found by a deterministic analyzer) and **inferred**
 * ones (a language model judged them), because a reader weighs them differently.
 */

/**
 * Bumped when a field changes meaning or goes away. Adding a section does not
 * bump it. Version 2 replaced the hand-shaped sections of version 1 with the
 * generic section shape (`status`, `sessionsMeasured`, then the measures).
 */
export const FINGERPRINT_SCHEMA_VERSION = 2;

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

/** The units a distribution may state. A contributor needing another unit adds it here. */
export const DISTRIBUTION_UNITS = ["minutes", "prompts", "tool-calls"] as const;
export type DistributionUnit = (typeof DISTRIBUTION_UNITS)[number];

/** The two kinds of section. */
export const SECTION_KINDS = ["objective", "inferred"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** What a section id or a measure id looks like: a short camelCase name. */
export const ID_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

const Count = Type.Integer({ minimum: 0 });
const Day = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });

/** The union of a fixed list of strings, typed as that list. */
export function oneOf<T extends string>(values: readonly T[]) {
	return Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));
}

/** A figure, section, or measure that could not be published, and why. */
export const Withheld = Type.Object(
	{ status: Type.Literal("withheld"), reason: Type.Literal("below-min-group-size") },
	{ additionalProperties: false },
);
export type Withheld = Static<typeof Withheld>;

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
export const Distribution = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ok"),
			sessions: Count,
			unit: oneOf(DISTRIBUTION_UNITS),
			p50: Type.Number(),
			p90: Type.Number(),
			buckets: Type.Array(Bucket),
		},
		{ additionalProperties: false },
	),
	Withheld,
]);
export type Distribution = Static<typeof Distribution>;

/** The schema of one measure's value. */
export function measureSchema(measure: MeasureSpec): TSchema {
	switch (measure.kind) {
		case "distribution":
			return Distribution;
		case "total":
			return Type.Union([Type.Number(), Withheld]);
		case "sessions":
			return Type.Union([Count, Withheld]);
		case "distinct":
			return Count;
		case "groups": {
			const dimensions = Object.fromEntries(Object.entries(measure.dimensions).map(([name, values]) => [name, oneOf([...values, "other"])]));
			return Type.Array(Type.Object({ ...dimensions, count: Count, sessions: Count }, { additionalProperties: false }));
		}
	}
}

/** The schema of one section: the generic shape plus the contributor's measures, or withheld. */
export function sectionSchema(contributor: FingerprintContributor): TSchema {
	const measures = Object.fromEntries(contributor.def.measures.map((m) => [m.id, measureSchema(m)]));
	return Type.Union([
		Type.Object({ status: Type.Literal("ok"), sessionsMeasured: Count, ...measures }, { additionalProperties: false }),
		Withheld,
	]);
}

function header() {
	return {
		schemaVersion: Type.Literal(FINGERPRINT_SCHEMA_VERSION),
		kind: Type.Literal("corpus-fingerprint"),
		/** The UTC date the graph and the sessions are read as of. */
		asOf: Day,
		/** What the caller asked for. `null` means no restriction. */
		filter: Type.Object(
			{
				sources: Type.Union([Type.Array(oneOf(HARNESS_SOURCES)), Type.Null()]),
				from: Type.Union([Day, Type.Null()]),
				to: Type.Union([Day, Type.Null()]),
			},
			{ additionalProperties: false },
		),
		minGroupSize: Type.Literal(MIN_GROUP_SIZE),
		/** Top-level sessions in the filter. A sub-agent's own session is counted by the sections that read it. */
		sessions: Type.Object({ count: Count }, { additionalProperties: false }),
	};
}

/** The strict schema of a fingerprint built from these contributors. */
export function fingerprintSchema(contributors: readonly FingerprintContributor[]) {
	const sections = (kind: SectionKind) =>
		Type.Object(Object.fromEntries(contributors.filter((c) => c.def.kind === kind).map((c) => [c.def.id, sectionSchema(c)])), {
			additionalProperties: false,
		});
	return Type.Object(
		{ ...header(), objective: sections("objective"), inferred: sections("inferred") },
		{ additionalProperties: false },
	);
}

/**
 * A fingerprint as a renderer sees it: the fixed header, and sections keyed by
 * contributor id. {@link fingerprintSchema} has already checked the sections
 * against the contributors' declarations by the time a renderer gets one.
 */
export const Fingerprint = Type.Object(
	{
		...header(),
		objective: Type.Record(Type.String(), Type.Unknown()),
		inferred: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: false },
);
export type Fingerprint = Static<typeof Fingerprint>;
