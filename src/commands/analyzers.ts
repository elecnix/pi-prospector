/**
 * `/prospect-analyzers` — introspection for the custom-analyzer authoring loop.
 *
 *   analyzers list                 → built-ins + discovered custom analyzers (with load errors)
 *   analyzers list --schema <id>   → the declared output schema of one analyzer, as JSON Schema
 *   analyzers validate <path>      → check one file/dir and print pass/fail per analyzer
 *
 * This is the tight feedback loop an agent uses to confirm its analyzer loaded
 * before running it: write the file → /reload → `analyzers list`. Because the
 * loader cache-busts on mtime, edits are picked up without a full session
 * restart.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { getAnalyzerPaths, loadConfig } from "../config.js";
import { loadCustomAnalyzers } from "../analyze/loader.js";
import { BUILTIN_ANALYZERS } from "../analyze/defaults.js";
import type { AnalyzerDef } from "../analyze/types.js";

export async function prospectAnalyzers(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = (rawArgs ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
	const sub = (parts[0] ?? "list").toLowerCase();

	if (sub === "validate") {
		const target = parts[1];
		if (!target) {
			out(ctx, "Usage: analyzers validate <file|dir>", "warning");
			return;
		}
		await validate(ctx, target);
		return;
	}

	if (sub === "list") {
		// `list --schema <id>` prints one analyzer's declared output schema.
		if (parts[1] === "--schema") {
			const id = parts[2];
			if (!id) {
				out(ctx, "Usage: analyzers list --schema <analyzer-id>", "warning");
				return;
			}
			await showSchema(ctx, id);
			return;
		}
		await list(ctx);
		return;
	}

	out(ctx, `Unknown analyzers subcommand: "${sub}". Use: list | list --schema <id> | validate <path>`, "warning");
}

/** One line per analyzer: id, version, kind, source path, and what it emits. */
export function formatAnalyzerLine(a: { def: AnalyzerDef; version: { major: number; minor: number; implementationKind: string }; sourcePath?: string }): string {
	const base = `${a.def.id}  (v${a.version.major}.${a.version.minor}, ${a.version.implementationKind})`;
	const emits = describeOutput(a.def);
	const path = a.sourcePath ? `  ← ${a.sourcePath}` : "";
	return `  ${base}${emits}${path}`;
}

/** The `emits:` fragment naming the declared output properties, or "" when undeclared. */
export function describeOutput(def: AnalyzerDef): string {
	if (!def.outputSchema) return "";
	const props = Object.keys((def.outputSchema as { properties?: Record<string, unknown> }).properties ?? {});
	if (props.length === 0) return "";
	return `  emits: ${props.join(", ")}`;
}

/** Find an analyzer's def by id among built-ins and discovered custom analyzers. */
export async function findAnalyzerDef(id: string): Promise<AnalyzerDef | undefined> {
	const builtin = BUILTIN_ANALYZERS.find((a) => a.def.id === id);
	if (builtin) return builtin.def;
	const config = loadConfig();
	const paths = getAnalyzerPaths([], config);
	const builtinIds = BUILTIN_ANALYZERS.map((a) => a.def.id);
	const { loaded } = await loadCustomAnalyzers({ paths, builtinIds });
	return loaded.find((a) => a.def.id === id)?.def;
}

async function showSchema(ctx: ExtensionCommandContext, id: string): Promise<void> {
	const def = await findAnalyzerDef(id);
	if (!def) {
		out(ctx, `No analyzer found with id '${id}' (searched built-ins and custom paths).`, "warning");
		return;
	}
	if (!def.outputSchema) {
		out(ctx, `Analyzer '${id}' declares no outputSchema.`, "warning");
		return;
	}
	out(ctx, JSON.stringify(def.outputSchema, null, 2), "info");
}

async function list(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	const paths = getAnalyzerPaths([], config);
	const builtinIds = BUILTIN_ANALYZERS.map((a) => a.def.id);
	const { loaded, errors } = await loadCustomAnalyzers({ paths, builtinIds });

	const lines: string[] = [];
	lines.push("Built-in analyzers:");
	for (const a of BUILTIN_ANALYZERS) lines.push(formatAnalyzerLine(a));
	lines.push("");
	lines.push(`Custom analyzers (${loaded.length}) — scanned: ${paths.join(", ")}`);
	if (loaded.length === 0) lines.push("  (none)");
	for (const a of loaded) lines.push(formatAnalyzerLine(a));
	if (errors.length > 0) {
		lines.push("");
		lines.push(`Load errors (${errors.length}):`);
		for (const e of errors) lines.push(`  ${e.path}: ${e.message}`);
	}
	out(ctx, lines.join("\n"), errors.length > 0 ? "warning" : "info");
}

async function validate(ctx: ExtensionCommandContext, target: string): Promise<void> {
	const builtinIds = BUILTIN_ANALYZERS.map((a) => a.def.id);
	const { loaded, errors } = await loadCustomAnalyzers({ paths: [target], builtinIds });
	const lines: string[] = [];
	for (const a of loaded) lines.push(`  OK    ${a.def.id}  ← ${a.sourcePath}`);
	for (const e of errors) lines.push(`  FAIL  ${e.path}: ${e.message}`);
	if (lines.length === 0) lines.push("  (no analyzer files found at that path)");
	out(ctx, `Validation of ${target}:\n${lines.join("\n")}`, errors.length > 0 ? "warning" : "info");
}

export function registerAnalyzersCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyzers", {
		description:
			"Inspect locally-authored custom analyzers. Subcommands: list (built-ins + discovered custom analyzers, each with its declared output properties, and any load errors), list --schema <analyzer-id> (print that analyzer's declared node-content schema as JSON), validate <file|dir> (check one analyzer file/dir, including its outputSchema declaration). Custom analyzers are loaded from ~/.pi/agent/prospector/analyzers, ./.prospector/analyzers, and config analyzerPaths.",
		handler: prospectAnalyzers,
	});
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}
