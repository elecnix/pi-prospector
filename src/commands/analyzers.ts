/**
 * `/prospect-analyzers` — introspection for the custom-analyzer authoring loop.
 *
 *   analyzers list                 → built-ins + discovered custom analyzers (with load errors)
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
		await list(ctx);
		return;
	}

	out(ctx, `Unknown analyzers subcommand: "${sub}". Use: list | validate <path>`, "warning");
}

async function list(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	const paths = getAnalyzerPaths([], config);
	const builtinIds = BUILTIN_ANALYZERS.map((a) => a.def.id);
	const { loaded, errors } = await loadCustomAnalyzers({ paths, builtinIds });

	const lines: string[] = [];
	lines.push("Built-in analyzers:");
	for (const a of BUILTIN_ANALYZERS) {
		lines.push(`  ${a.def.id}  (v${a.version.major}.${a.version.minor}, ${a.version.implementationKind})`);
	}
	lines.push("");
	lines.push(`Custom analyzers (${loaded.length}) — scanned: ${paths.join(", ")}`);
	if (loaded.length === 0) lines.push("  (none)");
	for (const a of loaded) {
		lines.push(`  ${a.def.id}  (v${a.version.major}.${a.version.minor}, ${a.version.implementationKind})  ← ${a.sourcePath}`);
	}
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
			"Inspect locally-authored custom analyzers. Subcommands: list (built-ins + discovered custom analyzers and any load errors), validate <file|dir> (check one analyzer file/dir). Custom analyzers are loaded from ~/.pi/agent/prospector/analyzers, ./.prospector/analyzers, and config analyzerPaths.",
		handler: prospectAnalyzers,
	});
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}
