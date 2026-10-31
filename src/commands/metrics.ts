/**
 * `/prospect-metrics` — the reference of what each metric means.
 *
 *   prospect metrics                       every defined metric, as Markdown
 *   prospect metrics --analyzer <id>       one analyzer's metrics (`sessions` for the figures counted from the index)
 *   prospect metrics --format json         the same, as JSON
 *   prospect metrics --gaps                analyzers that have no definitions yet
 *
 * Reads the definitions each analyzer declares in its `metrics.ts`. It touches
 * no database and runs no analysis.
 */

import type { ExtensionCommandContext } from "../pi-stubs.js";
import { parseFlags } from "../timepoint.js";
import { BUILTIN_ANALYZERS } from "../analyze/defaults.js";
import { analyzersWithoutMetrics, definedOwners, listMetrics } from "../analyze/metrics/registry.js";
import { renderJson, renderMarkdown, type OwnerFacts } from "../analyze/metrics/render.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

export async function prospectMetrics(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const { flags } = parseFlags(rawArgs ?? "");
	const format = flags["format"] ?? "md";
	if (format !== "md" && format !== "json") {
		output(ctx, `Unknown --format '${format}'. Use md or json.`, "error");
		return;
	}

	if (flags["gaps"] !== undefined) {
		const gaps = analyzersWithoutMetrics(BUILTIN_ANALYZERS.map((a) => a.def.id));
		output(ctx, gaps.length === 0 ? "Every analyzer has metric definitions." : `Analyzers without metric definitions (${gaps.length}):\n${gaps.map((g) => `  ${g}`).join("\n")}`);
		return;
	}

	const owner = flags["analyzer"] || undefined;
	const metrics = listMetrics(owner);
	if (metrics.length === 0) {
		const known = definedOwners().join(", ");
		output(ctx, owner === undefined ? "No metric definitions registered." : `No metric definitions for '${owner}'. Owners with definitions: ${known}. Run --gaps to list the analyzers without any.`, "error");
		return;
	}

	const facts = new Map<string, OwnerFacts>();
	for (const a of BUILTIN_ANALYZERS) {
		facts.set(a.def.id, { version: `${a.version.major}.${a.version.minor}`, implementation: a.version.implementationKind });
	}
	output(ctx, format === "json" ? renderJson(metrics, facts) : renderMarkdown(metrics, facts));
}
