import type { Fingerprint } from "./schema.js";

/**
 * Fingerprint renderers: the formats a fingerprint can be printed in, keyed by
 * id, the way an analyzer's outputs are keyed. A renderer is handed the
 * fingerprint after the builder has applied the minimum group size and checked
 * the schema, and returns text. It reads no database and sees nothing the
 * fingerprint does not hold, so a new format cannot widen what is shared.
 *
 * To add a format, add a renderer to {@link RENDERERS}.
 */
export interface FingerprintRenderer {
	/** The value of `--format`. */
	id: string;
	label: string;
	mediaType: string;
	render(fingerprint: Fingerprint): string;
}

/** The format used when none is asked for. */
export const DEFAULT_FORMAT = "json";

export const jsonRenderer: FingerprintRenderer = {
	id: "json",
	label: "JSON",
	mediaType: "application/json",
	render: (fingerprint) => JSON.stringify(fingerprint, null, 2) + "\n",
};

/** Every scalar in a value as `path`, `value`, with array positions as numbers in the path. */
function flatten(value: unknown, path: string, out: Array<[string, string]>): void {
	if (Array.isArray(value)) value.forEach((item, i) => flatten(item, path === "" ? String(i) : `${path}.${i}`, out));
	else if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value)) flatten(item, path === "" ? key : `${path}.${key}`, out);
	} else out.push([path, value === null || value === undefined ? "" : String(value)]);
}

function csvCell(text: string): string {
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One `metric,value` row per figure, with the metric as a dotted path, such as `objective.shape.promptsPerSession.p50`. */
export const csvRenderer: FingerprintRenderer = {
	id: "csv",
	label: "CSV (metric,value rows)",
	mediaType: "text/csv",
	render(fingerprint) {
		const rows: Array<[string, string]> = [];
		flatten(fingerprint, "", rows);
		return ["metric,value", ...rows.map(([metric, value]) => `${csvCell(metric)},${csvCell(value)}`)].join("\n") + "\n";
	},
};

export const RENDERERS: readonly FingerprintRenderer[] = [jsonRenderer, csvRenderer];

/** The renderer for a format id (the default when absent). Throws, naming the known ids, for an unknown one. */
export function resolveRenderer(id: string | undefined, renderers: readonly FingerprintRenderer[] = RENDERERS): FingerprintRenderer {
	const wanted = id ?? DEFAULT_FORMAT;
	const found = renderers.find((r) => r.id === wanted);
	if (!found) throw new Error(`unknown format '${wanted}' (use ${renderers.map((r) => r.id).join(", ")})`);
	return found;
}
