import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { FingerprintScope, NodeScalar, SessionFacts } from "../db/fingerprint-queries.js";
import { DISTRIBUTION_UNITS, ID_PATTERN, SECTION_KINDS, oneOf } from "./schema.js";

/**
 * A fingerprint contributor: one section of the corpus fingerprint, declared
 * the way an analyzer declares itself.
 *
 * A contributor says what it measures (`def`) and how to read the rows that
 * measure from (`read`). It does not apply the privacy guard and it does not
 * write schema: the builder applies the minimum group size to every measure,
 * and `fingerprintSchema` builds the strict schema from the declarations. So a
 * contributor cannot publish a value outside a number, a day, or a member of a
 * list it fixed in advance, and it cannot skip the guard.
 *
 * An analyzer exports its contributors next to `index.ts` and lists them in
 * `Analyzer.fingerprint`, the way it lists `outputs`. Contributors that read no
 * analyzer (the session index itself) live in `src/fingerprint/contributors/`.
 */

const Id = Type.String({ pattern: ID_PATTERN.source });
const Field = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9]*$" });
/**
 * Optional pointer to the figure's definition in the metric registry: `<analyzer-id>.<metric-name>`
 * in kebab case, or `sessions.<name>` for a count from the session index. It is
 * documentation only: nothing reads it at run time and it is never printed in a fingerprint.
 */
export const METRIC_ID_PATTERN = "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*$";
const MetricRef = Type.Optional(Type.String({ pattern: METRIC_ID_PATTERN }));

/** The sessions' values of one field, spread over fixed buckets. One row per session. */
export const DistributionMeasure = Type.Object({
	kind: Type.Literal("distribution"),
	id: Id,
	metric: MetricRef,
	/** A numeric field of the rows. */
	field: Field,
	unit: oneOf(DISTRIBUTION_UNITS),
	/** Ascending lower edges; the last bucket is open-ended. */
	edges: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
});

/** The sum of a numeric field, divided by `divisor` and rounded to `decimals`. Withheld when 1 to 4 sessions contribute. */
export const TotalMeasure = Type.Object({
	kind: Type.Literal("total"),
	id: Id,
	metric: MetricRef,
	field: Field,
	divisor: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	decimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
});

/** How many sessions have a numeric field above zero. Withheld when that is 1 to 4. */
export const SessionsMeasure = Type.Object({ kind: Type.Literal("sessions"), id: Id, metric: MetricRef, field: Field });

/** How many distinct values a string field takes (the days sessions started on, say). */
export const DistinctMeasure = Type.Object({ kind: Type.Literal("distinct"), id: Id, metric: MetricRef, field: Field });

/**
 * Rows counted under dimensions. Each dimension is a field of the rows and a
 * fixed list of the values it may take; any other value counts as `other`.
 * `countField` names a numeric field to sum; without it each row counts one.
 */
export const GroupsMeasure = Type.Object({
	kind: Type.Literal("groups"),
	id: Id,
	metric: MetricRef,
	dimensions: Type.Record(Field, Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9_:.-]*$" }), { minItems: 1 }), { minProperties: 1 }),
	countField: Type.Optional(Field),
});

export const MeasureSpec = Type.Union([DistributionMeasure, TotalMeasure, SessionsMeasure, DistinctMeasure, GroupsMeasure]);
export type MeasureSpec = Static<typeof MeasureSpec>;

/** What a contributor declares about itself. */
export const FingerprintContributorDef = Type.Object({
	/** The section id: unique within its kind, and the key under `objective` or `inferred`. */
	id: Id,
	label: Type.String(),
	description: Type.String(),
	/** `objective`: counted, timed, or found by a deterministic analyzer. `inferred`: a model judged it. */
	kind: oneOf(SECTION_KINDS),
	measures: Type.Array(MeasureSpec, { minItems: 1 }),
	/**
	 * The built-in analyzers whose nodes the section reads. The section then
	 * publishes their version mix (`versions`), so a reader comparing two
	 * fingerprints can tell a difference in the corpus from a difference in
	 * the analyzer that measured it.
	 */
	analyzers: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), { minItems: 1 })),
});
export type FingerprintContributorDef = Static<typeof FingerprintContributorDef>;

/**
 * Throw when a definition does not match its schema. TypeScript checks the
 * types of a built-in definition, not the limits its schema states (a
 * distribution needs at least one edge, an id has a fixed shape), so the
 * registry and the builder both call this.
 */
export function checkContributorDef(def: FingerprintContributorDef): void {
	const id = def.id;
	if (Check(FingerprintContributorDef, def)) return;
	const first = [...Errors(FingerprintContributorDef, def)][0];
	throw new Error(`fingerprint contributor '${id}' is not a valid definition${first ? `: ${first.instancePath || "/"} ${first.message}` : ""}`);
}

/**
 * One row of a contributor's input: `session` identifies the session the row
 * came from (it is counted and never printed), the other fields are numbers or
 * short strings that the measures read. A measure skips a row that lacks the
 * field it reads.
 */
export const FingerprintRow = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()]));
export type FingerprintRow = Static<typeof FingerprintRow>;

/** What `read` returns. */
export interface ContributorRead {
	/** The sessions the section covers, for the coverage figure and the minimum: not only those with a row. */
	measured: readonly string[];
	rows: readonly FingerprintRow[];
}

/**
 * What a contributor may read. It holds no database handle: the readers below
 * are the whole of its access, each bound to the filter and the as-of instant.
 */
export interface FingerprintReadContext {
	scope: FingerprintScope;
	/** Top-level sessions in scope, counted from the transcript. */
	sessions: readonly SessionFacts[];
	/**
	 * Sessions in scope with a successful run of the analyzer by the as-of
	 * instant. With `since` (`major.minor`), only the sessions whose latest such
	 * run is at that version or later: a contributor that reads a field an older
	 * version did not write cannot count those sessions as measured.
	 */
	runs(analyzerId: string, since?: string): Promise<string[]>;
	/**
	 * One row per current node of the analyzer: `session` plus each field read
	 * from the node content by JSON path (`$.a.b`). Rows come oldest node first,
	 * so a contributor that needs one node per session can keep the newest.
	 */
	nodes(analyzerId: string, fields: Readonly<Record<string, string>>): Promise<FingerprintRow[]>;
	/** One row per element of an array in the current nodes; `itemFields` read the element (`$.name`), `nodeFields` the node. */
	items(analyzerId: string, arrayPath: string, itemFields: Readonly<Record<string, string>>, nodeFields?: Readonly<Record<string, string>>): Promise<FingerprintRow[]>;
}

export interface FingerprintContributor {
	def: FingerprintContributorDef;
	read(ctx: FingerprintReadContext): Promise<ContributorRead>;
}

export type { NodeScalar };
