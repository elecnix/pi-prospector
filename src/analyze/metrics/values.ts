import type { MetricDefinition } from "./types.js";

/** The closed list of values a metric definition declares, so a fingerprint section and the definition cannot disagree. */
export function metricValues(metrics: readonly MetricDefinition[], id: string): string[] {
	const values = metrics.find((m) => m.id === id)?.values;
	if (values === undefined) throw new Error(`metric '${id}' declares no closed list of values`);
	return values.map((v) => v.value);
}
