import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getAllSessions, getUnanalyzedSessions, markAnalyzed } from "../db/queries.js";
import { getDbPath, getModelTiers, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { registerDefaults } from "../analyze/defaults.js";
import { makePiLLMCaller } from "../analyze/pi-llm.js";
import { applyModelOverride } from "../analyze/model-tiers.js";
import type { RunMode } from "../analyze/types.js";

interface AnalyzeArgs {
	deep: boolean;
	limit?: number;
	session?: string;
	analyzer?: string;
	model?: string;
}

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description:
			"Run analyzer framework over sessions (incremental). Flags: --deep (re-analyse stale nodes into new versions), --limit N, --session ID, --analyzer ID, --model provider/model (pin every tier to one model for this run; the model is part of node identity)",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = parseArgs(rawArgs ?? "");
			const mode: RunMode = args.deep ? "deep" : "shallow";
			const config = loadConfig();
			// A --model override pins every tier to that one model for this run. The
			// same effective tiers feed both the LLM caller and the framework, so the
			// model actually used always matches the model folded into node identity.
			const modelTiers = applyModelOverride(getModelTiers(config), args.model);

			const db = new Database(getDbPath(config));
			migrate(db);

			try {
				// In shallow mode we focus on not-yet-analysed sessions; deep mode
				// re-scans every session so older-version nodes get fresh versions.
				const sessions = args.session
					? [{ id: args.session, file_path: "", started_at: "" }]
					: mode === "deep"
						? getAllSessions(db, args.limit)
						: getUnanalyzedSessions(db, args.limit);

				if (sessions.length === 0) {
					out(ctx, "No sessions to analyse. Run /prospect-sync first.", "info");
					return;
				}

				const llm = makePiLLMCaller(ctx, { modelTiers });
				const framework = new AnalyzerFramework({ db, llm, modelTiers });
				registerDefaults(framework);
				const analyzerIds = args.analyzer ? [args.analyzer] : undefined;

				out(ctx, `Analysing ${sessions.length} session(s) [${mode}]…`, "info");

				let nodesProduced = 0;
				let nodesRevised = 0;
				let proposals = 0;
				let cost = 0;
				const errors: string[] = [];

				for (const session of sessions) {
					try {
						const summary = await framework.run(session.id, { mode, analyzerIds, modelSpec: args.model });
						nodesProduced += summary.nodesProduced;
						nodesRevised += summary.nodesRevised;
						proposals += summary.proposalsCreated;
						cost += summary.costUsd;
						errors.push(...summary.errors);
						markAnalyzed(db, session.id);
					} catch (err) {
						errors.push(`${session.id}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}

				const lines = [
					`Done [${mode}]. ${sessions.length} session(s) scanned.`,
					`  Nodes produced: ${nodesProduced} (revised: ${nodesRevised})`,
					`  Proposals created: ${proposals}`,
					`  Estimated cost: $${cost.toFixed(4)}`,
				];
				if (errors.length > 0) {
					lines.push(`  Errors: ${errors.length}`);
					for (const e of errors.slice(0, 5)) lines.push(`    ${e}`);
				}
				out(ctx, lines.join("\n"), errors.length > 0 ? "warning" : "info");
			} finally {
				db.close();
			}
		},
	});
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function parseArgs(raw: string): AnalyzeArgs {
	const result: AnalyzeArgs = { deep: false };
	const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--deep" || p === "--reanalyze") result.deep = true;
		else if (p === "--limit" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!Number.isNaN(n)) result.limit = n;
		} else if (p === "--session" && parts[i + 1]) result.session = parts[++i];
		else if (p === "--analyzer" && parts[i + 1]) result.analyzer = parts[++i];
		else if (p === "--model" && parts[i + 1]) result.model = parts[++i];
	}
	return result;
}
