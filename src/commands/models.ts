/**
 * `prospect models` — the efficiency frontier over our own corpus, read from the
 * per-turn routing labels (#68 + #69).
 *
 * A cumulative cross-session aggregate cannot be a per-session append-only node
 * without churn and races (see model-mix/index.ts), so the frontier is re-derived
 * here, at read time, from the `routing-opportunity` nodes — the content-addressed
 * cache. This command is therefore always current: it never caches a counter that
 * could go stale.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { getDbPath } from "../config.js";
import type { AnalysisNodeRow } from "../analyze/types.js";
import { aggregateModels, DEFAULT_MODEL_MIX_CONFIG, type ModelMixConfig } from "../analyze/analyzers/model-mix/index.js";

function pct(x: number): string {
	return `${(x * 100).toFixed(0)}%`;
}

export async function prospectModels(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const rows = (await db
			.prepare("SELECT id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_key, output_key, config_fingerprint, model_used, cost_usd, tokens_used, duration_ms, created_at FROM analysis_nodes WHERE analyzer_id = 'routing-opportunity' ORDER BY created_at ASC")
			.all()) as AnalysisNodeRow[];

		const cfg: ModelMixConfig = DEFAULT_MODEL_MIX_CONFIG;
		const { result, suggestions } = aggregateModels(rows, cfg);

		const lines: string[] = [
			"╔══════════════════════════════════════════╗",
			"║      ⛏️  Prospector Model Mix             ║",
			"╚══════════════════════════════════════════╝",
			"",
			`  Routing labels:        ${result.corpus.routing_turn_count} turns`,
			`  Sessions:              ${result.corpus.session_count}`,
			`  Unrecorded-model turns:${result.corpus.unrecorded_model_turn_count}`,
			`  Priced turns:          ${result.corpus.priced_turn_count}  (unpriced: ${result.corpus.unpriced_turn_count})`,
			`  Min turns for verdict: ${result.min_turn_count_per_model}`,
			"",
			"  ── Per-model quality/cost ──",
			...result.per_model
				.sort((a, b) => (a.avg_cost_per_priced_turn ?? Infinity) - (b.avg_cost_per_priced_turn ?? Infinity))
				.map((m) => {
					const cost = m.avg_cost_per_priced_turn === null ? "unpriced" : `$${m.avg_cost_per_priced_turn.toFixed(5)}/turn`;
					return (
						`  ${m.model.padEnd(24)} turns ${String(m.turn_count).padStart(4)}  ` +
						`corr ${pct(m.correction_rate).padStart(4)}  friction ${pct(m.friction_rate).padStart(4)}  ` +
						`stuck ${pct(m.stuck_loop_rate).padStart(4)}  esc ${pct(m.escalation_rate).padStart(4)}  ${cost}`
					);
				}),
			...(result.per_model.length === 0 ? ["    (no routing labels yet — run analyze first)"] : []),
			"",
		];

		if (suggestions.length > 0) {
			lines.push("  ── Recommendations ──");
			for (const s of suggestions) {
				lines.push(`  • ${s.title}`);
				lines.push(`      ${s.summary}`);
				lines.push(`      ${s.evidence}`);
				lines.push("");
			}
		} else {
			lines.push("  No recommendations above the minimum-turn threshold. (A thin corpus is not a verdict.)");
		}

		const text = lines.join("\n");
		ctx.ui.notify(text, "info");
		console.log(text);
	} finally {
		await db.close();
	}
}

export function registerModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-models", {
		description: "Show the per-model quality/cost efficiency frontier over the analyzed routing corpus",
		handler: prospectModels,
	});
}
