/**
 * Measure an analyzer's decision-model path against its generative path (#338,
 * step 4) on sessions the generative path has already classified.
 *
 * The database is opened read-only and nothing is written: each unit is rebuilt
 * with the analyzer's own `plan()` over the stored dependency nodes, matched to
 * the generative node that already covers it (same analyzer, same source set),
 * and sent to the decision model. The generative side's time and cost are the
 * ones recorded on its nodes, so only the decision model is paid for.
 *
 * Output is aggregate only: counts, agreement rates, seconds and dollars. No
 * session id, message text, or verdict content is printed.
 *
 * Usage:
 *   JEV_API_KEY=… npx tsx scripts/measure-decision-model.ts \
 *     --analyzer turn-pair-llm --model jev/jev-1.13.0 --sessions 20 [--concurrency 10]
 */

import Database from "better-sqlite3";
import { getDbPath, loadConfig } from "../src/config.js";
import { makeDecisionCaller } from "../src/analyze/decision-model.js";
import { mapWithConcurrency } from "../src/analyze/concurrency.js";
import { buildTurnPairs } from "../src/analyze/analyzers/turn-pair-core/build.js";
import { DEFAULT_MODEL_TIERS } from "../src/analyze/model-tiers.js";
import { createThrowingLLM } from "../src/analyze/mock-llm.js";
import { MEASURED_ANALYZERS, type MeasuredAnalyzer } from "./decision-model-fields.js";
import type { AnalysisNodeRow, AnalysisUnit, AnalyzerPlanContext, AnalyzerRunContext, LLMCaller, MessageRow } from "../src/analyze/types.js";
import type { AsyncDatabase } from "../src/db/async-db.js";

function arg(name: string, fallback?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const v = i >= 0 ? process.argv[i + 1] : undefined;
	if (v === undefined && fallback === undefined) throw new Error(`--${name} is required`);
	return v ?? fallback!;
}

const analyzerId = arg("analyzer");
const model = arg("model", "jev/jev-1.13.0");
const sessionLimit = Math.min(20, Number(arg("sessions", "20")));
const concurrency = Number(arg("concurrency", "10"));
const measured: MeasuredAnalyzer | undefined = MEASURED_ANALYZERS[analyzerId];
if (!measured) throw new Error(`No measurement for '${analyzerId}'. Known: ${Object.keys(MEASURED_ANALYZERS).join(", ")}`);

const config = loadConfig();
const db = new Database(getDbPath(config), { readonly: true, fileMustExist: true });
const analyzer = await measured.load();

/** Current-generation generative nodes, newest first, from sessions that have them. */
const sessions = (db
	.prepare(
		`SELECT n.session_id AS id, MAX(n.created_at) AS last FROM current_nodes n
		 WHERE n.analyzer_id = ? AND n.node_kind = 'classification' AND n.model_used IS NOT NULL AND n.model_used NOT LIKE 'jev%'
		 GROUP BY n.session_id ORDER BY last DESC LIMIT ?`,
	)
	.all(analyzerId, sessionLimit) as Array<{ id: string }>).map((r) => r.id);

const nodesOf = db.prepare("SELECT * FROM current_nodes WHERE session_id = ? AND analyzer_id = ?");
// Matched by source set alone, on purpose. A turn or reply unit's source set
// holds per-session ids (message ids, or output keys of nodes anchored to one
// session's messages), so two sessions never share one. A lexicon term's source
// set is the term itself, and its single corpus-wide verdict is the one to
// compare; `seen` keeps that term from being sent once per session.
const generativeBySource = db.prepare(
	`SELECT * FROM current_nodes WHERE analyzer_id = ? AND source_set_hash = ? AND node_kind = 'classification'
	 AND model_used IS NOT NULL AND model_used NOT LIKE 'jev%' ORDER BY created_at DESC LIMIT 1`,
);
const messagesOf = db.prepare(
	"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message FROM messages WHERE session_id = ? ORDER BY rowid ASC",
);

const overrides = config.analyzers?.[analyzerId] ?? {};
const configJson = { ...analyzer.defaultConfig.configJson, ...overrides };
const decide = makeDecisionCaller({ providers: config.decisionProviders });

type Pair = { unit: AnalysisUnit; generative: AnalysisNodeRow; sessionId: string };
const pairs: Pair[] = [];
const seen = new Set<string>();
for (const sessionId of sessions) {
	const messages = messagesOf.all(sessionId) as MessageRow[];
	const turnPairs = buildTurnPairs(messages);
	const dependencyNodes: Record<string, AnalysisNodeRow[]> = {};
	for (const dep of analyzer.def.dependencies) dependencyNodes[dep] = nodesOf.all(sessionId, dep) as AnalysisNodeRow[];
	const planCtx: AnalyzerPlanContext = {
		sessionId,
		messages,
		allNodes: Object.values(dependencyNodes).flat(),
		ownNodes: nodesOf.all(sessionId, analyzerId) as AnalysisNodeRow[],
		dependencyNodes,
		getGlobalDependencyNodes: async () => [],
		getTurnPairs: async () => turnPairs,
		config: configJson,
		db: undefined as unknown as AsyncDatabase,
	};
	for (const unit of await analyzer.plan(planCtx)) {
		if (seen.has(unit.sourceSetHash)) continue;
		const generative = generativeBySource.get(analyzerId, unit.sourceSetHash) as AnalysisNodeRow | undefined;
		if (!generative) continue;
		seen.add(unit.sourceSetHash);
		pairs.push({ unit, generative, sessionId });
	}
}

const runConfig = { id: "measure", analyzerId, configHash: "measure", configJson: { ...configJson, decisionModel: model }, label: "measure" };
const prompts: Record<string, string> = {};
for (const [name, p] of Object.entries(analyzer.prompts)) prompts[name] = p.content;

/** Quote extraction is counted, not paid for: the measurement compares the decision verdict. */
let quoteCalls = 0;
const countingLLM: LLMCaller = async (request) => {
	quoteCalls++;
	return { text: "", structured: {}, model: request.model, costUsd: 0, tokensUsed: 0, durationMs: 0, stopReason: "stop" };
};

const started = Date.now();
const results = await mapWithConcurrency(pairs, concurrency, async ({ unit, generative, sessionId }) => {
	const ctx: AnalyzerRunContext = {
		sessionId,
		getMessage: async () => undefined,
		getNode: async () => undefined,
		getDependencyNodes: async () => [],
		getGlobalDependencyNodes: async () => [],
		getSessionMessages: async () => [],
		getSubagentRuns: async () => [],
		getTurnPairs: async () => [],
		llm: measured.allowsLLM ? countingLLM : createThrowingLLM("the measurement only pays for the decision model"),
		decide,
		config: runConfig,
		prompts,
		modelTiers: config.modelTiers ?? DEFAULT_MODEL_TIERS,
	};
	try {
		const result = await analyzer.analyze(unit, ctx);
		return { ok: true as const, result, generative };
	} catch (err) {
		return { ok: false as const, error: err instanceof Error ? err.constructor.name : "unknown", generative };
	}
});
const wallMs = Date.now() - started;

const ok = results.filter((r) => r.ok);
const failures = results.length - ok.length;
const fields = measured.fields;
const agreement: Record<string, { agree: number; total: number; near?: number }> = {};
for (const f of fields) agreement[f.name] = { agree: 0, total: 0, ...(f.near ? { near: 0 } : {}) };
for (const r of ok) {
	const gen = JSON.parse(r.generative.content_json) as Record<string, unknown>;
	const dec = r.result.contentJson;
	for (const f of fields) {
		const a = agreement[f.name]!;
		a.total++;
		if (f.equal(gen, dec)) a.agree++;
		if (f.near && f.near(gen, dec)) a.near!++;
	}
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const genMs = results.map((r) => r.generative.duration_ms ?? 0);
const genCost = sum(results.map((r) => r.generative.cost_usd ?? 0));
const decMs = ok.map((r) => r.result.durationMs ?? 0);
const decCost = sum(ok.map((r) => r.result.costUsd ?? 0));

console.log(
	JSON.stringify(
		{
			analyzer: analyzerId,
			model,
			sessions: sessions.length,
			units: results.length,
			decision_failures: failures,
			...(measured.allowsLLM ? { generative_follow_up_calls: quoteCalls } : {}),
			generative: { cost_usd: +genCost.toFixed(4), call_seconds_sum: +(sum(genMs) / 1000).toFixed(1), call_seconds_median: +(median(genMs) / 1000).toFixed(2) },
			decision: {
				cost_usd: +decCost.toFixed(5),
				call_seconds_sum: +(sum(decMs) / 1000).toFixed(1),
				call_seconds_median: +(median(decMs) / 1000).toFixed(2),
				wall_seconds: +(wallMs / 1000).toFixed(1),
				concurrency,
			},
			agreement: Object.fromEntries(
				Object.entries(agreement).map(([k, a]) => [
					k,
					{ rate: a.total ? +(a.agree / a.total).toFixed(3) : null, n: a.total, ...(a.near !== undefined ? { within_one_level: +(a.near / a.total).toFixed(3) } : {}) },
				]),
			),
			// Rows: the generative label; columns: the decision label. Rare classes are
			// where agreement matters, and an overall rate hides them.
			confusion: measured.confusion?.(ok.map((r) => [JSON.parse(r.generative.content_json) as Record<string, unknown>, r.result.contentJson])),
			distributions: measured.distributions?.(ok.map((r) => [JSON.parse(r.generative.content_json) as Record<string, unknown>, r.result.contentJson])),
		},
		null,
		2,
	),
);
db.close();
