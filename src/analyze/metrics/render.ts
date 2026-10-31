/**
 * Render metric definitions as Markdown or JSON.
 *
 * Pure functions over definitions plus, optionally, what the analyzer registry
 * knows about each owner (its current version and how it is implemented). The
 * version is read from the analyzer, never written into a definition, so a
 * version bump can't leave a stale number in the reference.
 */

import type { MetricDefinition } from "./types.js";

/** What the renderer shows about an owner, from the analyzer registry. */
export interface OwnerFacts {
	version: string;
	implementation: string;
}

export type OwnerFactsById = ReadonlyMap<string, OwnerFacts>;

function owner(metric: MetricDefinition): string {
	return metric.id.split(".")[0] ?? metric.id;
}

function ownerLine(id: string, facts: OwnerFactsById): string {
	const f = facts.get(id);
	return f === undefined ? "" : ` (version ${f.version}, ${f.implementation})`;
}

export function renderMarkdown(metrics: readonly MetricDefinition[], facts: OwnerFactsById): string {
	const lines: string[] = ["# pi-prospector metrics", ""];
	let current = "";
	for (const metric of metrics) {
		const ownerId = owner(metric);
		if (ownerId !== current) {
			current = ownerId;
			lines.push(`## ${ownerId}${ownerLine(ownerId, facts)}`, "");
		}
		lines.push(`### ${metric.name}`, "", `Id: \`${metric.id}\``, "");
		lines.push(`- **Definition**: ${metric.definition}`);
		lines.push(`- **Measured**: ${metric.measurement}`);
		lines.push(`- **Unit**: ${metric.unit}`);
		lines.push(`- **Denominator**: ${metric.denominator}`);
		if (metric.values !== undefined) {
			lines.push("- **Values**:");
			for (const v of metric.values) lines.push(`  - \`${v.value}\`: ${v.meaning}`);
		}
		lines.push("- **Limits**:");
		for (const l of metric.limitations) lines.push(`  - ${l}`);
		if (metric.seriesBreaks !== undefined) {
			lines.push("- **Series breaks**:");
			for (const b of metric.seriesBreaks) lines.push(`  - Version ${b.version}: ${b.effect} Repair: \`${b.repair}\`.`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

export function renderJson(metrics: readonly MetricDefinition[], facts: OwnerFactsById): string {
	const withFacts = metrics.map((m) => ({ ...m, owner: owner(m), ...(facts.get(owner(m)) ?? {}) }));
	return JSON.stringify(withFacts, null, 2);
}
