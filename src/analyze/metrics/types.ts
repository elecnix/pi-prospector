/**
 * The shape of a metric definition.
 *
 * A metric is a number the system derives from the index. Each analyzer declares
 * the metrics it produces in a `metrics.ts` beside its code, so a definition
 * changes in the same pull request as the logic it describes. The registry in
 * `registry.ts` collects them, and `prospect metrics` renders them.
 */

import { Type, type Static } from "typebox";

/** How a value was decided (DESIGN.md, *Measurement and comparability*). */
export const MeasurementClass = Type.Union([
	Type.Literal("counted"),
	Type.Literal("rule-based"),
	Type.Literal("inferred"),
]);
export type MeasurementClass = Static<typeof MeasurementClass>;

/** One value of a closed list: a label, a category, a rule code. */
export const MetricValue = Type.Object({
	value: Type.String(),
	meaning: Type.String(),
});
export type MetricValue = Static<typeof MetricValue>;

/**
 * A version at which the metric's meaning or population changed. A trend that
 * crosses it compares two measurements, so the entry says what moved and which
 * run brings the older nodes up to date.
 */
export const SeriesBreak = Type.Object({
	/** The first analyzer version that behaves this way, as `major.minor`. */
	version: Type.String({ pattern: "^[0-9]+\\.[0-9]+$" }),
	effect: Type.String(),
	repair: Type.String(),
});
export type SeriesBreak = Static<typeof SeriesBreak>;

export const MetricDefinition = Type.Object({
	/** `<owner>.<name>` in kebab case. The owner is an analyzer id, or `sessions` for a figure counted from the index. */
	id: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*\\.[a-z0-9]+(-[a-z0-9]+)*$" }),
	name: Type.String(),
	/** One sentence, in the ubiquitous language of DESIGN.md. */
	definition: Type.String(),
	measurement: MeasurementClass,
	/** What the number counts, such as "failures per session". */
	unit: Type.String(),
	/** What a rate is a share of. Says "none" for a figure that is not a rate. */
	denominator: Type.String(),
	/** What the number cannot show, and what moves it with no change in the user's practice. */
	limitations: Type.Array(Type.String(), { minItems: 1 }),
	/** The closed list of values, when the metric has one. */
	values: Type.Optional(Type.Array(MetricValue, { minItems: 1 })),
	seriesBreaks: Type.Optional(Type.Array(SeriesBreak, { minItems: 1 })),
});
export type MetricDefinition = Static<typeof MetricDefinition>;

/** The pseudo-owner of figures counted straight from the index, with no analyzer. */
export const CORE_OWNER = "sessions";
