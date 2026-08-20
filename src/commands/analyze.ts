import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getAllSessions, getRecentSessions, getUnanalyzedSessions, markAnalyzed } from "../db/queries.js";
import { getAnalyzerConfigOverrides, getAnalyzerPaths, getDbPath, getLlmTimeoutMs, getModelTiers, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { registerAll } from "../analyze/defaults.js";
import { makePiLLMCaller } from "../analyze/pi-llm.js";
import { applyModelOverride } from "../analyze/model-tiers.js";
import { parseReviseArg, reachLabel } from "../analyze/version.js";
import { parseHarnessSource } from "../harness.js";
import { createAnalyzeRun, finalizeAnalyzeRun } from "../db/analysis-queries.js";
import { uuidv7 } from "../analyze/input-hash.js";
import {
	emptyAccounting,
	accountOne,
	runStatus,
	type SessionRunOutcome,
} from "../analyze/run-accounting.js";
import {
	mapWithConcurrency,
	createSemaphore,
	withTimeout,
	callWithRetry,
	classifyRetryable,
	DEFAULT_RETRY_POLICY,
	DEFAULT_LLM_CONCURRENCY,
	DEFAULT_DETERMINISTIC_CONCURRENCY,
	type RetryPolicy,
	type RetryStats,
} from "../analyze/concurrency.js";
import type { ReviseReason, LLMCaller } from "../analyze/types.js";

interface AnalyzeArgs {
	revise: ReviseReason[];
	/** Plain-fill every session, not just the not-yet-analysed ones. */
	all?: boolean;
	limit?: number;
	/** Get the N most-recent sessions (by started_at DESC). */
	recent?: number;
	session?: string;
	/** Restrict to sessions from one coding harness ("pi" | "claude"). */
	source?: string;
	analyzer?: string;
	model?: string;
	llmConcurrency?: number;
	analyzerConcurrency?: number;
	analyzerPaths: string[];
}

export async function prospectAnalyze(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = parseArgs(rawArgs ?? "");
	// A --source typo fails loudly (throws) rather than silently matching nothing.
	parseHarnessSource(args.source);
	const reviseActive = args.revise.length > 0;
	const reach = reachLabel(args.revise);
	const config = loadConfig();
	// A --model override pins every tier to that one model for this run. The
	// same effective tiers feed both the LLM caller and the framework, so the
	// model actually used always matches the model folded into node identity.
	const modelTiers = applyModelOverride(getModelTiers(config), args.model);

	const db = new Database(getDbPath(config));
	migrate(db);
	const startedAt = new Date().toISOString();

	try {
		// A plain fill focuses on not-yet-analysed sessions; any revise reason
		// re-scans every session so stale nodes can be picked up.
		//
		// `--all` is the back-fill path for the learned frustration lexicon. When a
		// session teaches the corpus a new frustration word, turns in *earlier*
		// sessions that contain that word have genuinely missing units — but those
		// sessions were retired from the unanalysed queue, so a plain fill never looks
		// at them again. `--all` re-scans everything while staying frugal: scanning is
		// cheap, and only the genuinely missing units are computed.
		const sessions = args.session
			? [{ id: args.session, file_path: "", started_at: "" }]
			: args.recent
				? getRecentSessions(db, args.recent, args.source)
			: reviseActive || args.all
				? getAllSessions(db, args.limit, args.source)
				: getUnanalyzedSessions(db, args.limit, args.source);

		if (sessions.length === 0) {
			out(ctx, "No sessions to analyse. Run /prospect-sync first.", "info");
			return;
		}

		const baseLlm = makePiLLMCaller(ctx, { modelTiers });
		// Hard cap on concurrent LLM calls: a global semaphore wrapping the caller, so
		// the limit holds regardless of how sessions are dispatched above it.
		const llmConcurrency = args.llmConcurrency ?? DEFAULT_LLM_CONCURRENCY;
		const analyzerConcurrency = args.analyzerConcurrency ?? DEFAULT_DETERMINISTIC_CONCURRENCY;
		const llmTimeoutMs = getLlmTimeoutMs(config);
		const llmGate = createSemaphore(llmConcurrency);
		// Retry 429/5xx throttles our own, inside the gate, so a backed-off call
		// holds its slot and the in-flight provider load *drops* while the shared
		// pool is throttled — adapting concurrency to what the provider can take
		// rather than blindly re-firing at the cap. Bounded (DEFAULT_RETRY_POLICY)
		// so a run degrades in duration instead of hanging; a call still failing
		// after the budget is terminal and frees its slot so the run continues.
		const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, isRetryable: classifyRetryable };
		const retryStats: RetryStats = { retries: 0 };
		const llm: LLMCaller = (request) =>
			llmGate(() =>
				callWithRetry(
					() =>
						withTimeout(
							baseLlm(request),
							llmTimeoutMs,
							() =>
								new Error(
									`LLM call to ${request.model ?? "mid"} exceeded ${llmTimeoutMs}ms and was ` +
									`aborted so the run can keep moving. The session is marked failed; re-run it ` +
									`once the provider recovers, or raise the timeout (PROSPECTOR_LLM_TIMEOUT_MS).`,
								),
						),
					retryPolicy,
					retryStats,
				),
			);
		// Let one session reach the LLM gate on its own. Without this, fan-out is
		// bounded by how many sessions happen to be issuing calls at the same moment,
		// and a single-session run can never exceed concurrency 1. The semaphore above
		// still caps what the provider actually sees.
		const framework = new AnalyzerFramework({
			db,
			llm,
			modelTiers,
			configOverrides: getAnalyzerConfigOverrides(config),
			unitConcurrency: llmConcurrency,
		});
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
		// Expand through dependencies before asking whether the run touches a model:
		// `--analyzer turn-frustration` is deterministic itself but pulls in
		// frustration-lexicon, which is not. Judging by the requested ids alone would
		// fan sessions out at the wide deterministic limit with no LLM gate in front
		// of a run that really does call a provider.
		const effectiveIds = new Set(framework.topologicalSort(analyzerIds));
		const selected = framework.list().filter((a) => effectiveIds.has(a.def.id));
		const runHasLLM = selected.some((a) => a.version.implementationKind !== "deterministic");
		const sessionConcurrency = runHasLLM ? llmConcurrency : analyzerConcurrency;

		out(
			ctx,
			`Analysing ${sessions.length} session(s) [${reach}] · ${sessionConcurrency}-way` +
				`${runHasLLM ? ` (≤${llmConcurrency} concurrent LLM calls)` : " (deterministic)"}…`,
			"info",
		);

		// A whole-run completion record so a partial overlay is legible: created as
		// 'running' before any session runs (so even an interrupted run leaves
		// evidence), then finalized with the real tallies when the invocation
		// returns. This is what makes "10 of 320 sessions, run continued" a visible,
		// queryable fact instead of something indistinguishable from "little to say".
		const runId = uuidv7();
		createAnalyzeRun(db, { id: runId, mode: reach, sessionAttempted: sessions.length });

		let accounting = emptyAccounting();
		let lastProgressAt = 0;

		await mapWithConcurrency(sessions, sessionConcurrency, async (session) => {
			let outcome: SessionRunOutcome;
			try {
				const summary = await framework.run(session.id, {
					revise: args.revise,
					analyzerIds,
					modelSpec: args.model,
				});
				outcome = {
					ok: summary.errors.length === 0,
					nodesProduced: summary.nodesProduced,
					nodesRevised: summary.nodesRevised,
					proposalsCreated: summary.proposalsCreated,
					costUsd: summary.costUsd,
					tokensUsed: summary.tokensUsed,
					errors: summary.errors,
				};
			} catch (err) {
				// A thrown run (as opposed to per-unit errors reported inside the summary)
				// is still one failed session; surface one example and keep going.
				outcome = {
					ok: false,
					nodesProduced: 0,
					nodesRevised: 0,
					proposalsCreated: 0,
					costUsd: 0,
					tokensUsed: 0,
					errors: [`${session.id}: ${err instanceof Error ? err.message : String(err)}`],
				};
			}
			accounting = accountOne(accounting, outcome);
			// Bare-fill self-healing: only retire the session from the unanalysed
			// queue when it completed cleanly. If any unit failed, leave `analyzed_at`
			// NULL so the next plain fill re-scans it and recomputes the still-missing
			// units (the failures left no result behind).
			if (outcome.ok) {
				markAnalyzed(db, session.id);
			}

			// Throttled progress so a slow run is distinguishable from a stuck one
			// (the per-call timeout guarantees the run itself terminates).
			const now = Date.now();
			if (now - lastProgressAt >= 30_000 && accounting.attempted < sessions.length) {
				lastProgressAt = now;
				out(
					ctx,
					`  ${accounting.attempted}/${sessions.length} session(s) analysed — ` +
						`${accounting.completed} completed, ${accounting.failed} failed` +
						(retryStats.retries > 0 ? `, ${retryStats.retries} retried` : "") +
						"…",
					"info",
				);
			}
		});

		// The terminal state of the whole run: persisted locally so it survives the
		// process, and surfaced to the operator with the failure examples.
		finalizeAnalyzeRun(db, runId, {
			status: runStatus(accounting),
			sessionCompleted: accounting.completed,
			sessionFailed: accounting.failed,
			retried: retryStats.retries,
			nodesProduced: accounting.nodesProduced,
			nodesRevised: accounting.nodesRevised,
			proposalsCreated: accounting.proposalsCreated,
			costUsd: accounting.costUsd,
			tokensUsed: accounting.tokensUsed,
			errorCount: accounting.errorCount,
			errorExamples: accounting.errorExamples,
		});

		const newTerms = countNewLexiconTerms(db, startedAt);
		const lines = [
			`Done [${reach}]. ${accounting.attempted} session(s) scanned — ` +
				`${accounting.completed} completed, ${accounting.failed} failed.`,
			`  Nodes produced: ${accounting.nodesProduced} (revised: ${accounting.nodesRevised})`,
			`  Proposals created: ${accounting.proposalsCreated}`,
			`  Estimated cost: $${accounting.costUsd.toFixed(4)}`,
		];
		if (retryStats.retries > 0) {
			lines.push(`  LLM throttling: ${retryStats.retries} call(s) retried after 429/5xx and absorbed.`);
		}
		if (newTerms > 0 && !args.all && !args.session) {
			lines.push(
				`  Frustration lexicon: learned ${newTerms} new term(s).`,
				`    Sessions analysed earlier may use them — run '/prospect-analyze --all' to back-fill.`,
			);
		}
		if (accounting.failed > 0) {
			lines.push(
				`  ⚠ Partial run: ${accounting.failed}/${accounting.attempted} session(s) had errors ` +
					`(${accounting.errorCount} total). A session listed as failed was NOT fully analysed; ` +
					`a plain re-run will pick it up.`,
			);
			for (const e of accounting.errorExamples.slice(0, 5)) lines.push(`    ${e}`);
		}
		out(ctx, lines.join("\n"), accounting.failed > 0 ? "warning" : "info");
	} finally {
		db.close();
	}
}

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description:
			"Run analyzer framework over sessions (incremental). Flags: --revise major|minor|config|all (recompute stale nodes: major/minor analyzer bumps, config = your setup changed; default fills only missing work), --all (plain-fill every session, not just unanalysed ones — use after the frustration lexicon learns new words), --limit N, --recent N (most-recent N sessions, for pilots), --session ID, --source pi|claude (restrict to sessions from one coding harness), --analyzer ID, --model provider/model (pin every tier to one model for this run; the model is part of node identity), --analyzer-path FILE|DIR (load a locally-authored custom analyzer; repeatable — the Pi agent dir ~/.pi/agent/prospector/analyzers and ./.prospector/analyzers are always scanned), --llm-concurrency N (max concurrent LLM calls, and the per-analyzer unit fan-out; default 10), --analyzer-concurrency N (session fan-out for deterministic-only runs, default 20)",
		handler: prospectAnalyze,
	});
}

/**
 * How many frustration-lexicon verdicts this run added. A non-zero count means
 * the corpus now knows words it did not know before, so sessions analysed
 * earlier may be carrying friction that is newly visible.
 */
function countNewLexiconTerms(db: Database.Database, since: string): number {
	const row = db
		.prepare(
			"SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = 'frustration-lexicon' AND node_kind = 'classification' AND created_at >= ?",
		)
		.get(since) as { n: number } | undefined;
	return row?.n ?? 0;
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
		} else if (p === "--recent" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!Number.isNaN(n) && n > 0) result.recent = n;
		} else if (p === "--all") result.all = true;
		else if (p === "--session" && parts[i + 1]) result.session = parts[++i];
		else if (p === "--source" && parts[i + 1]) result.source = parts[++i];
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
