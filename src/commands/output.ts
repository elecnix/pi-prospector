/**
 * `/prospect-output` — render an analyzer's outputs to files.
 *
 *   output list                          → every output the registered analyzers declare
 *   output <spec> [--out DIR] [--k v]    → render and write
 *
 * `<spec>` is `analyzer:output`, an analyzer id (all of its outputs), or a bare
 * output id when only one analyzer declares it.
 *
 * Rendering never writes to the graph, so this is safe to re-run at will. It
 * also never *fills* the graph: an output shows what analysis has already found,
 * so a stale or empty report means `analyze` has not run, and the command says
 * so rather than quietly rendering an empty page.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAsyncDatabase } from "../db/async-db.js";
import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { getAnalyzerPaths, getDbPath, loadConfig } from "../config.js";
import { migrate } from "../db/schema.js";
import { loadCustomAnalyzers } from "../analyze/loader.js";
import { BUILTIN_ANALYZERS } from "../analyze/defaults.js";
import { listOutputs, renderOutputs, resolveOutputs } from "../analyze/outputs.js";
import type { Analyzer } from "../analyze/types.js";

export interface OutputArgs {
	spec: string;
	outDir: string;
	asOf?: string;
	options: Record<string, string>;
}

/**
 * Parse the argument string.
 *
 * The first bare word is the spec; `--out` and `--as-of` are the command's own,
 * and every other `--key value` pair is passed through to the output untouched.
 * Pass-through is deliberate: an output declares its own knobs (`day=`,
 * `previews=`), and the command should not need editing when one adds another.
 */
export function parseOutputArgs(raw: string): OutputArgs {
	const parts = (raw ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
	const args: OutputArgs = { spec: "", outDir: "", options: {} };
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (p === "--out" && parts[i + 1]) args.outDir = parts[++i]!;
		else if (p === "--as-of" && parts[i + 1]) args.asOf = parts[++i]!;
		else if (p.startsWith("--")) {
			const key = p.slice(2);
			const eq = key.indexOf("=");
			if (eq >= 0) args.options[key.slice(0, eq)] = key.slice(eq + 1);
			else if (parts[i + 1] && !parts[i + 1]!.startsWith("--")) args.options[key] = parts[++i]!;
			else args.options[key] = "true";
		} else if (!args.spec) args.spec = p;
	}
	return args;
}

async function registeredAnalyzers(): Promise<Analyzer[]> {
	const config = loadConfig();
	const builtinIds = BUILTIN_ANALYZERS.map((a) => a.def.id);
	const { loaded } = await loadCustomAnalyzers({ paths: getAnalyzerPaths([], config), builtinIds });
	return [...BUILTIN_ANALYZERS, ...loaded];
}

export async function prospectOutput(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = parseOutputArgs(rawArgs ?? "");
	const analyzers = await registeredAnalyzers();

	if (args.spec === "" || args.spec === "list") {
		const all = listOutputs(analyzers);
		const lines = ["Available outputs:"];
		if (all.length === 0) lines.push("  (none — no registered analyzer declares an output)");
		for (const o of all) {
			lines.push(`  ${o.address}  — ${o.output.def.label}`);
			lines.push(`      ${o.output.def.description}`);
		}
		out(ctx, lines.join("\n"), "info");
		return;
	}

	const dbPath = getDbPath(loadConfig());
	if (!fs.existsSync(dbPath)) {
		out(ctx, `No index at ${dbPath}. Run sync first.`, "warning");
		return;
	}

	const db = openAsyncDatabase(dbPath);
	await migrate(db);
	try {
		const resolved = resolveOutputs(analyzers, args.spec);
		const results = await renderOutputs(resolved, {
			db,
			options: args.options,
			asOf: args.asOf,
		});

		const dir = args.outDir || path.join(os.homedir(), "Documents");
		fs.mkdirSync(dir, { recursive: true });

		const lines: string[] = [];
		let written = 0;
		for (const result of results) {
			if (result.artifacts.length === 0) {
				lines.push(`  ${result.address}: produced nothing`);
				continue;
			}
			for (const artifact of result.artifacts) {
				const target = path.join(dir, artifact.filename);
				fs.writeFileSync(target, artifact.content, "utf8");
				written++;
				lines.push(`  ${target}${artifact.summary ? `  — ${artifact.summary}` : ""}`);
			}
		}
		out(ctx, `Rendered ${written} file(s):\n${lines.join("\n")}`, written > 0 ? "info" : "warning");
	} catch (err) {
		out(ctx, `output: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		await db.close();
	}
}

export function registerOutputCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-output", {
		description:
			"Render an analyzer's outputs to files. `output list` shows what is available; `output <analyzer>:<output> [--out DIR] [--as-of TS] [--key value]` renders it. Unknown --key value pairs are passed to the output (e.g. --day 2026-08-14, --previews false). Reads the graph only — it never writes nodes and never runs analysis.",
		handler: prospectOutput,
	});
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}
