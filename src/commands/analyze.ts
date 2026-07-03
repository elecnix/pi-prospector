import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getAllSessions, getUnanalyzedSessions, markAnalyzed } from "../db/queries.js";
import { getAnalyzerPaths, getDbPath, getModelTiers, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { registerAll } from "../analyze/defaults.js";
import { makePiLLMCaller } from "../analyze/pi-llm.js";
import { applyModelOverride } from "../analyze/model-tiers.js";
import { parseReviseArg, reachLabel } from "../analyze/version.js";
import {
	mapWithConcurrency,
	createSemaphore,
	DEFAULT_LLM_CONCURRENCY,
	DEFAULT_DETERMINISTIC_CONCURRENCY,
} from "../analyze/concurrency.js";
import type { ReviseReason, LLMCaller } from "../analyze/types.js";

interface AnalyzeArgs {
	revise: ReviseReason[];
	limit?: number;
	session?: string;
	analyzer?: string;
	model?: string;
	llmConcurrency?: number;
	analyzerConcurrency?: number;
	analyzerPaths: string[];
}

export async function prospectAnalyze(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = parseArgs(rawArgs ?? "");
	const reviseActive = args.revise.length > 0;
	const reach = reachLabel(args.revise);
	const config = loadConfig();
	// A --model override pins every tier to that one model for this run. The
	// same effective tiers feed both the LLM caller and the framework, so the
	// model actually used always matches the model folded into node identity.
	const modelTiers = applyModelOverride(getModelTiers(config), args.model);

	const db = new Database(getDbPath(config));
	migrate(db);

	try {
		// A plain fill focuses on not-yet-analysed sessions; any revise reason
		// re-scans every session so stale nodes can be picked up.
		const sessions = args.session
			? [{ id: args.session, file_path: "", started_at: "" }]
			: reviseActive
				? getAllSessions(db, args.limit)
				: getUnanalyzedSessions(db, args.limit);

		if (sessions.length === 0) {
			out(ctx, "No sessions to analyse. Run /prospect-sync first.", "info");
			return;
		}

		const baseLlm = makePiLLMCaller(ctx, { modelTiers });
		// Hard cap on concurrent LLM calls: a global semaphore wrapping the caller, so
		// the limit holds regardless of how sessions are dispatched above it.
		const llmConcurrency = args.llmConcurrency ?? DEFAULT_LLM_CONCURRENCY;
		const analyzerConcurrency = args.analyzerConcurrency ?? DEFAULT_DETERMINISTIC_CONCURRENCY;
		const llmGate = createSemaphore(llmConcurrency);
		const llm: LLMCaller = (request) => llmGate(() => baseLlm(request));
		const framework = new AnalyzerFramework({ db, llm, modelTiers });
		// Register built-ins plus any locally-authored custom analyzers discovered
		// on the analyzer paths (explicit --analyzer-path, config, project dir, Pi
		// agent dir). A malformed custom analyzer is skipped and reported, not fatal.
		const { customRegistered, errors: loadErrors } = await registerAll(framework, {
			paths: getAnalyzerPaths(args.analyzerPaths, config),
		});
		if (customRegistered.length > 0) {
			out(ctx, `Loaded ${customRegistered.length} custom analyzer(s): ${customRegistered.join(", ")}`, "info");
		}
		for (const e of loadErrors) out(ctx, `Skipped analyzer ${e.path}: ${e.message}`, "warning");
		const analyzerIds = args.analyzer ? [args.analyzer] : undefined;

		// Session fan-out: a run that touches an LLM analyzer is paced by the LLM
		// gate (so the fan-out matches the LLM budget); a deterministic-only run has
		// no provider to protect and uses the wider deterministic limit.
		const selected = framework.list().filter((a) => !analyzerIds || analyzerIds.includes(a.def.id));
		const runHasLLM = selected.some((a) => a.version.implementationKind !== "deterministic");
		const sessionConcurrency = runHasLLM ? llmConcurrency : analyzerConcurrency;

		out(
			ctx,
			`Analysing ${sessions.length} session(s) [${reach}] · ${sessionConcurrency}-way` +
				`${runHasLLM ? ` (≤${llmConcurrency} concurrent LLM calls)` : " (deterministic)"}…`,
			"info",
		);

		let nodesProduced = 0;
		let nodesRevised = 0;
		let proposals = 0;
		let cost = 0;
		const errors: string[] = [];

		await mapWithConcurrency(sessions, sessionConcurrency, async (session) => {
			try {
				const summary = await framework.run(session.id, { revise: args.revise, analyzerIds, modelSpec: args.model });
				nodesProduced += summary.nodesProduced;
				nodesRevised += summary.nodesRevised;
				proposals += summary.proposalsCreated;
				cost += summary.costUsd;
				errors.push(...summary.errors);
				// Bare-fill self-healing: only retire the session from the unanalysed
				// queue when it completed cleanly. If any unit failed, leave
				// `analyzed_at` NULL so the next plain fill re-scans it and recomputes
				// the still-missing units (the failures left no result behind).
				if (summary.errors.length === 0) {
					markAnalyzed(db, session.id);
				}
			} catch (err) {
				errors.push(`${session.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		const lines = [
			`Done [${reach}]. ${sessions.length} session(s) scanned.`,
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
}

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description:
			"Run analyzer framework over sessions (incremental). Flags: --revise major|minor|config|all (recompute stale nodes: major/minor analyzer bumps, config = your setup changed; default fills only missing work), --limit N, --session ID, --analyzer ID, --model provider/model (pin every tier to one model for this run; the model is part of node identity), --analyzer-path FILE|DIR (load a locally-authored custom analyzer; repeatable — the Pi agent dir ~/.pi/agent/prospector/analyzers and ./.prospector/analyzers are always scanned), --llm-concurrency N (max concurrent LLM calls, default 10), --analyzer-concurrency N (session fan-out for deterministic-only runs, default 20)",
		handler: prospectAnalyze,
	});
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function parseArgs(raw: string): AnalyzeArgs {
	const result: AnalyzeArgs = { revise: [], analyzerPaths: [] };
	const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--revise" && parts[i + 1]) {
			for (const r of parseReviseArg(parts[++i]!)) {
				if (!result.revise.includes(r)) result.revise.push(r);
			}
		} else if (p === "--limit" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!Number.isNaN(n)) result.limit = n;
		} else if (p === "--session" && parts[i + 1]) result.session = parts[++i];
		else if (p === "--analyzer" && parts[i + 1]) result.analyzer = parts[++i];
		else if (p === "--analyzer-path" && parts[i + 1]) result.analyzerPaths.push(parts[++i]!);
		else if (p === "--model" && parts[i + 1]) result.model = parts[++i];
		else if (p === "--llm-concurrency" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!Number.isNaN(n) && n >= 1) result.llmConcurrency = n;
		} else if (p === "--analyzer-concurrency" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!Number.isNaN(n) && n >= 1) result.analyzerConcurrency = n;
		}
	}
	return result;
}
